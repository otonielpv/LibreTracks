import { useTranslation } from "react-i18next";

import {
  MIDI_CONTROL_MODES,
  type MidiBinding,
  type MidiControlMode,
} from "@libretracks/shared/models";

import { formatMidiBinding } from "../helpers";
import { useSongStore } from "../songStore";
import { describeMidiTarget, isOtherSessionTarget } from "./controllerTargets";

/**
 * Every binding with its behaviour (plan midi-controllers, paso 05, D1): mode,
 * the slice of the target's travel the control covers, invert, soft takeover
 * and remove. Track bindings whose track is not in the open session are
 * marked, not hidden: they come back when that session is opened.
 */
export function MidiBindingsEditor({
  midiMappings,
  describe,
  disabled,
  onChange,
}: {
  midiMappings: Record<string, MidiBinding>;
  /** Labels for the transport keys (the monolith's command rows). */
  describe: (key: string) => string;
  disabled: boolean;
  onChange: (key: string, binding: MidiBinding | null) => void;
}) {
  const { t } = useTranslation();
  const song = useSongStore((state) => state.song);
  const entries = Object.entries(midiMappings).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  if (entries.length === 0) {
    return <p className="lt-midi-bindings-empty">{t("midiMap.noBindings")}</p>;
  }

  const percent = (value: number | undefined, fallback: number) =>
    Math.round((value ?? fallback) * 100);

  return (
    <ul className="lt-midi-bindings">
      {entries.map(([key, binding]) => {
        const label = describeMidiTarget(key, t, song) ?? describe(key);
        const other = isOtherSessionTarget(key, song);
        const update = (patch: Partial<MidiBinding>) =>
          onChange(key, { ...binding, ...patch });
        return (
          <li key={key} className={other ? "is-other-session" : undefined}>
            <div className="lt-midi-bindings-head">
              <strong>{label}</strong>
              <span className="lt-midi-binding-pill">{formatMidiBinding(binding)}</span>
              <button
                type="button"
                className="lt-ghost-button lt-midi-bindings-remove"
                disabled={disabled}
                onClick={() => onChange(key, null)}
              >
                {t("midiMap.remove")}
              </button>
            </div>
            <div className="lt-midi-bindings-fields">
              <label>
                <span>{t("midiMap.mode")}</span>
                <select
                  value={binding.mode ?? ""}
                  disabled={disabled}
                  onChange={(event) =>
                    update({
                      mode: (event.target.value || undefined) as MidiControlMode | undefined,
                    })
                  }
                >
                  <option value="">{t("midiMap.modeAuto")}</option>
                  {MIDI_CONTROL_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {t(`midiMap.modes.${mode}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t("midiMap.min")}</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  inputMode="numeric"
                  value={percent(binding.min, 0)}
                  disabled={disabled}
                  onChange={(event) => update({ min: Number(event.target.value) / 100 })}
                />
              </label>
              <label>
                <span>{t("midiMap.max")}</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  inputMode="numeric"
                  value={percent(binding.max, 1)}
                  disabled={disabled}
                  onChange={(event) => update({ max: Number(event.target.value) / 100 })}
                />
              </label>
              <label className="lt-midi-bindings-check">
                <input
                  type="checkbox"
                  checked={binding.invert === true}
                  disabled={disabled}
                  onChange={(event) => update({ invert: event.target.checked })}
                />
                <span>{t("midiMap.invert")}</span>
              </label>
              <label className="lt-midi-bindings-check" title={t("midiMap.takeoverHint")}>
                <input
                  type="checkbox"
                  checked={binding.takeover !== false}
                  disabled={disabled}
                  onChange={(event) => update({ takeover: event.target.checked })}
                />
                <span>{t("midiMap.takeover")}</span>
              </label>
            </div>
            {other ? <em className="lt-midi-bindings-note">{t("midiMap.otherSession")}</em> : null}
          </li>
        );
      })}
    </ul>
  );
}
