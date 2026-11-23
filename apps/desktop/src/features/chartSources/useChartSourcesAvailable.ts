import { FEATURE_FLAGS } from "@libretracks/shared/featureFlags";

import { isGuestMirrorMode } from "../transport/desktopApi";
import { useRedundancyStore } from "../redundancy/redundancyStore";

/**
 * Whether this app may bring charts from Planning Center into the session.
 * Not a network-session guest (it would write the host's session with this
 * device's account) nor a backup (it follows its main's session).
 */
export function useChartSourcesAvailable(): boolean {
  const backup = useRedundancyStore((state) => state.status?.role === "backup");
  return FEATURE_FLAGS.chartSources && !isGuestMirrorMode() && !backup;
}

/** The same answer outside React (menus built on demand). */
export function chartSourcesAvailableNow(): boolean {
  const backup = useRedundancyStore.getState().status?.role === "backup";
  return FEATURE_FLAGS.chartSources && !isGuestMirrorMode() && !backup;
}
