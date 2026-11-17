// Panel «Ritmo» (plan drum-loops, paso 06): superficie de directo con loops y
// one shots, en tres disposiciones (wide / medium / short) y tres
// contenedores (docked / sheet / tab). Las vistas lo montan; las acciones
// salen de `createRhythmHandlers` (D14).
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { AppSettings, DrumKit, LoopPattern, RegionLoop } from "@libretracks/shared/models";

import {
  getRhythmLibrary,
  isMobileApp,
  saveOneShotSet,
  listenToRhythmMeters,
  loopSetAllRows,
  loopSetRow,
  loopToggle,
  setLoopPlaying,
  loopToggleRow,
  oneShotDown,
  oneShotsStopAll,
  oneShotUp,
  setActivePattern,
  setLoopConfig,
  setOneShotBank,
  setOneShotConfig,
} from "../desktopApi";
import { LoopRows } from "./LoopRows";
import { MissingPacksNotice } from "./MissingPacksNotice";
import { OneShotGrid } from "./OneShotGrid";
import { swapPads } from "./oneShotOps";
import { createRhythmHandlers, type RhythmHandlers } from "./rhythmHandlers";
import { RhythmHeader } from "./RhythmHeader";
import { useRhythmStore } from "./rhythmStore";
import { useRhythmLayout, type RhythmLayoutClass } from "./useRhythmLayout";
import "./rhythm.css";

export type RhythmPanelVariant = "docked" | "sheet" | "tab";
export type RhythmPanelSurfaces = "both" | "loops" | "oneShots";
export type RhythmEditTarget = { kind: "pattern" } | { kind: "pad"; pad: number };

export type RhythmPanelProps = {
  variant: RhythmPanelVariant;
  settings: AppSettings;
  onSettings: (settings: AppSettings) => void;
  /** Fuerza la clase de tamaño (tests y arnés de capturas). */
  layoutClass?: RhythmLayoutClass;
  /** Objetivos táctiles de 44 px; por defecto `isMobileApp`. */
  touch?: boolean;
  /** Qué superficies enseña (las pestañas del Setlist las separan). */
  surfaces?: RhythmPanelSurfaces;
  /** Loop propio de la canción bajo el playhead, si lo tiene. */
  songLoop?: RegionLoop | null;
  onEdit?: (target: RhythmEditTarget) => void;
  onClose?: () => void;
  /** Handlers ya creados por la vista (para compartirlos con teclado/MIDI). */
  handlers?: RhythmHandlers;
};

function kitFor(pattern: LoopPattern, kits: DrumKit[]): DrumKit | null {
  const ref = pattern.kit;
  if (ref.kind === "embedded") return ref.kit;
  return kits.find((k) => k.id === ref.kitId) ?? null;
}

export function useRhythmHandlers(settings: AppSettings, onSettings: (s: AppSettings) => void): RhythmHandlers {
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const onSettingsRef = useRef(onSettings);
  onSettingsRef.current = onSettings;
  return useMemo(
    () =>
      createRhythmHandlers({
        api: {
          loopToggle,
          setLoopPlaying,
          loopToggleRow,
          loopSetRow,
          loopSetAllRows,
          oneShotDown,
          oneShotUp,
          oneShotsStopAll,
          setActivePattern,
          setOneShotBank,
          setLoopConfig,
          setOneShotConfig,
        },
        getSettings: () => settingsRef.current,
        applySettings: (next) => onSettingsRef.current(next),
        onError: (error) => console.warn("[rhythm]", error),
      }),
    [],
  );
}

