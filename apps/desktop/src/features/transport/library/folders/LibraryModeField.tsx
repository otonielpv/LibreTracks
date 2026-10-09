import { useTranslation } from "react-i18next";

import { useLibrarySettings } from "./useLibrarySettings";

/**
 * Settings → General: go back to the classic library (the session's imported
 * assets with virtual folders) for whoever prefers it.
 */
export function LibraryModeField() {
  const { t } = useTranslation();
  const { mode, setMode } = useLibrarySettings();

  return (
    <label className="lt-settings-toggle">
      <input
        type="checkbox"
        checked={mode === "classic"}
        onChange={(event) => void setMode(event.target.checked ? "classic" : "folders")}
      />
      <span className="lt-settings-toggle-copy">
        <span>{t("transport.settingsModal.classicLibrary")}</span>
        <small>{t("transport.settingsModal.classicLibraryHint")}</small>
      </span>
    </label>
  );
}
