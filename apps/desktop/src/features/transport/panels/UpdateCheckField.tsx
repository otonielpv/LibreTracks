import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { isMobileApp } from "@libretracks/shared/desktopApi";
import { isNewerVersion, normalizeVersion } from "../../../shared/updateCheck";
import {
  openUpdateModal,
  runUpdateCheck,
  useUpdateCheckStore,
} from "../../updates/updateCheckStore";
import { formatUserFacingError } from "../errors/formatTransportError";

/** Self-contained manual update control used by Settings -> General. */
export function UpdateCheckField() {
  const { t } = useTranslation();
  const { release, error, isChecking, hasCheckedOnce } = useUpdateCheckStore();
  if (isMobileApp) return null;

  const current = normalizeVersion(
    typeof window !== "undefined"
      ? (window as { __LT_APP_VERSION__?: string }).__LT_APP_VERSION__ ?? ""
      : "",
  );
  const remoteIsNewer =
    release && current ? isNewerVersion(release.version, current) : false;

  let statusLine: ReactNode = null;
  if (error) {
    statusLine = (
      <small className="lt-update-check-status lt-update-check-status--error">
        {t("update.checkError", {
          message: formatUserFacingError(error, t),
        })}
      </small>
    );
  } else if (release && remoteIsNewer) {
    statusLine = (
      <small className="lt-update-check-status lt-update-check-status--new">
        {t("update.available", { version: release.version })}{" "}
        <button
          type="button"
          className="lt-update-check-link"
          onClick={openUpdateModal}
        >
          {t("update.viewDetails")}
        </button>
      </small>
    );
  } else if (hasCheckedOnce && current) {
    statusLine = (
      <small className="lt-update-check-status">
        {t("update.upToDate", { version: current })}
      </small>
    );
  }

  return (
    <div className="lt-settings-field">
      <span className="lt-settings-field-label">{t("update.checkNow")}</span>
      <button
        type="button"
        className="lt-secondary-button"
        disabled={isChecking}
        onClick={() => void runUpdateCheck({ force: true })}
      >
        {isChecking ? t("update.checking") : t("update.checkNow")}
      </button>
      {statusLine}
    </div>
  );
}
