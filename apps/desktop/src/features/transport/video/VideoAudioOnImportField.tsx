import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { getSettings, saveSettings, type VideoAudioOnImport } from "../desktopApi";

/**
 * Settings → Video: what to do with the sound of a video when it is placed.
 *
 * "Remember my choice" in the question (VideoAudioPrompt) stores this same
 * setting; without this field there was no way back to being asked. It lives
 * in the app settings, not in the video output settings the rest of the tab
 * applies, so it reads and writes them itself, like videoAudioExtraction.ts.
 */
export function VideoAudioOnImportField({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<VideoAudioOnImport>("ask");

  useEffect(() => {
    let cancelled = false;
    void getSettings()
      .then((settings) => {
        if (!cancelled) setMode(settings.videoAudioOnImport ?? "ask");
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const change = async (next: VideoAudioOnImport) => {
    setMode(next);
    try {
      // Read just before writing: the rest of the tab saves other settings.
      const settings = await getSettings();
      await saveSettings({ ...settings, videoAudioOnImport: next });
    } catch {
      // Not saved; the field shows the choice until the tab is reopened.
    }
  };

  return (
    <label className="lt-settings-field">
      <span>{t("transport.video.settings.audioOnImport")}</span>
      <select
        aria-label={t("transport.video.settings.audioOnImport")}
        disabled={disabled}
        value={mode}
        onChange={(event) => void change(event.target.value as VideoAudioOnImport)}
      >
        <option value="ask">{t("transport.video.settings.audioOnImportAsk")}</option>
        <option value="extract">{t("transport.video.settings.audioOnImportExtract")}</option>
        <option value="skip">{t("transport.video.settings.audioOnImportSkip")}</option>
      </select>
      <small>{t("transport.video.settings.audioOnImportHint")}</small>
    </label>
  );
}
