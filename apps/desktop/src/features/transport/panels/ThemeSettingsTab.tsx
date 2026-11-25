import { useTranslation } from "react-i18next";

import {
  GRID_INTENSITY_DEFAULT,
  GRID_INTENSITY_MAX,
  GRID_INTENSITY_MIN,
  GRID_INTENSITY_STEP,
  setGridIntensity,
  useGridIntensity,
} from "../../../shared/gridIntensity";
import {
  DEFAULT_THEME,
  THEME_ACCENTS,
  THEME_BASES,
  THEME_BRIGHTNESS_MAX,
  THEME_BRIGHTNESS_MIN,
  THEME_TONES,
  setTheme,
  useTheme,
  type ThemeBaseId,
  type ThemeToneId,
} from "../../../shared/theme";
import { SettingsTabSection } from "./SettingsTabSection";

/** Settings › Tema: colores de toda la interfaz y la rejilla, al estilo de Live. */
export function ThemeSettingsTab() {
  const { t } = useTranslation();
  const theme = useTheme();
  const gridIntensity = useGridIntensity();

  return (
    <SettingsTabSection id="theme">
      <label className="lt-settings-field">
        <span className="lt-settings-field-label">
          {t("transport.settingsModal.themeBase", { defaultValue: "Theme" })}
        </span>
        <select
          value={theme.base}
          onChange={(event) => setTheme({ base: event.target.value as ThemeBaseId })}
        >
          {THEME_BASES.map((base) => (
            <option key={base.id} value={base.id}>
              {t(`transport.settingsModal.themeBases.${base.id}`, {
                defaultValue: base.defaultLabel,
              })}
            </option>
          ))}
        </select>
        <small>
          {t("transport.settingsModal.themeBaseHelp", {
            defaultValue:
              "How light or dark the whole interface is. Track and clip colors do not change.",
          })}
        </small>
      </label>

      <label className="lt-settings-field">
        <span className="lt-settings-field-label">
          {t("transport.settingsModal.themeAccent", { defaultValue: "Accent color" })}
        </span>
        <span className="lt-settings-theme-row">
          <span className="lt-settings-theme-swatch" aria-hidden="true" />
          <select
            value={theme.accent}
            onChange={(event) => setTheme({ accent: event.target.value })}
          >
            {THEME_ACCENTS.map((accent) => (
              <option key={accent.id} value={accent.id}>
                {t(`transport.settingsModal.themeAccents.${accent.id}`, {
                  defaultValue: accent.defaultLabel,
                })}
              </option>
            ))}
          </select>
        </span>
        <small>
          {t("transport.settingsModal.themeAccentHelp", {
            defaultValue: "Buttons, playhead, selections and highlights.",
          })}
        </small>
      </label>

      <label className="lt-settings-field">
        <span className="lt-settings-field-label">
          {t("transport.settingsModal.themeTone", { defaultValue: "Tone" })}
        </span>
        <select
          value={theme.tone}
          onChange={(event) => setTheme({ tone: event.target.value as ThemeToneId })}
        >
          {THEME_TONES.map((tone) => (
            <option key={tone.id} value={tone.id}>
              {t(`transport.settingsModal.themeTones.${tone.id}`, {
                defaultValue: tone.defaultLabel,
              })}
            </option>
          ))}
        </select>
        <small>
          {t("transport.settingsModal.themeToneHelp", {
            defaultValue: "Tints the greys slightly blue (cool) or brown (warm).",
          })}
        </small>
      </label>

      <label className="lt-settings-toggle">
        <input
          type="checkbox"
          checked={theme.highContrast}
          onChange={(event) => setTheme({ highContrast: event.target.checked })}
        />
        <span className="lt-settings-toggle-copy">
          <strong>
            {t("transport.settingsModal.themeHighContrast", { defaultValue: "High contrast" })}
          </strong>
          <small>
            {t("transport.settingsModal.themeHighContrastHelp", {
              defaultValue: "More separation between text, panels and background.",
            })}
          </small>
        </span>
      </label>

      <SliderField
        id="lt-theme-brightness"
        label={t("transport.settingsModal.themeBrightness", { defaultValue: "Brightness" })}
        help={t("transport.settingsModal.themeBrightnessHelp", {
          defaultValue: "Lightens or darkens the backgrounds. Double-click to reset to 100 %.",
        })}
        min={THEME_BRIGHTNESS_MIN}
        max={THEME_BRIGHTNESS_MAX}
        step={0.01}
        value={theme.brightness}
        onChange={(value) => setTheme({ brightness: value })}
        onReset={() => setTheme({ brightness: DEFAULT_THEME.brightness })}
      />

      <SliderField
        id="lt-grid-intensity"
        label={t("transport.settingsModal.gridIntensity", {
          defaultValue: "Grid line intensity",
        })}
        help={t("transport.settingsModal.gridIntensityHelp", {
          defaultValue:
            "How visible the bar and beat lines are in the timeline. 0 % hides them. Double-click the slider to reset to 100 %.",
        })}
        min={GRID_INTENSITY_MIN}
        max={GRID_INTENSITY_MAX}
        step={GRID_INTENSITY_STEP}
        value={gridIntensity}
        onChange={setGridIntensity}
        onReset={() => setGridIntensity(GRID_INTENSITY_DEFAULT)}
      />

      <div className="lt-settings-field">
        <button
          type="button"
          className="lt-settings-theme-reset"
          onClick={() => {
            setTheme(DEFAULT_THEME);
            setGridIntensity(GRID_INTENSITY_DEFAULT);
          }}
        >
          {t("transport.settingsModal.themeReset", { defaultValue: "Restore default theme" })}
        </button>
      </div>
    </SettingsTabSection>
  );
}

function SliderField({
  id,
  label,
  help,
  min,
  max,
  step,
  value,
  onChange,
  onReset,
}: {
  id: string;
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  onReset: () => void;
}) {
  return (
    <div className="lt-settings-field">
      <span className="lt-settings-field-label" id={`${id}-label`}>
        {label}
      </span>
      <div className="lt-settings-slider-row">
        <input
          className="lt-fader"
          type="range"
          aria-labelledby={`${id}-label`}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          onDoubleClick={onReset}
        />
        <output className="lt-settings-slider-value" aria-live="polite">
          {Math.round(value * 100)} %
        </output>
      </div>
      <small>{help}</small>
    </div>
  );
}
