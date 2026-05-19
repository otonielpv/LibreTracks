import {
  useEffect,
  useRef,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { TransportClock, TransportSnapshot } from "./desktopApi";
import { useRenderCounter } from "./perf/useRenderCounter";
import { useTransportStore } from "./store";
import {
  clamp,
  clientXToTimelineSeconds,
  secondsToAbsoluteX,
} from "./timelineMath";

function isSyncDebugAvailable() {
  if (import.meta.env.DEV) return true;
  return Boolean(
    (window as unknown as { __LT_DEBUG_BUILD?: boolean }).__LT_DEBUG_BUILD,
  );
}

type PlayheadDragState = {
  pointerId: number;
  currentSeconds: number;
} | null;

type PlayheadOverlayProps = {
  className: string;
  durationSeconds: number;
  pixelsPerSecond: number;
  livePixelsPerSecondRef?: MutableRefObject<number>;
  cameraXRef?: MutableRefObject<number>;
  dragStateRef: MutableRefObject<PlayheadDragState>;
  positionSecondsRef?: MutableRefObject<number>;
  normalizePositionSeconds?: (
    positionSeconds: number,
    options?: { allowSnap?: boolean },
  ) => number;
  onPreviewPositionChange?: (positionSeconds: number) => void;
  onSeekIntent?: (positionSeconds: number) => void;
  onSeekCommit?: (positionSeconds: number) => void | Promise<void>;
  positionBoundsRef?: MutableRefObject<HTMLDivElement | null>;
  scrollContainerRef?: MutableRefObject<HTMLDivElement | null>;
};

type PlaybackSnapshotState = {
  playbackState: TransportSnapshot["playbackState"] | "empty";
  positionSeconds: number;
  transportClock: TransportClock | null;
  anchorReceivedAtMs: number;
};

function resolveClockPositionSeconds(
  playback: PlaybackSnapshotState,
  durationSeconds: number,
) {
  const safeDuration = Math.max(0, durationSeconds);
  const isRunning =
    playback.playbackState === "playing" &&
    Boolean(playback.transportClock?.running);

  if (!isRunning || !playback.transportClock) {
    return clamp(playback.positionSeconds, 0, safeDuration);
  }

  const elapsedSeconds =
    (performance.now() - playback.anchorReceivedAtMs) / 1000;
  return clamp(
    playback.transportClock.anchorPositionSeconds + elapsedSeconds,
    0,
    safeDuration,
  );
}

export function PlayheadOverlay({
  className,
  durationSeconds,
  pixelsPerSecond,
  livePixelsPerSecondRef,
  cameraXRef,
  dragStateRef,
  positionSecondsRef,
  normalizePositionSeconds,
  onPreviewPositionChange,
  onSeekIntent,
  onSeekCommit,
  positionBoundsRef,
  scrollContainerRef,
}: PlayheadOverlayProps) {
  useRenderCounter("PlayheadOverlay");
  const playheadRef = useRef<HTMLDivElement | null>(null);
  const playbackRef = useRef<PlaybackSnapshotState>({
    playbackState: "empty",
    positionSeconds: 0,
    transportClock: null,
    anchorReceivedAtMs: performance.now(),
  });
  const latestPropsRef = useRef({
    durationSeconds,
    pixelsPerSecond,
    livePixelsPerSecondRef,
    cameraXRef,
    positionSecondsRef,
    normalizePositionSeconds,
    onPreviewPositionChange,
    onSeekIntent,
    onSeekCommit,
    positionBoundsRef,
    scrollContainerRef,
  });
  const dragCleanupRef = useRef<(() => void) | null>(null);

  latestPropsRef.current = {
    durationSeconds,
    pixelsPerSecond,
    livePixelsPerSecondRef,
    cameraXRef,
    positionSecondsRef,
    normalizePositionSeconds,
    onPreviewPositionChange,
    onSeekIntent,
    onSeekCommit,
    positionBoundsRef,
    scrollContainerRef,
  };

  useEffect(() => {
    const syncPlayback = (playback: TransportSnapshot | null) => {
      playbackRef.current = {
        playbackState: playback?.playbackState ?? "empty",
        positionSeconds: playback?.positionSeconds ?? 0,
        transportClock: playback?.transportClock ?? null,
        anchorReceivedAtMs: performance.now(),
      };
    };

    syncPlayback(useTransportStore.getState().playback);

    return useTransportStore.subscribe((state) => state.playback, syncPlayback);
  }, []);

  useEffect(() => {
    let animationFrameId = 0;
    let lastTransform = "";
    let lastSyncLogMs = 0;

    const render = () => {
      const activeDrag = dragStateRef.current;
      const effectivePixelsPerSecond =
        latestPropsRef.current.livePixelsPerSecondRef?.current ??
        latestPropsRef.current.pixelsPerSecond;
      const sharedPositionSeconds =
        latestPropsRef.current.positionSecondsRef?.current;
      const nextSeconds = activeDrag
        ? activeDrag.currentSeconds
        : typeof sharedPositionSeconds === "number"
          ? clamp(
              sharedPositionSeconds,
              0,
              Math.max(0, latestPropsRef.current.durationSeconds),
            )
          : playbackRef.current.playbackState === "playing" &&
              playbackRef.current.transportClock?.running
            ? resolveClockPositionSeconds(
                playbackRef.current,
                latestPropsRef.current.durationSeconds,
              )
            : clamp(
                latestPropsRef.current.positionSecondsRef?.current ??
                  playbackRef.current.positionSeconds,
                0,
                Math.max(0, latestPropsRef.current.durationSeconds),
              );
      const absoluteX = secondsToAbsoluteX(
        nextSeconds,
        effectivePixelsPerSecond,
      );
      const cameraX = latestPropsRef.current.cameraXRef?.current ?? 0;
      const nextTransform = `translate3d(${absoluteX - cameraX}px, 0, 0)`;

      if (playheadRef.current && nextTransform !== lastTransform) {
        playheadRef.current.style.transform = nextTransform;
        lastTransform = nextTransform;
      }

      // Sync instrumentation — log what the playhead is DISPLAYING. Rate-limit
      // to 5/sec so the rAF loop doesn't flood the console.
      if (
        isSyncDebugAvailable() &&
        (window as unknown as { __LT_SYNC_DEBUG?: boolean }).__LT_SYNC_DEBUG &&
        playbackRef.current.playbackState === "playing"
      ) {
        const nowMs = performance.now();
        if (nowMs - lastSyncLogMs >= 200) {
          lastSyncLogMs = nowMs;
          // eslint-disable-next-line no-console
          console.log(
            `[PLAYHEAD_UI] wall_ms=${Date.now()} perf_ms=${nowMs.toFixed(1)} displayed_s=${nextSeconds.toFixed(4)}`,
          );
        }
      }

      animationFrameId = window.requestAnimationFrame(render);
    };

    animationFrameId = window.requestAnimationFrame(render);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [dragStateRef]);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !onSeekCommit) {
      return;
    }

    const boundsElement = positionBoundsRef?.current;
    if (!boundsElement) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const rawStartSeconds = clamp(
      clientXToTimelineSeconds(
        event.clientX,
        boundsElement,
        latestPropsRef.current.scrollContainerRef?.current ?? null,
        latestPropsRef.current.livePixelsPerSecondRef?.current ??
          latestPropsRef.current.pixelsPerSecond,
      ),
      0,
      Math.max(0, latestPropsRef.current.durationSeconds),
    );
    // Alt held while dragging suppresses snap-to-grid for the playhead,
    // matching the convention used by clip-drag and region-resize.
    const startAllowSnap = !event.altKey;
    const startSeconds = latestPropsRef.current.normalizePositionSeconds
      ? latestPropsRef.current.normalizePositionSeconds(rawStartSeconds, {
          allowSnap: startAllowSnap,
        })
      : rawStartSeconds;
    dragStateRef.current = {
      pointerId: event.pointerId,
      currentSeconds: startSeconds,
    };
    playheadRef.current?.classList.add("is-dragging");
    onPreviewPositionChange?.(startSeconds);
    latestPropsRef.current.onSeekIntent?.(startSeconds);

    const onPointerMove = (pointerEvent: PointerEvent) => {
      const activeDrag = dragStateRef.current;
      if (!activeDrag || pointerEvent.pointerId !== activeDrag.pointerId) {
        return;
      }

      const nextSeconds = clamp(
        clientXToTimelineSeconds(
          pointerEvent.clientX,
          boundsElement,
          latestPropsRef.current.scrollContainerRef?.current ?? null,
          latestPropsRef.current.livePixelsPerSecondRef?.current ??
            latestPropsRef.current.pixelsPerSecond,
        ),
        0,
        Math.max(0, latestPropsRef.current.durationSeconds),
      );
      // Re-evaluate Alt on every move so the user can hold/release it
      // mid-drag to toggle snap behaviour live.
      const moveAllowSnap = !pointerEvent.altKey;
      const normalizedSeconds = latestPropsRef.current.normalizePositionSeconds
        ? latestPropsRef.current.normalizePositionSeconds(nextSeconds, {
            allowSnap: moveAllowSnap,
          })
        : nextSeconds;

      dragStateRef.current = {
        ...activeDrag,
        currentSeconds: normalizedSeconds,
      };
      onPreviewPositionChange?.(normalizedSeconds);
      latestPropsRef.current.onSeekIntent?.(normalizedSeconds);
    };

    const finishDrag = (pointerEvent: PointerEvent) => {
      const activeDrag = dragStateRef.current;
      if (!activeDrag || pointerEvent.pointerId !== activeDrag.pointerId) {
        return;
      }

      const commitSeconds = activeDrag.currentSeconds;
      dragStateRef.current = null;
      playheadRef.current?.classList.remove("is-dragging");
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
      void onSeekCommit(commitSeconds);
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
    };

    dragCleanupRef.current?.();
    dragCleanupRef.current = cleanup;

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
  };

  return (
    <div
      ref={playheadRef}
      className={className}
      aria-hidden="true"
      onPointerDown={onSeekCommit ? handlePointerDown : undefined}
    />
  );
}
