import { useTranslation } from "react-i18next";
import { MIXER_SIZES, setMixerSize, useMixerSize, type MixerSize } from "../../../shared/mixerSize";
import { UI_ZOOM_STEPS, setUiZoom, useUiZoom } from "../../../shared/uiZoom";
import { DefaultViewField } from "./DefaultViewField";
import { SettingsTabSection } from "./SettingsTabSection";

type Props = {
  selectedLocale: string;
  onLocaleChange: (value: string) => void;
  disabled: boolean;
};

/** Settings › General: language, interface and mixer size, and the view to open in. */
export function GeneralSettingsTab({ selectedLocale, onLocaleChange, disabled }: Props) {
  const { t } = useTranslation();

  return (
    <SettingsTabSection id="general">
      <label className="lt-settings-field">
        <span className="lt-settings-field-label">
          {t("transport.settingsModal.language")}
        </span>
        <select
          value={selectedLocale}
          disabled={disabled}
          onChange={(event) => onLocaleChange(event.target.value)}
        >
          <option value="">
            {t("transport.settingsModal.languageSystemDefault")}
          </option>
          <option value="en">{t("transport.settingsModal.languageEnglish")}</option>
          <option value="es">{t("transport.settingsModal.languageSpanish")}</option>
        </select>
      </label>

      <InterfaceZoomField />

      <MixerSizeField />

      <DefaultViewField />
    </SettingsTabSection>
  );
}

function InterfaceZoomField() {
  const { t } = useTranslation();
  const zoom = useUiZoom();

  return (
    <label className="lt-settings-field">
      <span className="lt-settings-field-label">
        {t("transport.settingsModal.interfaceZoom", {
          defaultValue: "Interface size",
        })}
      </span>
      <select
        value={String(zoom)}
        onChange={(event) => setUiZoom(Number.parseFloat(event.target.value))}
      >
        {UI_ZOOM_STEPS.map((step) => (
          <option key={step} value={String(step)}>
            {`${Math.round(step * 100)}%`}
          </option>
        ))}
      </select>
      <small>
        {t("transport.settingsModal.interfaceZoomHelp", {
          defaultValue:
            "Scale the whole interface. Lower it if the app is wider than your screen. Shortcut: Cmd/Ctrl +, − and 0 to reset.",
        })}
      </small>
    </label>
  );
}

function MixerSizeField() {
  const { t } = useTranslation();
  const size = useMixerSize();

  return (
    <label className="lt-settings-field">
      <span className="lt-settings-field-label">{t("transport.settingsModal.mixerSize")}</span>
      <select value={size} onChange={(event) => setMixerSize(event.target.value as MixerSize)}>
        {MIXER_SIZES.map((option) => (
          <option key={option} value={option}>
            {t(`transport.settingsModal.mixerSize_${option}`)}
          </option>
        ))}
      </select>
      <small>{t("transport.settingsModal.mixerSizeHelp")}</small>
    </label>
  );
}
