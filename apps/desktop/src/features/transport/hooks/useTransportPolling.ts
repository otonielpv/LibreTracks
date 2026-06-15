import { useEffect } from "react";
import type { TransportSnapshot } from "@libretracks/shared/models";
import { getTransportSnapshot, isTauriApp } from "../desktopApi";
import {
  recordSnapshotCommitGap,
  recordSnapshotIpc,
} from "../perf/perfMetrics";

const PLAYING_POLL_INTERVAL_MS = 250;
const IDLE_POLL_INTERVAL_MS = 800;
// While pitch preparation is in flight (transpose just applied, prearm worker
// rebuilding voices in the background), poll fast so the overlay dismisses
// promptly the moment the work completes. Without this the user sees the
// overlay linger up to ~800ms past the actual completion in idle state.
const PITCH_PREPARING_POLL_INTERVAL_MS = 100;
// Same fast cadence while audio sources are being prepared, so the global
// "Preparing audio…" indicator's percent/track-count updates smoothly.
const SOURCES_PREPARING_POLL_INTERVAL_MS = 100;
const SLOW_POLL_THRESHOLD_MS = 120;
const SLOW_POLL_BACKOFF_MS = 750;

function isSyncDebugAvailable() {
  if (import.meta.env.DEV) return true;
  return Boolean(
    (window as unknown as { __LT_DEBUG_BUILD?: boolean }).__LT_DEBUG_BUILD,
  );
}

type UseTransportPollingProps = {
  playbackState: string;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  pitchPreparing?: boolean;
  sourcesPreparing?: boolean;
};

export function useTransportPolling({
  playbackState,
  applyPlaybackSnapshot,
  pitchPreparing = false,
  sourcesPreparing = false,
}: UseTransportPollingProps) {
  useEffect(() => {
    if (!isTauriApp) {
      return;
    }

    let active = true;
    let inFlight = false;
    let timeoutId: number | null = null;

    const clearScheduledRefresh = () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const scheduleRefresh = (delayMs: number) => {
      clearScheduledRefresh();
      if (!active) {
        return;
      }

      timeoutId = window.setTimeout(() => {
        timeoutId = null;
        void refreshSnapshot();
      }, delayMs);
    };

    const basePollInterval =
      pitchPreparing || sourcesPreparing
        ? Math.min(
            PITCH_PREPARING_POLL_INTERVAL_MS,
            SOURCES_PREPARING_POLL_INTERVAL_MS,
          )
        : playbackState === "playing"
          ? PLAYING_POLL_INTERVAL_MS
          : IDLE_POLL_INTERVAL_MS;

    const refreshSnapshot = async () => {
      if (!active || inFlight) {
        return;
      }

      inFlight = true;
      const ipcStartedAt = performance.now();
      try {
        const nextSnapshot = await getTransportSnapshot();
        const ipcEndedAt = performance.now();
        const ipcDurationMs = ipcEndedAt - ipcStartedAt;
        recordSnapshotIpc(ipcDurationMs);
        if (!active) {
          return;
        }

        applyPlaybackSnapshot(nextSnapshot);
        // Measured from the moment the snapshot landed in JS to right
        // after the synchronous setState call returns. Doesn't account
        // for the React commit phase, but everything beyond that is
        // visible in the frame-time metric instead.
        recordSnapshotCommitGap(performance.now() - ipcEndedAt);

        // Sync instrumentation — opt-in via window.__LT_SYNC_DEBUG = true.
        if (
          isSyncDebugAvailable() &&
          (window as unknown as { __LT_SYNC_DEBUG?: boolean })
            .__LT_SYNC_DEBUG &&
          nextSnapshot?.playbackState === "playing"
        ) {
          // eslint-disable-next-line no-console
          console.log(
            `[SNAP_UI] wall_ms=${Date.now()} perf_ms=${performance.now().toFixed(1)} pos_s=${nextSnapshot.positionSeconds.toFixed(4)} anchor_s=${nextSnapshot.transportClock?.anchorPositionSeconds ?? "n/a"}`,
          );
        }
        const nextDelayMs =
          ipcDurationMs >= SLOW_POLL_THRESHOLD_MS
            ? Math.max(basePollInterval, SLOW_POLL_BACKOFF_MS)
            : basePollInterval;
        scheduleRefresh(nextDelayMs);
      } finally {
        inFlight = false;
        if (active && timeoutId === null) {
          scheduleRefresh(basePollInterval);
        }
      }
    };

    void refreshSnapshot();

    return () => {
      active = false;
      clearScheduledRefresh();
    };
  }, [applyPlaybackSnapshot, playbackState, pitchPreparing, sourcesPreparing]);
}
