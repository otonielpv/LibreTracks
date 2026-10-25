import {
  METRONOME_SOUND_PRESETS,
  METRONOME_SUBDIVISIONS,
  VOICE_GUIDE_COUNT_STYLES,
  isVoiceGuideCountStyle,
  type AutomationActionSummary,
} from "@libretracks/shared/models";

import { voiceGuideCountStyleLabel } from "../songs/songCountStyle";

type Translate = (key: string, options?: Record<string, unknown>) => string;
type RouteOption = { value: string; label: string };

export type SetMetronomeAction = Extract<AutomationActionSummary, { type: "setMetronome" }>;
export type SetVoiceGuideAction = Extract<AutomationActionSummary, { type: "setVoiceGuide" }>;

/** Voice banks shipped with the app (`resources/voices`). */
export const VOICE_GUIDE_LANGUAGE_OPTIONS = [
  { value: "es", label: "Español" },
  { value: "en", label: "English" },
] as const;

// The "leave as it is" entry of every select. A cue usually changes one or two
// settings (switch the click off for the bridge); pinning the rest would undo
// whatever the user set by hand in between.
const UNCHANGED = "";

function isPreset(value: number | null | undefined): boolean {
  return value == null || (Number.isInteger(value) && value >= 0 && value < METRONOME_SOUND_PRESETS.length);
}

/** Mirrors the backend: at least one setting changes and every value is known. */
export function isValidMetronomeAction(action: SetMetronomeAction): boolean {
  const fields = [
    action.enabled,
    action.accentEnabled,
    action.accentPreset,
    action.beatPreset,
    action.subdivision,
    action.subdivisionPreset,
    action.output,
  ];
  return (
    fields.some((value) => value != null) &&
    isPreset(action.accentPreset) &&
    isPreset(action.beatPreset) &&
    isPreset(action.subdivisionPreset) &&
    (action.subdivision == null ||
      (METRONOME_SUBDIVISIONS as readonly number[]).includes(action.subdivision)) &&
    (action.output == null || action.output.trim() !== "")
  );
}

export function isValidVoiceGuideAction(action: SetVoiceGuideAction): boolean {
  const fields = [
    action.enabled,
    action.language,
    action.output,
    action.leadBars,
    action.countInEnabled,
    action.countStyle,
  ];
  return (
    fields.some((value) => value != null) &&
    (action.language == null ||
      VOICE_GUIDE_LANGUAGE_OPTIONS.some((option) => option.value === action.language)) &&
    (action.leadBars == null || action.leadBars === 1 || action.leadBars === 2) &&
    (action.output == null || action.output.trim() !== "")
  );
}

