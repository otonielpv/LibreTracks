import { useCallback, useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  TouchEvent as ReactTouchEvent,
  WheelEvent as ReactWheelEvent,
} from "react";
import { useTranslation } from "react-i18next";

import { isMobileApp } from "@libretracks/shared/desktopApi";
import type { EqBand, EqBandKind, TrackEq, TrackSummary } from "@libretracks/shared/models";

import { useDismissOnBack } from "../mobile/backNavigation";
import type { TrackEqHandlers } from "../tracks/trackEqHandlers";
import { bandResponseDb, trackEqResponseDb } from "./eqResponse";
import {
  EQ_BAND_KINDS,
  EQ_MAX_FREQUENCY_HZ,
  EQ_MAX_GAIN_DB,
  EQ_MIN_FREQUENCY_HZ,
  clampFrequency,
  clampGain,
  clampQ,
  defaultTrackEq,
  hasGain,
  isCut,
  sanitizeTrackEq,
} from "./trackEqModel";
import "./TrackEqEditor.css";

/**
 * Editor del EQ de una pista, inspirado en EQ Eight (plan track-eq, D10/D11).
 *
 * - La curva sale de `eqResponse.ts`, el port del diseño del motor: es lo que
 *   suena.
 * - Arrastre de un nodo: horizontal = frecuencia, vertical = ganancia (en
 *   cortes y notch la vertical no hace nada: no tienen ganancia; su Q va con la
 *   rueda o el pellizco), rueda = Q, Shift = fino, doble clic = encender.
 * - Durante el gesto NO hay setState: el borrador vive en una ref y la curva y
 *   los nodos se repintan a mano en un requestAnimationFrame, que también
 *   manda como mucho un envío en vivo por frame. Al soltar, un solo commit.
 * - El pellizco para la Q solo existe con `isMobileApp`.
 */

export const EQ_VIEW_WIDTH = 600;
export const EQ_VIEW_HEIGHT = 220;
const CURVE_POINTS = 160;
const LOG_MIN = Math.log10(EQ_MIN_FREQUENCY_HZ);
const LOG_MAX = Math.log10(EQ_MAX_FREQUENCY_HZ);
const WHEEL_COMMIT_DELAY_MS = 350;
const FINE_FACTOR = 0.2;

