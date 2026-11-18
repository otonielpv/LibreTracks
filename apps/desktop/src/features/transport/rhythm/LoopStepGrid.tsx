// Rejilla de pasos del editor (plan drum-loops, paso 08).
//
// - Tocar alterna normal ↔ silencio. Mantener 400 ms o clic derecho cicla
//   suave → normal → acento.
// - Arrastrar pinta con el valor que dejó la primera celda. Mientras dura, la
//   vista previa es estado LOCAL de la rejilla; al soltar sale UNA sola
//   actualización del borrador (`onChange`).
// - El paso que suena se resalta por rAF leyendo `rhythmStepRef`.
import { useEffect, useRef, useState } from "react";

import type { DrumKit, LoopPattern } from "@libretracks/shared/models";

import { cancelGatedFrame, markFrameActivity, requestGatedFrame } from "../frameGate";
import { cycleVelocity, paintSteps, STEP_NORMAL, stepsPerBar } from "./patternOps";
import { rhythmStepRef } from "./rhythmStore";

export const LONG_PRESS_MS = 400;

type Drag = { row: number; value: number; cells: Set<number>; moved: boolean };

type LoopStepGridProps = {
  pattern: LoopPattern;
  kit: DrumKit;
  variation: number;
  /** Primer paso visible (paginación por compases). */
  firstStep: number;
  visibleSteps: number;
  onChange: (pattern: LoopPattern) => void;
};

