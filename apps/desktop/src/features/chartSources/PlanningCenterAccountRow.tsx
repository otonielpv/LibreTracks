import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { FEATURE_FLAGS } from "@libretracks/shared/featureFlags";

import { chartSourceHandlers } from "./chartSourceHandlers";
import { useChartSourceStore } from "./chartSourceStore";
import { pcoErrorMessage } from "./pcoErrors";
import { usePlanImportStore } from "./planImportStore";
import { useChartSourcesAvailable } from "./useChartSourcesAvailable";

/**
 * The Planning Center account, as one more row of the cloud panel's accounts
 * (D16). Hidden behind `FEATURE_FLAGS.chartSources` and when the build cannot
 * sign in.
 */
export function PlanningCenterAccountRow() {
  if (!FEATURE_FLAGS.chartSources) return null;
  return <AccountRow />;
}

function AccountRow() {
  const { t } = useTranslation();
  const status = useChartSourceStore((state) => state.status);
  const connecting = useChartSourceStore((state) => state.connecting);
  const error = useChartSourceStore((state) => state.error);
  const available = useChartSourcesAvailable();

  useEffect(() => {
    void chartSourceHandlers.refreshStatus();
  }, []);

  if (!status?.configured) return null;
  const state = status.state;
  const label =
    state === "connected"
      ? status.account
        ? t("chartSources.account.accountLabel", status.account)
        : t("chartSources.account.connected")
      : state === "expired"
        ? t("chartSources.account.expired")
        : t("chartSources.account.notConnected");
  const problem = pcoErrorMessage(t, status.error ?? error);

  return (
    <li className="lt-cloud-account" data-testid="pco-account">
      <span className="lt-cloud-account-name">
        <span className="material-symbols-outlined lt-provider-glyph" aria-hidden="true">
          library_music
        </span>
        <span>
          {t("chartSources.account.name")}
          <span className="lt-cloud-account-state">{label}</span>
          {problem ? (
            <span className="lt-cloud-account-state" role="alert">
              {problem}
            </span>
          ) : null}
        </span>
      </span>
      <span className="lt-cloud-account-actions">
        {state === "connected" && available ? (
          <button type="button" className="lt-ghost-button" onClick={() => usePlanImportStore.getState().show()}>
            <span className="material-symbols-outlined" aria-hidden="true">
              event_note
            </span>
            {t("chartSources.plan.open")}
          </button>
        ) : null}
        {state === "connected" ? (
          <button type="button" className="lt-ghost-button" onClick={() => void chartSourceHandlers.disconnect()}>
            <span className="material-symbols-outlined" aria-hidden="true">
              logout
            </span>
            {t("chartSources.account.disconnect")}
          </button>
        ) : (
          <button
            type="button"
            className="lt-ghost-button"
            disabled={connecting}
            onClick={() => void chartSourceHandlers.connect()}
          >
            {connecting
              ? t("chartSources.account.connecting")
              : state === "expired"
                ? t("chartSources.account.reconnect")
                : t("chartSources.account.connect")}
          </button>
        )}
      </span>
    </li>
  );
}
