// Rejilla 4×3 de one shots con bancos A-D. `down` en pointerdown (no en click:
// latencia) y `up` en pointerup/pointercancel; varios dedos a la vez, cada uno
// con su pointerId.
import { memo, useRef } from "react";
import { useTranslation } from "react-i18next";

import { ONE_SHOT_PADS_PER_BANK, type OneShotBank } from "@libretracks/shared/models";

import { MidiMappable } from "../midi/MidiMappable";
import { useTimelineUIStore } from "../uiStore";
import type { RhythmHandlers } from "./rhythmHandlers";
import { rhythmDisplayColor } from "./padColor";

const BANK_LETTERS = ["A", "B", "C", "D"] as const;

type OneShotGridProps = {
  bank: OneShotBank | null;
  bankIndex: number;
  bankCount: number;
  activeMask: number;
  editMode: boolean;
  handlers: Pick<RhythmHandlers, "padDown" | "padUp" | "stopAllPads" | "selectBank">;
  onEditPad?: (pad: number) => void;
  /** ✎: entra o sale del modo edición de los pads. */
  onToggleEdit?: () => void;
  /** Modo edición: arrastrar un pad sobre otro los intercambia. */
  onSwap?: (from: number, to: number) => void;
};

function OneShotGridImpl({
  bank,
  bankIndex,
  bankCount,
  activeMask,
  editMode,
  handlers,
  onEditPad,
  onToggleEdit,
  onSwap,
}: OneShotGridProps) {
  const { t } = useTranslation();
  const pressed = useRef(new Map<number, number>());
  const dragFrom = useRef<number | null>(null);
  // En modo Mapeo tocar un pad aprende su destino, no suena.
  const learning = useTimelineUIStore((state) => state.midiLearnMode !== null);
  const swapped = useRef(false);

  const release = (pointerId: number) => {
    const pad = pressed.current.get(pointerId);
    if (pad === undefined) return;
    pressed.current.delete(pointerId);
    void handlers.padUp(pad);
  };

  return (
    <div className="lt-rhythm-shots" data-testid="rhythm-one-shots">
      <div className="lt-rhythm-shots__bar">
        <div className="lt-rhythm-shots__banks" role="tablist">
          {BANK_LETTERS.slice(0, Math.max(1, bankCount)).map((letter, index) => (
            <MidiMappable key={letter} target={`oneshot:bank:${letter.toLowerCase()}`}>
            <button
              type="button"
              role="tab"
              aria-selected={index === bankIndex}
              aria-label={t("rhythm.bank", { letter })}
              className={index === bankIndex ? "lt-rhythm-chip is-active" : "lt-rhythm-chip"}
              onClick={() => void handlers.selectBank(index)}
            >
              {letter}
            </button>
            </MidiMappable>
          ))}
        </div>
        {onToggleEdit ? (
          <button
            type="button"
            className={editMode ? "lt-rhythm-chip is-active" : "lt-rhythm-chip"}
            aria-pressed={editMode}
            aria-label={t("rhythm.pads.editMode")}
            onClick={onToggleEdit}
          >
            ✎
          </button>
        ) : null}
        <MidiMappable target="action:oneshots_stop_all">
        <button type="button" className="lt-rhythm-stop-all" onClick={() => void handlers.stopAllPads()}>
          {t("rhythm.stopAll")}
        </button>
        </MidiMappable>
      </div>
      <div className="lt-rhythm-shots__grid">
        {Array.from({ length: ONE_SHOT_PADS_PER_BANK }, (_, index) => {
          const pad = bank?.pads[index] ?? null;
          const sounding = (activeMask & (1 << index)) !== 0;
          if (!pad) {
            return (
              <button
                key={index}
                type="button"
                className="lt-rhythm-pad is-empty"
                aria-label={t("rhythm.emptyPad")}
                data-testid={`rhythm-pad-${index}`}
                onClick={() => onEditPad?.(index)}
              >
                +
              </button>
            );
          }
          if (editMode) {
            return (
              <button
                key={index}
                type="button"
                className="lt-rhythm-pad is-editing"
                style={{ ["--lt-rhythm-pad-color" as string]: rhythmDisplayColor(pad.color) }}
                data-testid={`rhythm-pad-${index}`}
                onPointerDown={(event) => {
                  event.currentTarget.releasePointerCapture?.(event.pointerId);
                  dragFrom.current = index;
                  swapped.current = false;
                }}
                onPointerUp={() => {
                  const from = dragFrom.current;
                  dragFrom.current = null;
                  if (from !== null && from !== index) {
                    swapped.current = true;
                    onSwap?.(from, index);
                  }
                }}
                onClick={() => {
                  if (swapped.current) {
                    swapped.current = false;
                    return;
                  }
                  onEditPad?.(index);
                }}
              >
                {pad.name}
              </button>
            );
          }
          return (
            <MidiMappable key={index} target={`oneshot:${index + 1}`} label={pad.name}>
            <button
              type="button"
              className={sounding ? "lt-rhythm-pad is-sounding" : "lt-rhythm-pad"}
              style={{ ["--lt-rhythm-pad-color" as string]: rhythmDisplayColor(pad.color) }}
              aria-label={pad.name || t("rhythm.padLabel", { number: index + 1 })}
              data-testid={`rhythm-pad-${index}`}
              onPointerDown={(event) => {
                if (learning) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture?.(event.pointerId);
                pressed.current.set(event.pointerId, index);
                void handlers.padDown(index);
              }}
              onPointerUp={(event) => release(event.pointerId)}
              onPointerCancel={(event) => release(event.pointerId)}
              onContextMenu={(event) => event.preventDefault()}
            >
              {pad.name}
            </button>
            </MidiMappable>
          );
        })}
      </div>
    </div>
  );
}

export const OneShotGrid = memo(OneShotGridImpl);