export function LoopStepGrid({
  pattern,
  kit,
  variation,
  firstStep,
  visibleSteps,
  onChange,
}: LoopStepGridProps) {
  const [preview, setPreview] = useState<{ row: number; value: number; cells: Set<number> } | null>(null);
  const drag = useRef<Drag | null>(null);
  const longPress = useRef<number | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const spb = stepsPerBar(pattern);
  const steps = Math.min(visibleSteps, Math.max(0, pattern.rows[0]?.variations[variation]?.length ?? 0) - firstStep);

  const clearLongPress = () => {
    if (longPress.current !== null) {
      window.clearTimeout(longPress.current);
      longPress.current = null;
    }
  };

  const finish = () => {
    clearLongPress();
    const current = drag.current;
    drag.current = null;
    setPreview(null);
    if (!current) return;
    let next = pattern;
    for (const step of current.cells) next = paintSteps(next, current.row, variation, step, step + 1, current.value);
    if (next !== pattern) onChange(next);
  };

  useEffect(() => {
    const up = () => finish();
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      clearLongPress();
    };
  });

  // El paso que suena, por rAF.
  useEffect(() => {
    let frameId = 0;
    let last = Number.NaN;
    const frame = () => {
      const step = rhythmStepRef.playing ? rhythmStepRef.step : -1;
      if (step !== last && gridRef.current) {
        gridRef.current.querySelectorAll(".lt-step-cell.is-playing").forEach((c) => c.classList.remove("is-playing"));
        if (step >= 0) {
          gridRef.current
            .querySelectorAll(`.lt-step-cell[data-step="${step}"]`)
            .forEach((c) => c.classList.add("is-playing"));
        }
        last = step;
        markFrameActivity();
      }
      frameId = requestGatedFrame(frame);
    };
    frameId = requestGatedFrame(frame);
    return () => cancelGatedFrame(frameId);
  }, []);

  const valueAt = (row: number, step: number) => {
    if (preview && preview.row === row && preview.cells.has(step)) return preview.value;
    return pattern.rows[row]?.variations[variation]?.[step] ?? 0;
  };

  const startDrag = (row: number, step: number, pointerId: number, target: HTMLElement) => {
    // Con el dedo hay captura implícita: se suelta para que las demás celdas
    // reciban pointerenter durante el arrastre.
    target.releasePointerCapture?.(pointerId);
    const current = pattern.rows[row]?.variations[variation]?.[step] ?? 0;
    const value = current === 0 ? STEP_NORMAL : 0;
    drag.current = { row, value, cells: new Set([step]), moved: false };
    setPreview({ row, value, cells: new Set([step]) });
    clearLongPress();
    longPress.current = window.setTimeout(() => {
      longPress.current = null;
      if (drag.current && !drag.current.moved) {
        drag.current = null;
        setPreview(null);
        onChange(cycleVelocity(pattern, row, variation, step));
      }
    }, LONG_PRESS_MS);
  };

  const enter = (row: number, step: number) => {
    const current = drag.current;
    if (!current || current.row !== row || current.cells.has(step)) return;
    current.cells.add(step);
    current.moved = true;
    clearLongPress();
    setPreview({ row, value: current.value, cells: new Set(current.cells) });
  };

  const beatsVisible = Math.ceil(Math.max(0, steps) / Math.max(1, pattern.stepsPerBeat));
  const beatGroups = Array.from({ length: beatsVisible }, (_, beat) => {
    const first = firstStep + beat * pattern.stepsPerBeat;
    return Array.from({ length: pattern.stepsPerBeat }, (_, i) => first + i).filter((step) => step < firstStep + steps);
  });
  const beatsPerBar = Math.max(1, pattern.signature.numerator);

  return (
    <div ref={gridRef} className="lt-step-grid" data-testid="loop-step-grid">
      <div className="lt-step-row lt-step-row--ruler" aria-hidden="true">
        <span className="lt-step-row__label" />
        <div className="lt-step-row__cells">
          {beatGroups.map((group, beat) => {
            const absoluteBeat = Math.floor(group[0] / Math.max(1, pattern.stepsPerBeat));
            const barStart = absoluteBeat % beatsPerBar === 0;
            return (
              <span key={beat} className={barStart ? "lt-step-beat is-bar-start" : "lt-step-beat"}>
                <span className="lt-step-ruler__number">
                  {barStart ? `${Math.floor(absoluteBeat / beatsPerBar) + 1}` : `·${(absoluteBeat % beatsPerBar) + 1}`}
                </span>
              </span>
            );
          })}
        </div>
      </div>
      {pattern.rows.map((row, rowIndex) => {
        const sound = kit.sounds.find((s) => s.id === row.soundId);
        const name = sound?.name ?? row.soundId;
        return (
          <div
            key={row.soundId}
            className="lt-step-row"
            data-testid={`step-row-${rowIndex}`}
            style={{ ["--lt-step-color" as string]: sound?.color || "#57f1db" }}
          >
            <span className="lt-step-row__label" title={name}>
              <span className="lt-step-row__color" />
              <span className="lt-step-row__name">{name}</span>
            </span>
            <div className="lt-step-row__cells">
              {beatGroups.map((group, beat) => {
                const absoluteBeat = Math.floor(group[0] / Math.max(1, pattern.stepsPerBeat));
                return (
                  <span
                    key={beat}
                    className={absoluteBeat % beatsPerBar === 0 ? "lt-step-beat is-bar-start" : "lt-step-beat"}
                  >
                    {group.map((step) => {
                      const value = valueAt(rowIndex, step);
                      return (
                        <button
                          key={step}
                          type="button"
                          className={step % pattern.stepsPerBeat === 0 ? "lt-step-cell is-beat" : "lt-step-cell"}
                          data-step={step}
                          data-velocity={value}
                          data-bar-start={step % spb === 0 ? "true" : undefined}
                          aria-label={`${name} ${step + 1}`}
                          aria-pressed={value > 0}
                          onPointerDown={(event) => {
                            if (event.button === 2) return;
                            event.preventDefault();
                            startDrag(rowIndex, step, event.pointerId, event.currentTarget);
                          }}
                          onPointerEnter={() => enter(rowIndex, step)}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            clearLongPress();
                            drag.current = null;
                            setPreview(null);
                            onChange(cycleVelocity(pattern, rowIndex, variation, step));
                          }}
                        />
                      );
                    })}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
