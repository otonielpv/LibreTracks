import { useEffect } from "react";
import type { TransportSnapshot } from "@libretracks/shared/models";
import { getTransportSnapshot, isTauriApp } from "../desktopApi";

type UseTransportPollingProps = {
  playbackState: string;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
};

export function useTransportPolling({
  playbackState,
  applyPlaybackSnapshot,
}: UseTransportPollingProps) {
  useEffect(() => {
    if (!isTauriApp) {
      return;
    }

    let active = true;
    let inFlight = false;

    const refreshSnapshot = async () => {
      if (!active || inFlight) {
        return;
      }

      inFlight = true;
      try {
        const nextSnapshot = await getTransportSnapshot();
        if (!active) {
          return;
        }

        applyPlaybackSnapshot(nextSnapshot);

        // Sync instrumentation — opt-in via window.__LT_SYNC_DEBUG = true.
        if (
          (window as unknown as { __LT_SYNC_DEBUG?: boolean }).__LT_SYNC_DEBUG &&
          nextSnapshot?.playbackState === "playing"
        ) {
          // eslint-disable-next-line no-console
          console.log(
            `[SNAP_UI] wall_ms=${Date.now()} perf_ms=${performance.now().toFixed(1)} pos_s=${nextSnapshot.positionSeconds.toFixed(4)} anchor_s=${nextSnapshot.transportClock?.anchorPositionSeconds ?? "n/a"}`,
          );
        }
      } finally {
        inFlight = false;
      }
    };

    const intervalId = window.setInterval(
      () => {
        void refreshSnapshot();
      },
      playbackState === "playing" ? 60 : 500,
    );

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [applyPlaybackSnapshot, playbackState]);
}
