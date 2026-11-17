// Tira de pasos de una fila (wide) o punto de pulso (medium). El paso que
// suena se pinta por rAF leyendo `rhythmStepRef`, nunca con setState (D13).
import { memo, useEffect, useRef } from "react";

import { cancelGatedFrame, markFrameActivity, requestGatedFrame } from "../frameGate";
import { rhythmStepRef } from "./rhythmStore";

type LoopStepStripProps = {
  /** Pasos de la variación activa (todos los compases). */
  steps: number[];
  stepsPerBar: number;
  stepsPerBeat: number;
  mode: "strip" | "pulse";
};

function LoopStepStripImpl({ steps, stepsPerBar, stepsPerBeat, mode }: LoopStepStripProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stepsRef = useRef(steps);
  stepsRef.current = steps;

  useEffect(() => {
    let frameId = 0;
    let lastStep = Number.NaN;
    let lastBar = Number.NaN;
    let lastSteps: number[] | null = null;
    const frame = () => {
      const root = rootRef.current;
      const step = rhythmStepRef.playing ? rhythmStepRef.step : -1;
      const current = stepsRef.current;
      if (root && (step !== lastStep || current !== lastSteps)) {
        const bar = step >= 0 ? Math.floor(step / Math.max(1, stepsPerBar)) : 0;
        if (mode === "pulse") {
          root.classList.toggle("is-on", step >= 0 && (current[step] ?? 0) > 0);
        } else {
          const cells = root.children;
          if (bar !== lastBar || current !== lastSteps) {
            for (let i = 0; i < cells.length; i += 1) {
              const value = current[bar * stepsPerBar + i] ?? 0;
              (cells[i] as HTMLElement).dataset.velocity = String(value);
            }
          }
          const inBar = step >= 0 ? step - bar * stepsPerBar : -1;
          for (let i = 0; i < cells.length; i += 1) {
            cells[i].classList.toggle("is-current", i === inBar);
          }
        }
        lastStep = step;
        lastBar = bar;
        lastSteps = current;
        markFrameActivity();
      }
      frameId = requestGatedFrame(frame);
    };
    frameId = requestGatedFrame(frame);
    return () => cancelGatedFrame(frameId);
  }, [mode, stepsPerBar]);

  if (mode === "pulse") {
    return <div ref={rootRef} className="lt-rhythm-pulse" aria-hidden="true" />;
  }
  return (
    <div ref={rootRef} className="lt-rhythm-strip" aria-hidden="true">
      {Array.from({ length: stepsPerBar }, (_, i) => (
        <span
          key={i}
          className={i % Math.max(1, stepsPerBeat) === 0 ? "lt-rhythm-strip__cell is-beat" : "lt-rhythm-strip__cell"}
          data-velocity={steps[i] ?? 0}
        />
      ))}
    </div>
  );
}

export const LoopStepStrip = memo(LoopStepStripImpl);
