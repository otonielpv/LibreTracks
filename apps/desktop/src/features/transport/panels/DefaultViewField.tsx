import { useState } from "react";
import { useTranslation } from "react-i18next";

import { isViewMode, readStoredDefaultViewMode, storeDefaultViewMode } from "../defaultViewMode";
import { DEFAULT_VIEW_MODE, VIEW_MODE_CYCLE, type ViewMode } from "../uiStore";

const VIEW_NAME_KEYS: Record<ViewMode, string> = {
  daw: "liveView.daw",
  setlist: "liveView.setlistView",
  compact: "liveView.compact",
  live: "liveView.live",
};

/** La vista en la que se abren las sesiones. No cambia la vista actual. */
export function DefaultViewField() {
  const { t } = useTranslation();
  const [value, setValue] = useState<ViewMode>(() =>
    readStoredDefaultViewMode(DEFAULT_VIEW_MODE),
  );

  return (
    <label className="lt-settings-field">
      <span className="lt-settings-field-label">
        {t("transport.settingsModal.defaultView", { defaultValue: "Startup view" })}
      </span>
      <select
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          if (!isViewMode(next)) return;
          setValue(next);
          storeDefaultViewMode(next);
        }}
      >
        {VIEW_MODE_CYCLE.map((mode) => (
          <option key={mode} value={mode}>
            {t(VIEW_NAME_KEYS[mode])}
          </option>
        ))}
      </select>
      <small>
        {t("transport.settingsModal.defaultViewHelp", {
          defaultValue: "The view sessions open in.",
        })}
      </small>
    </label>
  );
}
