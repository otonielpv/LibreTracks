import { useEffect, useRef, type MutableRefObject, type PointerEvent as ReactPointerEvent } from "react";

import type { TransportClock, TransportSnapshot } from "./desktopApi";
import { useTransportStore } from "./store";
import { clamp, clientXToTimelineSeconds, secondsToAbsoluteX } from "./timelineMath";

type PlayheadDragState = {
  pointerId: number;
  currentSeconds: number;
} | null;

type PlayheadOverlayProps = {
  className: string;
  durationSeconds: number;
  pixelsPerSecond: number;
  cameraXRef?: MutableRefObject<number>;
  dragStateRef: MutableRefObject<PlayheadDragState>;
  positionSecondsRef?: MutableRefObject<number>;
  normalizePositionSeconds?: (positionSeconds: number) => number;
  onPreviewPositionChange?: (positionSeconds: number) => void;
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
  const isRunning = playback.playbackState === "playing" && Boolean(playback.transportClock?.running);

  if (!isRunning || !playback.transportClock) {
    return clamp(playback.positionSeconds, 0, safeDuration);
  }

  const elapsedSeconds = (performance.now() - playback.anchorReceivedAtMs) / 1000;
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
  cameraXRef,
  dragStateRef,
  positionSecondsRef,
  normalizePositionSeconds,
  onPreviewPositionChange,
  onSeekCommit,
  positionBoundsRef,
  scrollContainerRef,
}: PlayheadOverlayProps) {
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
    cameraXRef,
    positionSecondsRef,
    normalizePositionSeconds,
    onPreviewPositionChange,
    onSeekCommit,
    positionBoundsRef,
    scrollContainerRef,
  });
  const dragCleanupRef = useRef<(() => void) | null>(null);

  latestPropsRef.current = {
    durationSeconds,
    pixelsPerSecond,
    cameraXRef,
    positionSecondsRef,
    normalizePositionSeconds,
    onPreviewPositionChange,
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

    const render = () => {
      const activeDrag = dragStateRef.current;
      const nextSeconds = activeDrag
        ? activeDrag.currentSeconds
        : playbackRef.current.playbackState === "playing" && playbackRef.current.transportClock?.running
          ? resolveClockPositionSeconds(playbackRef.current, latestPropsRef.current.durationSeconds)
          : clamp(
              latestPropsRef.current.positionSecondsRef?.current ?? playbackRef.current.positionSeconds,
              0,
              Math.max(0, latestPropsRef.current.durationSeconds),
            );
      const absoluteX = secondsToAbsoluteX(nextSeconds, latestPropsRef.current.pixelsPerSecond);
      const cameraX = latestPropsRef.current.cameraXRef?.current ?? 0;
      const nextTransform = `translate3d(${absoluteX - cameraX}px, 0, 0)`;

      if (playheadRef.current && nextTransform !== lastTransform) {
        playheadRef.current.style.transform = nextTransform;
        lastTransform = nextTransform;
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
        latestPropsRef.current.pixelsPerSecond,
      ),
      0,
      Math.max(0, latestPropsRef.current.durationSeconds),
    );
    const startSeconds = latestPropsRef.current.normalizePositionSeconds
      ? latestPropsRef.current.normalizePositionSeconds(rawStartSeconds)
      : rawStartSeconds;
    dragStateRef.current = {
      pointerId: event.pointerId,
      currentSeconds: startSeconds,
    };
    playheadRef.current?.classList.add("is-dragging");
    onPreviewPositionChange?.(startSeconds);

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
          latestPropsRef.current.pixelsPerSecond,
        ),
        0,
        Math.max(0, latestPropsRef.current.durationSeconds),
      );
      const normalizedSeconds = latestPropsRef.current.normalizePositionSeconds
        ? latestPropsRef.current.normalizePositionSeconds(nextSeconds)
        : nextSeconds;

      dragStateRef.current = {
        ...activeDrag,
        currentSeconds: normalizedSeconds,
      };
      onPreviewPositionChange?.(normalizedSeconds);
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