/** Carga la biblioteca y escucha `audio:rhythm` mientras el panel vive. */
function useRhythmFeed() {
  const setLibrary = useRhythmStore((s) => s.setLibrary);
  const applyMeters = useRhythmStore((s) => s.applyMeters);
  useEffect(() => {
    let alive = true;
    void getRhythmLibrary()
      .then((library) => {
        if (alive) setLibrary(library);
      })
      .catch(() => {});
    let unlisten: (() => void) | null = null;
    void listenToRhythmMeters(applyMeters).then((stop) => {
      if (alive) unlisten = stop;
      else stop();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [setLibrary, applyMeters]);
}

export function RhythmPanel({
  variant,
  settings,
  onSettings,
  layoutClass,
  touch = isMobileApp,
  surfaces = "both",
  songLoop,
  onEdit,
  onClose,
  handlers: providedHandlers,
}: RhythmPanelProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const layout = useRhythmLayout(rootRef, layoutClass);
  const ownHandlers = useRhythmHandlers(settings, onSettings);
  const handlers = providedHandlers ?? ownHandlers;
  useRhythmFeed();

  const library = useRhythmStore((s) => s.library);
  const loopPlaying = useRhythmStore((s) => s.loopPlaying);
  const loopRows = useRhythmStore((s) => s.loopRows);
  const oneShotsActive = useRhythmStore((s) => s.oneShotsActive);
  const surface = useRhythmStore((s) => s.surface);
  const setSurface = useRhythmStore((s) => s.setSurface);
  const padEditMode = useRhythmStore((s) => s.padEditMode);
  const setPadEditMode = useRhythmStore((s) => s.setPadEditMode);
  const setLibrary = useRhythmStore((s) => s.setLibrary);

  const patterns = library?.patterns ?? [];
  const kits = library?.kits ?? [];
  const pattern = songLoop?.pattern ?? patterns.find((p) => p.id === settings.activeLoopPatternId) ?? null;
  const kit = pattern ? kitFor(pattern, kits) : null;
  const banks = library?.oneShots.banks ?? [];
  const bankIndex = Math.min(settings.activeOneShotBank, Math.max(0, banks.length - 1));
  const freeBpm = settings.loopFreeBpm > 0 ? settings.loopFreeBpm : pattern?.bpm ?? null;

  const showLoops = surfaces !== "oneShots" && (layout !== "short" || surfaces === "loops" || surface === "loops");
  const showShots = surfaces !== "loops" && (layout !== "short" || surfaces === "oneShots" || surface === "oneShots");
  const twoColumns = showLoops && showShots;

  const loopsZone = (
    <section className="lt-rhythm-zone lt-rhythm-zone--loops" aria-label={t("rhythm.loops")}>
      <MissingPacksNotice songLoop={songLoop} />
      {pattern && kit ? (
        <LoopRows pattern={pattern} kit={kit} rows={loopRows} layout={layout} handlers={handlers} />
      ) : (
        <div className="lt-rhythm-empty" data-testid="rhythm-empty">
          <p>{t("rhythm.noPattern")}</p>
        </div>
      )}
    </section>
  );

  const shotsZone = (
    <section className="lt-rhythm-zone lt-rhythm-zone--shots" aria-label={t("rhythm.oneShots")}>
      <OneShotGrid
        bank={banks[bankIndex] ?? null}
        bankIndex={bankIndex}
        bankCount={Math.max(1, banks.length)}
        activeMask={oneShotsActive}
        editMode={padEditMode}
        handlers={handlers}
        onEditPad={(pad) => onEdit?.({ kind: "pad", pad })}
        onToggleEdit={onEdit ? () => setPadEditMode(!padEditMode) : undefined}
        onSwap={(from, to) => {
          if (!library) return;
          void saveOneShotSet(swapPads(library.oneShots, bankIndex, from, to))
            .then(setLibrary)
            .catch(() => {});
        }}
      />
    </section>
  );

  return (
    <div
      ref={rootRef}
      className={[
        "lt-rhythm-panel",
        `lt-rhythm-panel--${variant}`,
        `lt-rhythm-panel--${layout}`,
        touch ? "is-touch" : "",
      ].join(" ")}
      data-layout={layout}
      data-variant={variant}
      data-testid="rhythm-panel"
    >
      <RhythmHeader
        settings={settings}
        patterns={patterns}
        playing={loopPlaying}
        layout={layout}
        songPatternName={songLoop?.pattern.name ?? null}
        freeBpm={freeBpm}
        handlers={handlers}
        onEdit={onEdit ? () => onEdit({ kind: "pattern" }) : undefined}
        onClose={onClose}
      />
      {layout === "short" && surfaces === "both" ? (
        <div className="lt-rhythm-switch" role="tablist" data-testid="rhythm-surface-switch">
          {(["loops", "oneShots"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={surface === value}
              className={surface === value ? "is-active" : ""}
              onClick={() => setSurface(value)}
            >
              {value === "loops" ? t("rhythm.loops") : t("rhythm.oneShots")}
            </button>
          ))}
        </div>
      ) : null}
      <div className={twoColumns ? "lt-rhythm-body is-two-columns" : "lt-rhythm-body"}>
        {showLoops ? loopsZone : null}
        {twoColumns ? <div className="lt-rhythm-divider" aria-hidden="true" /> : null}
        {showShots ? shotsZone : null}
      </div>
    </div>
  );
}
