import { useEffect } from "react";

import { shouldRunAutoCheck } from "../../shared/updateCheck";
import {
  closeUpdateModal,
  runUpdateCheck,
  setCurrentVersion,
  useUpdateCheckStore,
  type UpdateCheckSnapshot,
} from "./updateCheckStore";

export type UseUpdateCheckOptions = {
  currentVersion: string;
  enabled?: boolean;
};

export type UseUpdateCheckResult = UpdateCheckSnapshot & {
  dismiss: () => void;
};

export function useUpdateCheck({
  currentVersion,
  enabled = true,
}: UseUpdateCheckOptions): UseUpdateCheckResult {
  const snapshot = useUpdateCheckStore();

  useEffect(() => {
    setCurrentVersion(currentVersion);
  }, [currentVersion]);

  useEffect(() => {
    if (!enabled || !currentVersion) return;
    if (!shouldRunAutoCheck()) return;
    // Fire as soon as the app has its version — no artificial delay — so the
    // popup shows the moment the app starts (only the GitHub fetch latency
    // remains). setCurrentVersion runs synchronously here too, guarding the
    // store's empty-version early return in case effect ordering ever shifts.
    setCurrentVersion(currentVersion);
    void runUpdateCheck();
  }, [enabled, currentVersion]);

  return { ...snapshot, dismiss: closeUpdateModal };
}
