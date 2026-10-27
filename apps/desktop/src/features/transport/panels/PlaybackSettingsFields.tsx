import type { AppSettings } from "@libretracks/shared/models";
import { useTranslation } from "react-i18next";

type PlaybackSettingsFieldsProps = {
  settings: Pick<AppSettings, "pauseAtSongEnd" | "vampBetweenSongs" | "fadeOutStopSeconds">;
  disabled: boolean;
  onPauseAtSongEndChange: (value: boolean) => void;
  onVampBetweenSongsChange: (value: boolean) => void;
  onFadeOutStopSecondsChange: (value: number) => void;
};

export function PlaybackSettingsFields({
  settings,
  disabled,
  onPauseAtSongEndChange,
  onVampBetweenSongsChange,
  onFadeOutStopSecondsChange,
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
        <span className="lt-settings-field-label">
          {t("transport.settingsModal.fadeOutStopSeconds")}
        </span>
        <input
          type="number"
          min={0.1}
          max={30}
          step={0.5}
          value={settings.fadeOutStopSeconds}
          disabled={disabled}
          onChange={(event) => {
            const seconds = Number(event.target.value);
            if (Number.isFinite(seconds) && seconds > 0) onFadeOutStopSecondsChange(seconds);
          }}
        />
        <small>{t("transport.settingsModal.fadeOutStopSecondsHint")}</small>
      </label>
    </>
  );
}
