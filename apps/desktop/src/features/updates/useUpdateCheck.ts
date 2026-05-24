import { useEffect } from "react";

import { shouldRunAutoCheck } from "../../shared/updateCheck";
import {
  closeUpdateModal,
  runUpdateCheck,
  setCurrentVersion,
  useUpdateCheckStore,
  type UpdateCheckSnapshot,
} from "./updateCheckStore";

const INITIAL_CHECK_DELAY_MS = 5000;

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
    const timer = window.setTimeout(() => {
      void runUpdateCheck();
    }, INITIAL_CHECK_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [enabled, currentVersion]);

  return { ...snapshot, dismiss: closeUpdateModal };
}
