import { useCallback, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { ClipSummary, SongView, TransportSnapshot } from "@libretracks/shared/models";
import {
  moveClipLive,
  updateTrack,
  updateTrackMixLive,
} from "../desktopApi";
import { useTransportStore, type OptimisticMixState } from "../store";
import { clamp, findTrack } from "../helpers";
import { LIVE_TRACK_MIX_MIN_INTERVAL_MS } from "../constants";
import type {
  ClipDragState,
  LiveClipMoveState,
  LiveTrackMixRequestState,
  OptimisticClipOperation,
} from "../types";

type UseMixControllerProps = {
  songRef: MutableRefObject<SongView | null>;
  clipDragRef: MutableRefObject<ClipDragState>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot) => void;
  formatErrorStatus: (error: unknown) => string;
  setStatus: (status: string) => void;
};

export function useMixController({
  songRef,
  clipDragRef,
  applyPlaybackSnapshot,
  formatErrorStatus,
  setStatus,
}: UseMixControllerProps) {
  const [optimisticClipOperations, setOptimisticClipOperations] = useState<
    OptimisticClipOperation[]
  >([]);
  const clipMoveLiveStatesRef = useRef<Record<string, LiveClipMoveState>>({});
  const trackMixRequestIdsRef = useRef<Record<string, number>>({});
  const trackMixLiveStatesRef = useRef<
    Record<string, LiveTrackMixRequestState>
  >({});
  const clipPreviewSecondsRef = useRef<Record<string, number>>({});

  const getTrackOptimisticMix = useCallback((trackId: string) => {
    return useTransportStore.getState().optimisticMix[trackId] ?? {};
  }, []);

  const setTrackOptimisticMix = useCallback(
    (trackId: string, nextMix: OptimisticMixState) => {
      useTransportStore
        .getState()
        .setOptimisticMix(
          trackId,
          Object.keys(nextMix).length ? nextMix : null,
        );
    },
    [],
  );

  const patchTrackOptimisticMix = useCallback(
    (trackId: string, mixPatch: OptimisticMixState) => {
      setTrackOptimisticMix(trackId, {
        ...getTrackOptimisticMix(trackId),
        ...mixPatch,
      });
    },
    [getTrackOptimisticMix, setTrackOptimisticMix],
  );

  const clearTrackOptimisticMixKeys = useCallback(
    (trackId: string, keys: Array<keyof OptimisticMixState>) => {
      const currentMix = getTrackOptimisticMix(trackId);
      if (!Object.keys(currentMix).length) {
        return;
      }

      const nextMix = { ...currentMix };
      for (const key of keys) {
        delete nextMix[key];
      }

      setTrackOptimisticMix(trackId, nextMix);
    },
    [getTrackOptimisticMix, setTrackOptimisticMix],
  );

  const startOptimisticClipOperation = useCallback((clips: ClipSummary[]) => {
    const operationId = `optimistic-clip-op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setOptimisticClipOperations((current) => [
      ...current,
      {
        id: operationId,
        clearAfterProjectRevision: null,
        clips,
      },
    ]);
    return operationId;
  }, []);

  const completeOptimisticClipOperation = useCallback(
    (operationId: string, projectRevision: number) => {
      setOptimisticClipOperations((current) =>
        current.map((operation) =>
          operation.id === operationId
            ? {
                ...operation,
                clearAfterProjectRevision: projectRevision,
              }
            : operation,
        ),
      );
    },
    [],
  );

  const discardOptimisticClipOperation = useCallback(
    (operationId: string) => {
      setOptimisticClipOperations((current) =>
        current.filter((operation) => operation.id !== operationId),
      );
    },
    [],
  );

  const resolveTrackMix = useCallback(
    (track: { muted: boolean; solo: boolean; volume: number; pan: number }, trackId: string) => {
      const optimisticMix = getTrackOptimisticMix(trackId);
      return {
        muted: optimisticMix.muted ?? track.muted,
        solo: optimisticMix.solo ?? track.solo,
        volume: clamp(optimisticMix.volume ?? track.volume, 0, 1),
        pan: clamp(optimisticMix.pan ?? track.pan, -1, 1),
      };
    },
    [getTrackOptimisticMix],
  );

  const nextTrackMixRequestId = useCallback((trackId: string) => {
    const nextRequestId = (trackMixRequestIdsRef.current[trackId] ?? 0) + 1;
    trackMixRequestIdsRef.current[trackId] = nextRequestId;
    return nextRequestId;
  }, []);

  const persistTrackMix = useCallback(
    async (trackId: string, keys: Array<keyof OptimisticMixState>) => {
      const track = findTrack(songRef.current, trackId);
      if (!track) {
        clearTrackOptimisticMixKeys(trackId, keys);
        return;
      }

      const resolvedMix = resolveTrackMix(track, trackId);
      const payload: {
        trackId: string;
        muted?: boolean;
        solo?: boolean;
        volume?: number;
        pan?: number;
      } = {
        trackId,
      };

      if (keys.includes("muted") && resolvedMix.muted !== track.muted) {
        payload.muted = resolvedMix.muted;
      }
      if (keys.includes("solo") && resolvedMix.solo !== track.solo) {
        payload.solo = resolvedMix.solo;
      }
      if (
        keys.includes("volume") &&
        Math.abs(resolvedMix.volume - track.volume) >= 0.0001
      ) {
        payload.volume = resolvedMix.volume;
      }
      if (
        keys.includes("pan") &&
        Math.abs(resolvedMix.pan - track.pan) >= 0.0001
      ) {
        payload.pan = resolvedMix.pan;
      }

      if (Object.keys(payload).length === 1) {
        clearTrackOptimisticMixKeys(trackId, keys);
        return;
      }

      const requestId = nextTrackMixRequestId(trackId);

      try {
        const nextSnapshot = await updateTrack(payload);
        if (trackMixRequestIdsRef.current[trackId] === requestId) {
          applyPlaybackSnapshot(nextSnapshot);
        }
      } catch (error) {
        if (trackMixRequestIdsRef.current[trackId] === requestId) {
          clearTrackOptimisticMixKeys(trackId, keys);
        }
        throw error;
      }
    },
    [
      applyPlaybackSnapshot,
      clearTrackOptimisticMixKeys,
      nextTrackMixRequestId,
      resolveTrackMix,
      songRef,
    ],
  );

  const flushTrackMixLiveUpdates = useCallback(
    async (trackId: string) => {
      const liveStates = trackMixLiveStatesRef.current;
      const liveState = liveStates[trackId];
      if (!liveState || liveState.inFlight) {
        return;
      }

      liveState.inFlight = true;

      try {
        while (liveState.queuedKeys.size > 0) {
          const now = performance.now();
          const remainingDelay =
            LIVE_TRACK_MIX_MIN_INTERVAL_MS - (now - liveState.lastSentAt);
          if (remainingDelay > 0) {
            await new Promise<void>((resolve) => {
              window.setTimeout(resolve, remainingDelay);
            });
          }

          const keys = [...liveState.queuedKeys];
          liveState.queuedKeys.clear();

          const track = findTrack(songRef.current, trackId);
          if (!track) {
            clearTrackOptimisticMixKeys(trackId, keys);
            continue;
          }

          const resolvedMix = resolveTrackMix(track, trackId);
          const payload: {
            trackId: string;
            muted?: boolean;
            solo?: boolean;
            volume?: number;
            pan?: number;
          } = {
            trackId,
          };

          if (keys.includes("muted")) {
            payload.muted = resolvedMix.muted;
          }
          if (keys.includes("solo")) {
            payload.solo = resolvedMix.solo;
          }
          if (keys.includes("volume")) {
            payload.volume = resolvedMix.volume;
          }
          if (keys.includes("pan")) {
            payload.pan = resolvedMix.pan;
          }

          await updateTrackMixLive(payload);
          liveState.lastSentAt = performance.now();
        }
      } finally {
        liveState.inFlight = false;
        if (liveState.queuedKeys.size > 0) {
          void flushTrackMixLiveUpdates(trackId);
          return;
        }

        delete liveStates[trackId];
      }
    },
    [clearTrackOptimisticMixKeys, resolveTrackMix, songRef],
  );

  const queueTrackMixLiveUpdate = useCallback(
    (trackId: string, keys: Array<keyof OptimisticMixState>) => {
      const liveStates = trackMixLiveStatesRef.current;
      const liveState = liveStates[trackId] ?? {
        inFlight: false,
        queuedKeys: new Set<keyof OptimisticMixState>(),
        lastSentAt: 0,
      };

      liveStates[trackId] = liveState;
      for (const key of keys) {
        liveState.queuedKeys.add(key);
      }

      void flushTrackMixLiveUpdates(trackId).catch((error) => {
        clearTrackOptimisticMixKeys(trackId, [
          "muted",
          "solo",
          "volume",
          "pan",
        ]);
        delete trackMixLiveStatesRef.current[trackId];
        setStatus(formatErrorStatus(error));
      });
    },
    [clearTrackOptimisticMixKeys, flushTrackMixLiveUpdates, formatErrorStatus, setStatus],
  );

  const flushClipMoveLiveUpdates = useCallback(async (clipId: string) => {
    const liveStates = clipMoveLiveStatesRef.current;
    const liveState = liveStates[clipId];
    if (!liveState || liveState.inFlight) {
      return;
    }

    liveState.inFlight = true;

    try {
      while (liveState.queuedSeconds !== null) {
        const queuedSeconds = liveState.queuedSeconds;
        liveState.queuedSeconds = null;
        await moveClipLive(clipId, queuedSeconds);
      }
    } finally {
      liveState.inFlight = false;
      if (liveState.queuedSeconds !== null) {
        void flushClipMoveLiveUpdates(clipId);
        return;
      }

      delete liveStates[clipId];
      if (clipDragRef.current?.clipId !== clipId) {
        clipPreviewSecondsRef.current = {};
      }
    }
  }, [clipDragRef]);

  const queueClipMoveLiveUpdate = useCallback(
    (clipId: string, previewSeconds: number) => {
      const liveStates = clipMoveLiveStatesRef.current;
      const liveState = liveStates[clipId] ?? {
        inFlight: false,
        queuedSeconds: null,
      };

      liveState.queuedSeconds = previewSeconds;
      liveStates[clipId] = liveState;

      void flushClipMoveLiveUpdates(clipId).catch((error) => {
        delete clipMoveLiveStatesRef.current[clipId];
        if (clipDragRef.current?.clipId !== clipId) {
          clipPreviewSecondsRef.current = {};
        }
        setStatus(formatErrorStatus(error));
      });
    },
    [clipDragRef, flushClipMoveLiveUpdates, formatErrorStatus, setStatus],
  );

  const waitForClipMoveLiveIdle = useCallback((clipId: string) => {
    return new Promise<void>((resolve) => {
      const tick = () => {
        const liveState = clipMoveLiveStatesRef.current[clipId];
        if (!liveState) {
          resolve();
          return;
        }

        window.setTimeout(tick, 0);
      };

      tick();
    });
  }, []);

  return {
    optimisticClipOperations,
    setOptimisticClipOperations,
    clipMoveLiveStatesRef,
    trackMixRequestIdsRef,
    trackMixLiveStatesRef,
    clipPreviewSecondsRef,
    getTrackOptimisticMix,
    setTrackOptimisticMix,
    patchTrackOptimisticMix,
    clearTrackOptimisticMixKeys,
    startOptimisticClipOperation,
    completeOptimisticClipOperation,
    discardOptimisticClipOperation,
    resolveTrackMix,
    nextTrackMixRequestId,
    persistTrackMix,
    flushTrackMixLiveUpdates,
    queueTrackMixLiveUpdate,
    flushClipMoveLiveUpdates,
    queueClipMoveLiveUpdate,
    waitForClipMoveLiveIdle,
  };
}
