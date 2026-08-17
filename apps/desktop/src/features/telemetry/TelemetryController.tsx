import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";

import { isTauriApp } from "../transport/desktopApi";
import { submitAppSession, useTelemetryStore } from "./telemetry";

type Props = {
  version: string;
};

const PRIVACY_URL = "https://libretracks.pages.dev/privacy/";

export function TelemetryController({ version }: Props) {
  const { t } = useTranslation();
  const preference = useTelemetryStore((state) => state.preference);
  const setPreference = useTelemetryStore((state) => state.setPreference);
  const isWebDriver =
    typeof navigator !== "undefined" && navigator.webdriver === true;
  const activeInThisBuild =
    isTauriApp && Boolean(version) && !import.meta.env.DEV && !isWebDriver;

  useEffect(() => {
    if (!activeInThisBuild || preference !== "enabled") return;
    void submitAppSession(version);
  }, [activeInThisBuild, preference, version]);

  if (!activeInThisBuild || preference !== "undecided") return null;

  return (
    <div className="lt-modal-backdrop lt-telemetry-backdrop">
      <section
        className="lt-telemetry-consent"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-telemetry-title"
      >
        <span className="lt-settings-modal-eyebrow">
          {t("telemetry.eyebrow", { defaultValue: "Privacy" })}
        </span>
        <h2 id="lt-telemetry-title">
          {t("telemetry.title", { defaultValue: "Help improve LibreTracks" })}
        </h2>
        <p>
          {t("telemetry.description", {
            defaultValue:
              "Allow optional usage statistics: app starts and their UTC time, app version, broad device platform and country inferred by Cloudflare from the network connection. LibreTracks never sends precise location, projects, audio, file names, paths or connected hardware.",
          })}
        </p>
        <p className="lt-telemetry-detail">
          {t("telemetry.detail", {
            defaultValue:
              "A random secret stays on this device. Only a token that changes every day is sent, so it cannot build a long-term device history.",
          })}
        </p>
        <div className="lt-telemetry-actions">
          <button
            type="button"
            className="lt-primary-button"
            onClick={() => setPreference("enabled")}
          >
            {t("telemetry.allow", { defaultValue: "Allow usage statistics" })}
          </button>
          <button
            type="button"
            className="lt-secondary-button"
            onClick={() => setPreference("disabled")}
          >
            {t("telemetry.decline", { defaultValue: "No, thanks" })}
          </button>
          <button
            type="button"
            className="lt-telemetry-policy-link"
            onClick={() => void openUrl(PRIVACY_URL).catch(() => undefined)}
          >
            {t("telemetry.policy", { defaultValue: "Read privacy policy" })}
          </button>
        </div>
      </section>
    </div>
  );
}

export function TelemetrySettingsField() {
  const { t } = useTranslation();
  const preference = useTelemetryStore((state) => state.preference);
  const setPreference = useTelemetryStore((state) => state.setPreference);

  return (
    <label className="lt-settings-toggle">
      <input
        type="checkbox"
        checked={preference === "enabled"}
        onChange={(event) =>
          setPreference(event.target.checked ? "enabled" : "disabled")
        }
      />
      <span className="lt-settings-toggle-copy">
        <span>
          {t("telemetry.setting", { defaultValue: "Optional usage statistics" })}
        </span>
        <small>
          {t("telemetry.settingHint", {
            defaultValue:
              "Share app starts, UTC time, version, broad device platform and country. No precise location, project, audio or hardware information is sent.",
          })}
        </small>
      </span>
    </label>
  );
}
