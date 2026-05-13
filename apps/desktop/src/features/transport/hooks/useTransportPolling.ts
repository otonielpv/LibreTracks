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
      } finally {
        inFlight = false;
      }
    };

    const intervalId = window.setInterval(
      () => {
        void refreshSnapshot();
      },
      playbackState === "playing" ? 120 : 500,
    );

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [applyPlaybackSnapshot, playbackState]);
}
