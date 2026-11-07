import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { FEATURE_FLAGS } from "@libretracks/shared/featureFlags";

import { selectMainName, selectTransportLocked, useRedundancyStore } from "./redundancyStore";

/**
 * Transport buttons on a backup that follows its main: they look disabled
 * (lock + tooltip) and a press only shows a short notice. The backend
 * refuses the order anyway; this is the courtesy in the UI.
 */
export function useTransportGuard() {
  const { t } = useTranslation();
  const lockedInStore = useRedundancyStore(selectTransportLocked);
  const mainName = useRedundancyStore(selectMainName);
  const showNotice = useRedundancyStore((state) => state.showNotice);
  const locked = FEATURE_FLAGS.redundancy && lockedInStore;
  const lockTitle = locked
    ? t("redundancy.lockedTooltip", { name: mainName ?? t("redundancy.theMain") })
    : undefined;
  const guard = useCallback(
    (action: () => void) => () => {
      if (locked) {
        showNotice(t("redundancy.lockedNotice", { name: mainName ?? t("redundancy.theMain") }));
        return;
      }
      action();
    },
    [locked, mainName, showNotice, t],
  );
  return { locked, lockTitle, guard };
}
