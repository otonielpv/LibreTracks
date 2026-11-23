import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { chartSourceHandlers } from "./chartSourceHandlers";
import { useChartSourceStore } from "./chartSourceStore";
import { usePlanImportStore } from "./planImportStore";
import { useChartSourcesAvailable } from "./useChartSourcesAvailable";

/**
 * "Import a plan…" in the Setlist's song toolbar (step 09: the batch starts
 * from the setlist). Only with the Planning Center account connected.
 */
export function PlanImportButton({ className }: { className?: string }) {
  const available = useChartSourcesAvailable();
  if (!available) return null;
  return <Button className={className} />;
}

function Button({ className }: { className?: string }) {
  const { t } = useTranslation();
  const status = useChartSourceStore((state) => state.status);
  useEffect(() => {
    // Read once per app run; the account row and the dialogs keep it fresh.
    if (useChartSourceStore.getState().status === null) void chartSourceHandlers.refreshStatus();
  }, []);
  if (status?.state !== "connected") return null;
  return (
    <button
      type="button"
      className={className}
      title={t("chartSources.plan.open")}
      aria-label={t("chartSources.plan.open")}
      onClick={() => usePlanImportStore.getState().show()}
    >
      <span className="material-symbols-outlined" aria-hidden="true">
        event_note
      </span>
    </button>
  );
}
