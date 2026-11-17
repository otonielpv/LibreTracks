import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { LeadTime } from "../desktopApi";
import {
  LEAD_PRESETS,
  type LeadUnit,
  leadAmount,
  makeLead,
  normalizeLead,
  presetKeyOf,
} from "./leadTime";

const NONE = "none";
const CUSTOM = "custom";

type LeadTimeFieldProps = {
  value: LeadTime | null;
  onChange: (lead: LeadTime | null) => void;
  /** The item has a jump: the hint says the jump itself stays on the bar. */
  hasJump?: boolean;
};

/**
 * "Fire ahead" control shared by the MIDI clip and automation cue editors
 * (plan lead-time). One-click presets for the usual cases (a beat, a bar) and
 * a custom row with any amount in beats, bars or seconds.
 */
export function LeadTimeField({ value, onChange, hasJump = false }: LeadTimeFieldProps) {
  const { t } = useTranslation();
  const lead = normalizeLead(value);
  const matchedPreset = presetKeyOf(lead);
  // Custom stays open while the user types, even when the value happens to
  // match a preset or is momentarily empty.
  const [customOpen, setCustomOpen] = useState(lead !== null && matchedPreset === null);
  const selectValue = customOpen ? CUSTOM : lead === null ? NONE : (matchedPreset ?? CUSTOM);

  const customUnit: LeadUnit = lead?.unit ?? "beats";
  const customAmount = lead ? leadAmount(lead) : 1;

  return (
    <div className="lt-lead-field">
      <label className="lt-settings-field lt-lead-field-select">
        <span className="lt-settings-field-label">{t("transport.lead.label")}</span>
        <select
          aria-label={t("transport.lead.label")}
          value={selectValue}
          onChange={(event) => {
            const next = event.target.value;
            if (next === NONE) {
              setCustomOpen(false);
              onChange(null);
            } else if (next === CUSTOM) {
              setCustomOpen(true);
              onChange(lead ?? makeLead("beats", 1));
            } else {
              setCustomOpen(false);
              const preset = LEAD_PRESETS.find((candidate) => candidate.key === next);
              onChange(preset ? preset.lead : null);
            }
          }}
        >
          <option value={NONE}>{t("transport.lead.none")}</option>
          {LEAD_PRESETS.map((preset) => (
            <option key={preset.key} value={preset.key}>
              {t(`transport.lead.preset.${preset.key}`)}
            </option>
          ))}
          <option value={CUSTOM}>{t("transport.lead.custom")}</option>
        </select>
      </label>

      {selectValue === CUSTOM ? (
        <div className="lt-lead-field-custom">
          <label className="lt-settings-field">
            <span className="lt-settings-field-label">{t("transport.lead.amount")}</span>
            <input
              type="number"
              min={0}
              step={customUnit === "seconds" ? 0.05 : 0.25}
              value={customAmount}
              onChange={(event) => {
                const amount = Number(event.target.value);
                onChange(makeLead(customUnit, Number.isFinite(amount) ? Math.max(0, amount) : 0));
              }}
            />
          </label>
          <label className="lt-settings-field">
            <span className="lt-settings-field-label">{t("transport.lead.unit")}</span>
            <select
              aria-label={t("transport.lead.unit")}
              value={customUnit}
              onChange={(event) =>
                onChange(makeLead(event.target.value as LeadUnit, customAmount))
              }
            >
              <option value="beats">{t("transport.lead.unitBeats")}</option>
              <option value="bars">{t("transport.lead.unitBars")}</option>
              <option value="seconds">{t("transport.lead.unitSeconds")}</option>
            </select>
          </label>
        </div>
      ) : null}

      {lead !== null ? (
        <p className="lt-lead-field-hint">
          {t("transport.lead.hint")}
          {hasJump ? ` ${t("transport.lead.hintJump")}` : ""}
        </p>
      ) : null}
    </div>
  );
}