export function freqToX(hz: number): number {
  return ((Math.log10(hz) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * EQ_VIEW_WIDTH;
}

export function xToFreq(x: number): number {
  return Math.pow(10, LOG_MIN + (x / EQ_VIEW_WIDTH) * (LOG_MAX - LOG_MIN));
}

export function gainToY(db: number): number {
  return EQ_VIEW_HEIGHT / 2 - (db / EQ_MAX_GAIN_DB) * (EQ_VIEW_HEIGHT / 2);
}

export function yToGain(y: number): number {
  return ((EQ_VIEW_HEIGHT / 2 - y) / (EQ_VIEW_HEIGHT / 2)) * EQ_MAX_GAIN_DB;
}

function curvePath(response: (hz: number) => number): string {
  let d = "";
  for (let i = 0; i <= CURVE_POINTS; i += 1) {
    const x = (i / CURVE_POINTS) * EQ_VIEW_WIDTH;
    const y = Math.min(EQ_VIEW_HEIGHT + 40, Math.max(-40, gainToY(response(xToFreq(x)))));
    d += `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return d;
}

function nodeY(band: EqBand): number {
  return hasGain(band.kind) ? gainToY(band.gainDb) : gainToY(0);
}

export function formatFrequency(hz: number): string {
  return hz >= 1000 ? `${Number((hz / 1000).toFixed(hz >= 10000 ? 1 : 2))} kHz` : `${Math.round(hz)} Hz`;
}

export function formatGain(db: number): string {
  const rounded = Math.round(db * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded} dB`;
}

const KIND_ICONS: Record<EqBandKind, string> = {
  lowCut: "M2 14 Q6 4 10 4 L22 4",
  lowShelf: "M2 12 L8 12 Q11 12 13 7 L22 7",
  peak: "M2 10 L8 10 Q12 1 16 10 L22 10",
  highShelf: "M2 7 L11 7 Q13 12 16 12 L22 12",
  highCut: "M2 4 L14 4 Q18 4 22 14",
  notch: "M2 5 L9 5 Q12 18 15 5 L22 5",
};

type Drag = {
  band: number;
  pointerId: number | undefined;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  scale: number;
  moved: boolean;
};

type Pinch = { band: number; startDistance: number; startQ: number };

type Props = {
  track: TrackSummary;
  handlers: TrackEqHandlers;
  /** Frecuencia de muestreo con la que se pinta la curva. */
  sampleRate?: number;
};

export function TrackEqEditor({ track, handlers, sampleRate = 48000 }: Props) {
  const { t } = useTranslation();
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const close = useCallback(() => handlersRef.current.close(), []);
  useDismissOnBack(close, true);

  const [eq, setEq] = useState<TrackEq>(() => sanitizeTrackEq(track.eq ?? defaultTrackEq()));
  const [activeBand, setActiveBand] = useState<number | null>(null);
  const draftRef = useRef<TrackEq>(eq);
  const dragRef = useRef<Drag | null>(null);
  const pinchRef = useRef<Pinch | null>(null);
  const frameRef = useRef<number | null>(null);
  const wheelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const totalPathRef = useRef<SVGPathElement | null>(null);
  const bandPathRef = useRef<SVGPathElement | null>(null);
  const nodeRefs = useRef<(SVGGElement | null)[]>([]);
  const activeBandRef = useRef<number | null>(null);
  activeBandRef.current = activeBand;

  // El modelo manda cuando no hay gesto en curso (otra vista, deshacer...).
  useEffect(() => {
    if (dragRef.current || pinchRef.current || wheelTimerRef.current) return;
    const next = sanitizeTrackEq(track.eq ?? defaultTrackEq());
    draftRef.current = next;
    setEq(next);
  }, [track.eq]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelFrame(frameRef.current);
      if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current);
    },
    [],
  );

  const totalResponse = (target: TrackEq) => (hz: number) =>
    trackEqResponseDb(target, sampleRate, hz);

  // ── Repintado imperativo durante el gesto (sin React) ────────────────────
  const paint = () => {
    const draft = draftRef.current;
    totalPathRef.current?.setAttribute("d", curvePath(totalResponse(draft)));
    const band = activeBandRef.current;
    if (band !== null && draft.bands[band]) {
      const target = draft.bands[band];
      bandPathRef.current?.setAttribute(
        "d",
        curvePath((hz) => bandResponseDb(target, sampleRate, hz)),
      );
    }
    draft.bands.forEach((b, index) => {
      nodeRefs.current[index]?.setAttribute(
        "transform",
        `translate(${freqToX(b.frequencyHz).toFixed(1)} ${nodeY(b).toFixed(1)})`,
      );
    });
  };

  const scheduleFrame = () => {
    if (frameRef.current !== null) return;
    frameRef.current = requestFrame(() => {
      frameRef.current = null;
      paint();
      handlersRef.current.applyLive(track.id, draftRef.current);
    });
  };

  const flushFrame = () => {
    if (frameRef.current !== null) {
      cancelFrame(frameRef.current);
      frameRef.current = null;
    }
  };

  const commit = (next: TrackEq) => {
    const clean = sanitizeTrackEq(next);
    draftRef.current = clean;
    setEq(clean);
    void handlersRef.current.commit(track.id, clean);
  };

  const patchBand = (index: number, patch: Partial<EqBand>) => {
    commit({
      ...eq,
      bands: eq.bands.map((band, i) => (i === index ? { ...band, ...patch } : band)),
    });
  };

  const setDraftBand = (index: number, patch: Partial<EqBand>) => {
    const draft = draftRef.current;
    draftRef.current = {
      ...draft,
      bands: draft.bands.map((band, i) => (i === index ? { ...band, ...patch } : band)),
    };
  };

  // ── Arrastre de nodos ────────────────────────────────────────────────────
  const onNodePointerDown = (index: number, event: ReactPointerEvent<SVGGElement>) => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = svgRef.current?.getBoundingClientRect();
    const scale = rect && rect.width > 0 ? EQ_VIEW_WIDTH / rect.width : 1;
    const band = eq.bands[index];
    draftRef.current = eq;
    dragRef.current = {
      band: index,
      pointerId: event.pointerId,
      startClientX: event.clientX ?? 0,
      startClientY: event.clientY ?? 0,
      startX: freqToX(band.frequencyHz),
      startY: nodeY(band),
      scale,
      moved: false,
    };
    try {
      (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    } catch {
      // jsdom y algunos WebView no lo tienen: el SVG recibe los eventos igual.
    }
    if (activeBand !== index) setActiveBand(index);
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const fine = event.shiftKey ? FINE_FACTOR : 1;
    const dx = ((event.clientX ?? drag.startClientX) - drag.startClientX) * drag.scale * fine;
    const dy = ((event.clientY ?? drag.startClientY) - drag.startClientY) * drag.scale * fine;
    const band = draftRef.current.bands[drag.band];
    const patch: Partial<EqBand> = {
      frequencyHz: clampFrequency(xToFreq(drag.startX + dx)),
    };
    if (hasGain(band.kind)) patch.gainDb = clampGain(yToGain(drag.startY + dy));
    setDraftBand(drag.band, patch);
    drag.moved = true;
    scheduleFrame();
  };

  const endDrag = () => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    flushFrame();
    if (drag.moved) {
      paint();
      commit(draftRef.current);
    }
  };

  // ── Rueda = Q (un commit al parar de girar) ──────────────────────────────
  const onWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    const index = activeBandRef.current;
    if (index === null) return;
    event.preventDefault();
    const band = draftRef.current.bands[index];
    const factor = Math.exp(-event.deltaY * (event.shiftKey ? 0.0005 : 0.002));
    setDraftBand(index, { q: clampQ(band.q * factor) });
    scheduleFrame();
    if (wheelTimerRef.current) clearTimeout(wheelTimerRef.current);
    wheelTimerRef.current = setTimeout(() => {
      wheelTimerRef.current = null;
      flushFrame();
      paint();
      commit(draftRef.current);
    }, WHEEL_COMMIT_DELAY_MS);
  };

  // ── Pellizco = Q (solo móvil) ────────────────────────────────────────────
  const touchDistance = (event: ReactTouchEvent) => {
    const a = event.touches[0];
    const b = event.touches[1];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  };

  const onTouchStart = (event: ReactTouchEvent<SVGSVGElement>) => {
    if (event.touches.length !== 2) return;
    const index = activeBandRef.current ?? 0;
    dragRef.current = null;
    pinchRef.current = {
      band: index,
      startDistance: Math.max(1, touchDistance(event)),
      startQ: draftRef.current.bands[index].q,
    };
  };

  const onTouchMove = (event: ReactTouchEvent<SVGSVGElement>) => {
    const pinch = pinchRef.current;
    if (!pinch || event.touches.length !== 2) return;
    const ratio = touchDistance(event) / pinch.startDistance;
    setDraftBand(pinch.band, { q: clampQ(pinch.startQ * ratio) });
    scheduleFrame();
  };

  const onTouchEnd = () => {
    if (!pinchRef.current) return;
    pinchRef.current = null;
    flushFrame();
    paint();
    commit(draftRef.current);
  };

  // ── Teclado sobre un nodo ────────────────────────────────────────────────
  const onNodeKeyDown = (index: number, event: ReactKeyboardEvent<SVGGElement>) => {
    const band = eq.bands[index];
    const semitone = Math.pow(2, 1 / 12);
    const step = event.shiftKey ? 0.1 : 0.5;
    if (event.key === "ArrowRight") patchBand(index, { frequencyHz: band.frequencyHz * semitone });
    else if (event.key === "ArrowLeft") patchBand(index, { frequencyHz: band.frequencyHz / semitone });
    else if (event.key === "ArrowUp" && hasGain(band.kind)) patchBand(index, { gainDb: band.gainDb + step });
    else if (event.key === "ArrowDown" && hasGain(band.kind)) patchBand(index, { gainDb: band.gainDb - step });
    else if (event.key === "Enter" || event.key === " ") patchBand(index, { enabled: !band.enabled });
    else return;
    event.preventDefault();
  };

  const bandLabel = (index: number) => t("eq.band", { number: index + 1 });
  const valueText = (band: EqBand, index: number) =>
    [
      bandLabel(index),
      t(`eq.kind.${band.kind}`),
      formatFrequency(band.frequencyHz),
      hasGain(band.kind) ? formatGain(band.gainDb) : null,
      band.enabled ? null : t("eq.off"),
    ]
      .filter(Boolean)
      .join(", ");

  const gridFrequencies = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
  const labelledFrequencies = new Set([100, 1000, 10000]);
  const gridGains = [-12, -6, 0, 6, 12];
  const active = activeBand !== null ? eq.bands[activeBand] : null;

  return (
    <div className="lt-modal-backdrop" onClick={close}>
      <section
        className={`lt-eq-editor ${isMobileApp ? "is-mobile" : ""} ${eq.enabled ? "" : "is-bypassed"}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-eq-editor-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-eq-header">
          <h2 id="lt-eq-editor-title">
            {t("eq.title")} <span className="lt-eq-track-name">{track.name}</span>
          </h2>
          <div className="lt-eq-header-actions">
            <button
              type="button"
              className="lt-eq-button"
              aria-pressed={!eq.enabled}
              onClick={() => {
                const next = { ...eq, enabled: !eq.enabled };
                draftRef.current = next;
                setEq(next);
                void handlersRef.current.toggleBypass(track.id);
              }}
            >
              {t("eq.bypass")}
            </button>
            <button
              type="button"
              className="lt-eq-button"
              onClick={() => {
                const next = defaultTrackEq();
                draftRef.current = next;
                setEq(next);
                void handlersRef.current.reset(track.id);
              }}
            >
              {t("eq.reset")}
            </button>
            <button
              type="button"
              className="lt-eq-button"
              onClick={() => {
                void handlersRef.current.remove(track.id);
                handlersRef.current.close();
              }}
            >
              {t("eq.remove")}
            </button>
            <button
              type="button"
              className="lt-eq-button lt-eq-close"
              aria-label={t("eq.close")}
              onClick={close}
            >
              <span className="material-symbols-outlined" aria-hidden="true">
                close
              </span>
            </button>
          </div>
        </header>

        <svg
          ref={svgRef}
          className="lt-eq-graph"
          viewBox={`0 0 ${EQ_VIEW_WIDTH} ${EQ_VIEW_HEIGHT}`}
          preserveAspectRatio="none"
          role="group"
          aria-label={t("eq.graph")}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onWheel={onWheel}
          {...(isMobileApp
            ? { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: onTouchEnd }
            : {})}
          data-testid="lt-eq-graph"
        >
          {gridFrequencies.map((hz) => (
            <g key={hz}>
              <line
                className="lt-eq-grid"
                x1={freqToX(hz)}
                x2={freqToX(hz)}
                y1={0}
                y2={EQ_VIEW_HEIGHT}
              />
              {labelledFrequencies.has(hz) ? (
                <text className="lt-eq-grid-label" x={freqToX(hz) + 3} y={EQ_VIEW_HEIGHT - 4}>
                  {hz >= 1000 ? `${hz / 1000}k` : hz}
                </text>
              ) : null}
            </g>
          ))}
          {gridGains.map((db) => (
            <g key={db}>
              <line
                className={`lt-eq-grid ${db === 0 ? "is-zero" : ""}`}
                x1={0}
                x2={EQ_VIEW_WIDTH}
                y1={gainToY(db)}
                y2={gainToY(db)}
              />
              {db !== 0 ? (
                <text className="lt-eq-grid-label" x={4} y={gainToY(db) - 3}>
                  {db > 0 ? `+${db}` : db}
                </text>
              ) : null}
            </g>
          ))}
          {active ? (
            <path
              ref={bandPathRef}
              className={`lt-eq-band-curve lt-eq-color-${(activeBand ?? 0) + 1}`}
              d={curvePath((hz) => bandResponseDb(active, sampleRate, hz))}
            />
          ) : null}
          <path
            ref={totalPathRef}
            className="lt-eq-curve"
            data-testid="lt-eq-curve"
            d={curvePath(totalResponse(eq))}
          />
          {eq.bands.map((band, index) => (
            <g
              key={index}
              ref={(element) => {
                nodeRefs.current[index] = element;
              }}
              className={`lt-eq-node lt-eq-color-${index + 1} ${band.enabled ? "" : "is-off"} ${
                activeBand === index ? "is-active" : ""
              }`}
              transform={`translate(${freqToX(band.frequencyHz).toFixed(1)} ${nodeY(band).toFixed(1)})`}
              role="slider"
              tabIndex={0}
              aria-label={bandLabel(index)}
              aria-valuetext={valueText(band, index)}
              aria-valuemin={EQ_MIN_FREQUENCY_HZ}
              aria-valuemax={EQ_MAX_FREQUENCY_HZ}
              aria-valuenow={Math.round(band.frequencyHz)}
              onPointerDown={(event) => onNodePointerDown(index, event)}
              onDoubleClick={() => patchBand(index, { enabled: !band.enabled })}
              onKeyDown={(event) => onNodeKeyDown(index, event)}
              onFocus={() => setActiveBand(index)}
              data-testid={`lt-eq-node-${index + 1}`}
            >
              <circle r={isMobileApp ? 14 : 9} />
              <text textAnchor="middle" dy="0.35em">
                {index + 1}
              </text>
            </g>
          ))}
        </svg>

        <div className="lt-eq-bands">
          {eq.bands.map((band, index) => (
            <BandStrip
              key={index}
              index={index}
              band={band}
              active={activeBand === index}
              onSelect={() => setActiveBand(index)}
              onPatch={(patch) => patchBand(index, patch)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function BandStrip({
  index,
  band,
  active,
  onSelect,
  onPatch,
}: {
  index: number;
  band: EqBand;
  active: boolean;
  onSelect: () => void;
  onPatch: (patch: Partial<EqBand>) => void;
}) {
  const { t } = useTranslation();
  return (
    <fieldset
      className={`lt-eq-band lt-eq-color-${index + 1} ${band.enabled ? "" : "is-off"} ${
        active ? "is-active" : ""
      }`}
      onFocus={onSelect}
      onClick={onSelect}
    >
      <legend className="lt-eq-band-head">
        <label className="lt-eq-band-toggle">
          <input
            type="checkbox"
            checked={band.enabled}
            aria-label={t("eq.enableBand", { number: index + 1 })}
            onChange={(event) => onPatch({ enabled: event.target.checked })}
          />
          <span className="lt-eq-band-number">{index + 1}</span>
        </label>
        <svg className="lt-eq-kind-icon" viewBox="0 0 24 18" aria-hidden="true">
          <path d={KIND_ICONS[band.kind]} />
        </svg>
        <select
          aria-label={t("eq.kindOf", { number: index + 1 })}
          value={band.kind}
          onChange={(event) => onPatch({ kind: event.target.value as EqBandKind })}
        >
          {EQ_BAND_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`eq.kind.${kind}`)}
            </option>
          ))}
        </select>
      </legend>
      <NumberField
        label={t("eq.frequencyOf", { number: index + 1 })}
        value={band.frequencyHz}
        decimals={band.frequencyHz >= 1000 ? 0 : 1}
        suffix="Hz"
        onCommit={(value) => onPatch({ frequencyHz: clampFrequency(value) })}
      />
      {hasGain(band.kind) ? (
        <NumberField
          label={t("eq.gainOf", { number: index + 1 })}
          value={band.gainDb}
          decimals={1}
          suffix="dB"
          onCommit={(value) => onPatch({ gainDb: clampGain(value) })}
        />
      ) : null}
      <NumberField
        label={t("eq.qOf", { number: index + 1 })}
        value={band.q}
        decimals={2}
        suffix="Q"
        onCommit={(value) => onPatch({ q: clampQ(value) })}
      />
      {isCut(band.kind) ? (
        <select
          aria-label={t("eq.slopeOf", { number: index + 1 })}
          value={band.slope}
          onChange={(event) => onPatch({ slope: Number(event.target.value) === 24 ? 24 : 12 })}
        >
          <option value={12}>12 dB/oct</option>
          <option value={24}>24 dB/oct</option>
        </select>
      ) : null}
    </fieldset>
  );
}

/** Campo numérico que confirma una vez por edición (Enter o al salir). */
function NumberField({
  label,
  value,
  decimals,
  suffix,
  onCommit,
}: {
  label: string;
  value: number;
  decimals: number;
  suffix: string;
  onCommit: (value: number) => void;
}) {
  const shown = Number(value.toFixed(decimals)).toString();
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commit = () => {
    if (draft === shown) return;
    const parsed = Number(draft.replace(",", "."));
    if (!Number.isFinite(parsed)) {
      setDraft(shown);
      return;
    }
    onCommit(parsed);
  };
  return (
    <label className="lt-eq-field">
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") setDraft(shown);
        }}
      />
      <span className="lt-eq-field-suffix">{suffix}</span>
    </label>
  );
}

function requestFrame(callback: () => void): number {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    return window.requestAnimationFrame(callback);
  }
  return setTimeout(callback, 16) as unknown as number;
}

function cancelFrame(handle: number) {
  if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(handle);
    return;
  }
  clearTimeout(handle);
}
