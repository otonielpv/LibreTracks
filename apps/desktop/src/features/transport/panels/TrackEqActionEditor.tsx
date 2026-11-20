import type { ReactNode } from "react";

import type { AutomationActionSummary, TrackEq } from "../desktopApi";
import { defaultTrackEq } from "../eq/trackEqModel";
import { eqPresetLabel, useEqPresets } from "../eq/useEqPresets";

type T = (key: string, options?: Record<string, unknown>) => string;

type EqAction = Extract<
  AutomationActionSummary,
  { type: "setTrackEq" } | { type: "setTrackEqEnabled" }
>;

/**
 * Las acciones de EQ de una cue (plan track-eq-2, paso 04).
 *
 * - «EQ de pista»: la pista, la curva (la guardada en la cue, la que tiene
 *   ahora la pista, un preset o quitar el EQ) y la rampa, que recorre el
 *   motor entera, sin escalones.
 * - «EQ encendido / apagado»: el bypass, con el fundido corto.
 */
export function TrackEqActionEditor({
  action,
  trackSelect,
  trackEqOf,
  t,
  onChange,
}: {
  action: EqAction;
  trackSelect: ReactNode;
  trackEqOf?: (trackId: string) => TrackEq | null;
  t: T;
  onChange: (next: AutomationActionSummary) => void;
}) {
  if (action.type === "setTrackEqEnabled") {
    const label = t("transport.automation.eqLabel");
    return (
      <div className="lt-automation-action-fields">
        {trackSelect}
        <label className="lt-settings-field">
          <span className="lt-settings-field-label">{label}</span>
          <select
            aria-label={label}
            value={action.enabled ? "on" : "off"}
            onChange={(event) => onChange({ ...action, enabled: event.target.value === "on" })}
          >
            <option value="on">{t("transport.automation.enableOption")}</option>
            <option value="off">{t("transport.automation.disableOption")}</option>
          </select>
        </label>
      </div>
    );
  }
  return (
    <TrackEqCurveFields
      action={action}
      trackSelect={trackSelect}
      trackEqOf={trackEqOf}
      t={t}
      onChange={onChange}
    />
  );
}

function TrackEqCurveFields({
  action,
  trackSelect,
  trackEqOf,
  t,
  onChange,
}: {
  action: Extract<AutomationActionSummary, { type: "setTrackEq" }>;
  trackSelect: ReactNode;
  trackEqOf?: (trackId: string) => TrackEq | null;
  t: T;
  onChange: (next: AutomationActionSummary) => void;
}) {
  const presets = useEqPresets();
  const curveLabel = t("transport.automation.eqCurveLabel");
  const rampLabel = t("transport.automation.smoothingSeconds");
  return (
    <div className="lt-automation-action-fields">
      {trackSelect}
      <label className="lt-settings-field">
        <span className="lt-settings-field-label">{curveLabel}</span>
        <select
          aria-label={curveLabel}
          value={action.eq ? "saved" : "remove"}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "remove") onChange({ ...action, eq: null });
            else if (value === "current")
              onChange({ ...action, eq: trackEqOf?.(action.trackId) ?? defaultTrackEq() });
            else if (value.startsWith("preset:")) {
              const preset = presets.find((candidate) => `preset:${candidate.id}` === value);
              if (preset) onChange({ ...action, eq: preset.eq });
            }
          }}
        >
          {action.eq ? (
            <option value="saved">{t("transport.automation.eqSavedCurve")}</option>
          ) : null}
          <option value="current">{t("transport.automation.eqCurrentCurve")}</option>
          {presets.map((preset) => (
            <option key={preset.id} value={`preset:${preset.id}`}>
              {t("transport.automation.eqPreset", { name: eqPresetLabel(preset, t) })}
            </option>
          ))}
          <option value="remove">{t("transport.automation.eqRemove")}</option>
        </select>
      </label>
      <label className="lt-settings-field">
        <span className="lt-settings-field-label">{rampLabel}</span>
        <small className="lt-settings-field-hint">{t("transport.automation.immediateHint")}</small>
        <input
          type="number"
          min={0}
          step={0.1}
          aria-label={rampLabel}
          value={action.rampSeconds ?? 0}
          onChange={(event) => {
            const seconds = Math.max(0, Number(event.target.value));
            onChange({ ...action, rampSeconds: seconds > 0 ? seconds : null });
          }}
        />
      </label>
    </div>
  );
}