function OptionalSelect({
  label,
  value,
  options,
  t,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  t: Translate;
  onChange: (value: string) => void;
}) {
  return (
    <label className="lt-settings-field">
      <span className="lt-settings-field-label">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value={UNCHANGED}>{t("transport.automation.unchangedOption")}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function OnOffSelect({
  label,
  value,
  t,
  onChange,
}: {
  label: string;
  value: boolean | null | undefined;
  t: Translate;
  onChange: (value: boolean | null) => void;
}) {
  return (
    <OptionalSelect
      label={label}
      value={value == null ? UNCHANGED : value ? "on" : "off"}
      options={[
        { value: "on", label: t("transport.automation.enableOption") },
        { value: "off", label: t("transport.automation.disableOption") },
      ]}
      t={t}
      onChange={(next) => onChange(next === UNCHANGED ? null : next === "on")}
    />
  );
}

const toNumberOrNull = (value: string) => (value === UNCHANGED ? null : Number(value));
const toStringOrNull = (value: string) => (value === UNCHANGED ? null : value);
const numberValue = (value: number | null | undefined) => (value == null ? UNCHANGED : String(value));

export function MetronomeActionEditor({
  action,
  routeOptions,
  t,
  onChange,
}: {
  action: SetMetronomeAction;
  routeOptions: RouteOption[];
  t: Translate;
  onChange: (next: AutomationActionSummary) => void;
}) {
  const presetOptions = METRONOME_SOUND_PRESETS.map((preset, index) => ({
    value: String(index),
    label: t(`transport.settingsModal.metronomePreset.${preset}`, { defaultValue: preset }),
  }));
  const subdivisionOptions = METRONOME_SUBDIVISIONS.map((value) => ({
    value: String(value),
    label: t(`transport.settingsModal.metronomeSubdivisionOption.${value}`, {
      defaultValue: value === 1 ? "Off" : `1/${value}`,
    }),
  }));
  return (
    <div className="lt-automation-action-fields">
      <OnOffSelect
        label={t("transport.automation.clickState")}
        value={action.enabled}
        t={t}
        onChange={(enabled) => onChange({ ...action, enabled })}
      />
      <OnOffSelect
        label={t("transport.settingsModal.metronomeAccentEnabled")}
        value={action.accentEnabled}
        t={t}
        onChange={(accentEnabled) => onChange({ ...action, accentEnabled })}
      />
      <OptionalSelect
        label={t("transport.settingsModal.metronomeAccentSound")}
        value={numberValue(action.accentPreset)}
        options={presetOptions}
        t={t}
        onChange={(value) => onChange({ ...action, accentPreset: toNumberOrNull(value) })}
      />
      <OptionalSelect
        label={t("transport.settingsModal.metronomeBeatSound")}
        value={numberValue(action.beatPreset)}
        options={presetOptions}
        t={t}
        onChange={(value) => onChange({ ...action, beatPreset: toNumberOrNull(value) })}
      />
      <OptionalSelect
        label={t("transport.settingsModal.metronomeSubdivision")}
        value={numberValue(action.subdivision)}
        options={subdivisionOptions}
        t={t}
        onChange={(value) => onChange({ ...action, subdivision: toNumberOrNull(value) })}
      />
      <OptionalSelect
        label={t("transport.settingsModal.metronomeSubdivisionSound")}
        value={numberValue(action.subdivisionPreset)}
        options={presetOptions}
        t={t}
        onChange={(value) => onChange({ ...action, subdivisionPreset: toNumberOrNull(value) })}
      />
      <OptionalSelect
        label={t("transport.settingsModal.metronomeOutput")}
        value={action.output ?? UNCHANGED}
        options={routeOptions}
        t={t}
        onChange={(value) => onChange({ ...action, output: toStringOrNull(value) })}
      />
    </div>
  );
}

export function VoiceGuideActionEditor({
  action,
  routeOptions,
  t,
  onChange,
}: {
  action: SetVoiceGuideAction;
  routeOptions: RouteOption[];
  t: Translate;
  onChange: (next: AutomationActionSummary) => void;
}) {
  // Same list the voice-guide popover offers: the local monitor first.
  const outputOptions = [
    { value: "monitor", label: t("trackHeader.monitor", { defaultValue: "Monitor" }) },
    ...routeOptions.filter((option) => option.value !== "monitor"),
  ];
  return (
    <div className="lt-automation-action-fields">
      <OnOffSelect
        label={t("transport.automation.voiceGuideState")}
        value={action.enabled}
        t={t}
        onChange={(enabled) => onChange({ ...action, enabled })}
      />
      <OptionalSelect
        label={t("transport.settingsModal.voiceGuideLanguage")}
        value={action.language ?? UNCHANGED}
        options={VOICE_GUIDE_LANGUAGE_OPTIONS}
        t={t}
        onChange={(value) => onChange({ ...action, language: toStringOrNull(value) })}
      />
      <OnOffSelect
        label={t("transport.automation.voiceGuideCountIn")}
        value={action.countInEnabled}
        t={t}
        onChange={(countInEnabled) => onChange({ ...action, countInEnabled })}
      />
      <OptionalSelect
        label={t("transport.settingsModal.voiceGuideCountStyle")}
        value={action.countStyle ?? UNCHANGED}
        options={VOICE_GUIDE_COUNT_STYLES.map((style) => ({
          value: style,
          label: voiceGuideCountStyleLabel(t, style),
        }))}
        t={t}
        onChange={(value) =>
          onChange({ ...action, countStyle: isVoiceGuideCountStyle(value) ? value : null })
        }
      />
      <OptionalSelect
        label={t("transport.settingsModal.voiceGuideLeadBars")}
        value={numberValue(action.leadBars)}
        options={[
          { value: "1", label: "1" },
          { value: "2", label: "2" },
        ]}
        t={t}
        onChange={(value) => onChange({ ...action, leadBars: toNumberOrNull(value) })}
      />
      <OptionalSelect
        label={t("transport.settingsModal.voiceGuideOutput")}
        value={action.output ?? UNCHANGED}
        options={outputOptions}
        t={t}
        onChange={(value) => onChange({ ...action, output: toStringOrNull(value) })}
      />
    </div>
  );
}
