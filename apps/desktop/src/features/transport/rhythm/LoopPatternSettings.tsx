// Ajustes del patrón en el editor: compases, compás, pasos por tiempo (avisa
// si la conversión no es exacta), swing, BPM libre, copiar variación y vaciar
// fila. Todo pasa por `patternOps`.
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { LoopPattern } from "@libretracks/shared/models";

import { VARIATION_LETTERS } from "./LoopRows";
import { clearRow, copyVariation, normalizePattern, resizeBars, setStepsPerBeat } from "./patternOps";
import { NumberInput } from "../../../shared/NumberInput";

const SIGNATURES: Array<[number, number]> = [
  [4, 4],
  [3, 4],
  [2, 4],
  [6, 8],
  [12, 8],
  [5, 4],
  [7, 8],
];

type LoopPatternSettingsProps = {
  pattern: LoopPattern;
  variation: number;
  onChange: (pattern: LoopPattern) => void;
};

export function LoopPatternSettings({ pattern, variation, onChange }: LoopPatternSettingsProps) {
  const { t } = useTranslation();
  const [warning, setWarning] = useState<string | null>(null);
  const [copyTarget, setCopyTarget] = useState((variation + 1) % 4);

  return (
    <div className="lt-loop-settings" data-testid="loop-pattern-settings">
      <label className="lt-rhythm-field">
        <span className="lt-rhythm-field__label">{t("rhythm.editor.bars")}</span>
        <select
          value={pattern.bars}
          onChange={(event) => onChange(resizeBars(pattern, Number(event.target.value)))}
        >
          {[1, 2, 4].map((bars) => (
            <option key={bars} value={bars}>
              {bars}
            </option>
          ))}
        </select>
      </label>
      <label className="lt-rhythm-field">
        <span className="lt-rhythm-field__label">{t("rhythm.editor.signature")}</span>
        <select
          value={`${pattern.signature.numerator}/${pattern.signature.denominator}`}
          onChange={(event) => {
            const [numerator, denominator] = event.target.value.split("/").map(Number);
            onChange(normalizePattern({ ...pattern, signature: { numerator, denominator } }));
          }}
        >
          {SIGNATURES.map(([n, d]) => (
            <option key={`${n}/${d}`} value={`${n}/${d}`}>{`${n}/${d}`}</option>
          ))}
        </select>
      </label>
      <label className="lt-rhythm-field">
        <span className="lt-rhythm-field__label">{t("rhythm.editor.stepsPerBeat")}</span>
        <select
          value={pattern.stepsPerBeat}
          onChange={(event) => {
            const result = setStepsPerBeat(pattern, Number(event.target.value) as 3 | 4);
            setWarning(result.movedSteps > 0 ? t("rhythm.editor.inexact", { count: result.movedSteps }) : null);
            onChange(result.pattern);
          }}
        >
          <option value={4}>{t("rhythm.editor.sixteenths")}</option>
          <option value={3}>{t("rhythm.editor.triplets")}</option>
        </select>
      </label>
      <span className="lt-loop-settings__divider" aria-hidden="true" />
      <label className="lt-rhythm-field">
        <span className="lt-rhythm-field__label">{t("rhythm.editor.swing")}</span>
        <input
          type="range"
          min={0}
          max={0.75}
          step={0.05}
          value={pattern.swing}
          onChange={(event) => onChange({ ...pattern, swing: Number(event.target.value) })}
        />
        <span className="lt-loop-settings__value">{Math.round(pattern.swing * 100)}%</span>
      </label>
      <label className="lt-rhythm-field">
        <span className="lt-rhythm-field__label">{t("rhythm.editor.freeBpm")}</span>
        <NumberInput
          min={30}
          max={300}
          value={pattern.bpm}
          onChange={(bpm) => onChange(normalizePattern({ ...pattern, bpm }))}
        />
      </label>
      <span className="lt-rhythm-field">
        <button type="button" onClick={() => onChange(copyVariation(pattern, variation, copyTarget))}>
          {t("rhythm.editor.copyVariation", { from: VARIATION_LETTERS[variation] })}
        </button>
        <select
          aria-label={t("rhythm.editor.copyTarget")}
          value={copyTarget}
          onChange={(event) => setCopyTarget(Number(event.target.value))}
        >
          {VARIATION_LETTERS.map((letter, index) =>
            index === variation ? null : (
              <option key={letter} value={index}>
                {letter}
              </option>
            ),
          )}
        </select>
      </span>
      <span className="lt-rhythm-field">
        <select
          aria-label={t("rhythm.editor.clearRow")}
          value=""
          onChange={(event) => {
            if (event.target.value !== "") onChange(clearRow(pattern, Number(event.target.value)));
          }}
        >
          <option value="">{t("rhythm.editor.clearRow")}</option>
          {pattern.rows.map((row, index) => (
            <option key={row.soundId} value={index}>
              {row.soundId}
            </option>
          ))}
        </select>
      </span>
      {warning ? (
        <p className="lt-loop-settings__warning" role="status">
          {warning}
        </p>
      ) : null}
    </div>
  );
}
