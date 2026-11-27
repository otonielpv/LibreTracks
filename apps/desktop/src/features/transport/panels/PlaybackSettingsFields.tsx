import type { AppSettings } from "@libretracks/shared/models";
import { useTranslation } from "react-i18next";
import { NumberInput } from "../../../shared/NumberInput";

type PlaybackSettingsFieldsProps = {
  settings: Pick<AppSettings, "pauseAtSongEnd" | "vampBetweenSongs" | "fadeOutStopSeconds" | "fadeOutPause">;
  disabled: boolean;
  onPauseAtSongEndChange: (value: boolean) => void;
  onVampBetweenSongsChange: (value: boolean) => void;
  onFadeOutStopSecondsChange: (value: number) => void;
  onFadeOutPauseChange: (value: boolean) => void;
};

export function PlaybackSettingsFields({
  settings,
  disabled,
  onPauseAtSongEndChange,
  onVampBetweenSongsChange,
  onFadeOutStopSecondsChange,
  onFadeOutPauseChange,
}: PlaybackSettingsFieldsProps) {
  const { t } = useTranslation();
  return (
    <>
      <label className="lt-settings-toggle">
        <input
          type="checkbox"
          checked={settings.pauseAtSongEnd}
          disabled={disabled}
          onChange={(event) => onPauseAtSongEndChange(event.target.checked)}
        />
        <span className="lt-settings-toggle-copy">
          <span>
            {t("transport.settingsModal.pauseAtSongEnd", {
              defaultValue: "Pause at the end of each song",
            })}
          </span>
          <small>
            {t("transport.settingsModal.pauseAtSongEndHint", {
              defaultValue:
                "Playback stops when a song ends instead of rolling straight into the next one. Press Play to start the next song. A song jump you queued still happens.",
            })}
          </small>
        </span>
      </label>
      <label className="lt-settings-toggle">
        <input
          type="checkbox"
          checked={settings.vampBetweenSongs}
          disabled={disabled}
          onChange={(event) => onVampBetweenSongsChange(event.target.checked)}
        />
        <span className="lt-settings-toggle-copy">
          <span>{t("transport.settingsModal.vampBetweenSongs")}</span>
          <small>{t("transport.settingsModal.vampBetweenSongsHint")}</small>
        </span>
      </label>
      <label className="lt-settings-field">
        <span className="lt-settings-field-label">{t("transport.settingsModal.fadeOutAction")}</span>
        <select
          value={settings.fadeOutPause ? "pause" : "stop"}
          disabled={disabled}
          onChange={(event) => onFadeOutPauseChange(event.target.value === "pause")}
        >
          <option value="pause">{t("transport.settingsModal.fadeOutActionPause")}</option>
          <option value="stop">{t("transport.settingsModal.fadeOutActionStop")}</option>
        </select>
        <small>{t("transport.settingsModal.fadeOutActionHint")}</small>
      </label>
      <label className="lt-settings-field">
        <span className="lt-settings-field-label">
          {t("transport.settingsModal.fadeOutStopSeconds")}
        </span>
        <NumberInput
          min={0.1}
          max={30}
          step={0.5}
          value={settings.fadeOutStopSeconds}
          disabled={disabled}
          onChange={onFadeOutStopSecondsChange}
        />
        <small>{t("transport.settingsModal.fadeOutStopSecondsHint")}</small>
      </label>
    </>
  );
}
