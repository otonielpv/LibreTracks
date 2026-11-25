// Filas del loop en directo: color + nombre, interruptor, variaciones A-D y
// tira de pasos (wide) o pulso (medium). En el teléfono (short) la variación
// es un desplegable para dejar sitio a la tira de pasos (decisión del usuario,
// 2026-11-18). Una variación pendiente (cuantizada)
// parpadea hasta que el motor la aplica.
import { memo } from "react";
import { useTranslation } from "react-i18next";

import type { DrumKit, LoopPattern, LoopRowMeter } from "@libretracks/shared/models";

import { MidiMappable } from "../midi/MidiMappable";
import { stepsPerBar as patternStepsPerBar } from "./patternOps";
import type { RhythmHandlers } from "./rhythmHandlers";
import { LoopStepStrip } from "./LoopStepStrip";
import type { RhythmLayoutClass } from "./useRhythmLayout";
import { rhythmDisplayColor } from "./padColor";

export const VARIATION_LETTERS = ["A", "B", "C", "D"] as const;

/** Contador de renders, solo para el test de que el paso no re-renderiza. */
export const loopRowsRenderCount = { current: 0 };

type LoopRowsProps = {
  pattern: LoopPattern;
  kit: DrumKit;
  rows: LoopRowMeter[];
  layout: RhythmLayoutClass;
  handlers: Pick<RhythmHandlers, "toggleRow" | "setRowVariation">;
};

function LoopRowsImpl({ pattern, kit, rows, layout, handlers }: LoopRowsProps) {
  loopRowsRenderCount.current += 1;
  const { t } = useTranslation();
  const spb = patternStepsPerBar(pattern);
  const compactVariation = layout === "short";
  return (
    <div className="lt-rhythm-rows" data-testid="rhythm-rows">
      {pattern.rows.map((row, index) => {
        const sound = kit.sounds.find((s) => s.id === row.soundId);
        const meter = rows[index];
        const enabled = meter?.enabled ?? true;
        const pendingEnabled = meter?.pendingEnabled;
        const active = meter?.variation ?? 0;
        const pending = meter?.pendingVariation;
        const name = sound?.name ?? row.soundId;
        return (
          <div
            key={row.soundId}
            className={enabled ? "lt-rhythm-row" : "lt-rhythm-row is-off"}
            data-testid={`rhythm-row-${index}`}
          >
            <span className="lt-rhythm-row__color" style={{ background: rhythmDisplayColor(sound?.color) }} />
            <MidiMappable target={`loop:row:${index + 1}:toggle`} label={name}>
            <button
              type="button"
              className={[
                "lt-rhythm-row__toggle",
                enabled ? "is-on" : "",
                pendingEnabled !== undefined ? "is-pending" : "",
              ].join(" ")}
              aria-pressed={enabled}
              aria-label={t("rhythm.rowToggle", { name })}
              onClick={() => void handlers.toggleRow(index)}
            >
              <span className="lt-rhythm-row__name">{name}</span>
            </button>
            </MidiMappable>
            {compactVariation ? (
              <select
                className={pending !== undefined ? "lt-rhythm-row__variation-select is-pending" : "lt-rhythm-row__variation-select"}
                aria-label={`${name} ${t("rhythm.editor.variation")}`}
                value={pending ?? active}
                onChange={(event) => void handlers.setRowVariation(index, Number(event.target.value))}
              >
                {VARIATION_LETTERS.map((letter, v) => (
                  <option key={letter} value={v}>
                    {letter}
                  </option>
                ))}
              </select>
            ) : (
              <div className="lt-rhythm-row__variations" role="group">
                {VARIATION_LETTERS.map((letter, v) => (
                  <MidiMappable key={letter} target={`loop:row:${index + 1}:var:${letter.toLowerCase()}`} label={`${name} ${letter}`}>
                  <button
                    type="button"
                    className={[
                      "lt-rhythm-chip",
                      v === active && pending === undefined ? "is-active" : "",
                      v === active && pending !== undefined ? "is-leaving" : "",
                      v === pending ? "is-pending" : "",
                    ].join(" ")}
                    aria-pressed={v === active}
                    aria-label={t("rhythm.variation", { letter })}
                    onClick={() => void handlers.setRowVariation(index, v)}
                  >
                    {letter}
                  </button>
                  </MidiMappable>
                ))}
              </div>
            )}
            {layout === "wide" || layout === "short" ? (
              <LoopStepStrip
                steps={row.variations[active] ?? []}
                stepsPerBar={spb}
                stepsPerBeat={pattern.stepsPerBeat}
                mode="strip"
              />
            ) : layout === "medium" ? (
              <LoopStepStrip
                steps={row.variations[active] ?? []}
                stepsPerBar={spb}
                stepsPerBeat={pattern.stepsPerBeat}
                mode="pulse"
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export const LoopRows = memo(LoopRowsImpl);
