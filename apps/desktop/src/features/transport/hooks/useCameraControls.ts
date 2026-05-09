import { useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction, WheelEvent as ReactWheelEvent } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { SongView, TransportSnapshot } from "@libretracks/shared/models";
import {
  buildSongTempoRegions,
  getSongBaseBpm,
  getSongTempoRegionAtPosition,
} from "@libretracks/shared/models";
import {
  prewarmTimelineSeek,
  seekTransport,
} from "../desktopApi";
import {
  clamp,
  formatClock,
  formatMusicalPosition,
  rulerClientXToSeconds,
  rulerPointerToSeconds,
} from "../helpers";
import {
  LIVE_ZOOM_COMMIT_DEBOUNCE_MS,
  PLAYBACK_SNAPSHOT_REANCHOR_TOLERANCE_SECONDS,
  SCROLL_COMMIT_DEBOUNCE_MS,
  TRACK_HEIGHT_MAX,
  TRACK_HEIGHT_MIN,
  TRACK_HEIGHT_STEP,
  ZOOM_MAX,
  ZOOM_MIN,
} from "../constants";
import { BASE_PIXELS_PER_SECOND, clampCameraX, zoomCameraAtViewportX } from "../timelineMath";
import { snapToTimelineGrid } from "../useTimelineGrid";
import type { TransportAnchorMeta } from "../types";

type UseCameraControlsProps = {
  cameraXRef: MutableRefObject<number>;
  liveZoomLevelRef: MutableRefObject<number>;
  livePixelsPerSecondRef: MutableRefObject<number>;
  songRef: MutableRefObject<SongView | null>;
  timelineDurationSecondsRef: MutableRefObject<number>;
  songDurationSecondsRef: MutableRefObject<number>;
  displayPositionSecondsRef: MutableRefObject<number>;
  playbackVisualAnchorRef: MutableRefObject<{
    anchorPositionSeconds: number;
    anchorReceivedAtMs: number;
    durationSeconds: number;
    running: boolean;
  }>;
  playheadDragRef: MutableRefObject<{ currentSeconds: number } | null>;
  snapshotRef: MutableRefObject<TransportSnapshot | null>;
  transportAnchorMetaRef: MutableRefObject<TransportAnchorMeta | null>;
  panelRef: MutableRefObject<HTMLDivElement | null>;
  timelineShellRef: MutableRefObject<HTMLDivElement | null>;
  horizontalScrollbarRef: MutableRefObject<HTMLDivElement | null>;
  rulerTrackRef: MutableRefObject<HTMLDivElement | null>;
  scrollDebounceTimerRef: MutableRefObject<number | null>;
  zoomDebounceTimerRef: MutableRefObject<number | null>;
  viewportFitStateRef: MutableRefObject<{
    projectIdentity: string | null;
    hadClips: boolean;
  }>;
  transportReadoutTempoRef: MutableRefObject<HTMLElement | null>;
  transportReadoutValueRef: MutableRefObject<HTMLElement | null>;
  transportReadoutBarRef: MutableRefObject<HTMLElement | null>;
  laneViewportWidth: number;
  timelineContentEndSeconds: number;
  pixelsPerSecond: number;
  fitAllZoomLevel: number;
  effectiveZoomMin: number;
  zoomLevel: number;
  cameraX: number;
  song: SongView | null;
  songBaseBpm: number;
  songBaseTimeSignature: string;
  snapEnabled: boolean;
  trackHeight: number;
  playbackSongDir: string | null;
  setCameraX: (x: number) => void;
  setZoomLevel: Dispatch<SetStateAction<number>>;
  setTrackHeight: (height: number) => void;
  setSelectedRegionId: (id: string | null) => void;
  setSelectedTimelineRange: (range: null) => void;
  setContextMenu: (menu: null) => void;
  clearSelection: () => void;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  setStatus: (status: string) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
};

export function useCameraControls({
  cameraXRef,
  liveZoomLevelRef,
  livePixelsPerSecondRef,
  songRef,
  timelineDurationSecondsRef,
  songDurationSecondsRef,
  displayPositionSecondsRef,
  playbackVisualAnchorRef,
  playheadDragRef,
  snapshotRef,
  transportAnchorMetaRef,
  panelRef,
  timelineShellRef,
  horizontalScrollbarRef,
  rulerTrackRef,
  scrollDebounceTimerRef,
  zoomDebounceTimerRef,
  viewportFitStateRef,
  transportReadoutTempoRef,
  transportReadoutValueRef,
  transportReadoutBarRef,
  laneViewportWidth,
  timelineContentEndSeconds,
  pixelsPerSecond,
  fitAllZoomLevel,
  effectiveZoomMin,
  zoomLevel,
  cameraX,
  song,
  songBaseBpm,
  songBaseTimeSignature,
  snapEnabled,
  trackHeight,
  playbackSongDir,
  setCameraX,
  setZoomLevel,
  setTrackHeight,
  setSelectedRegionId,
  setSelectedTimelineRange,
  setContextMenu,
  clearSelection,
  applyPlaybackSnapshot,
  setStatus,
  t,
}: UseCameraControlsProps) {
  function transportSnapshotKey(nextSnapshot: TransportSnapshot) {
    return [
      nextSnapshot.playbackState,
      nextSnapshot.positionSeconds.toFixed(6),
      nextSnapshot.transportClock?.anchorPositionSeconds?.toFixed(6) ?? "none",
      nextSnapshot.transportClock?.running ? "1" : "0",
      String(nextSnapshot.projectRevision),
    ].join("|");
  }

  function syncLivePosition(
    positionSeconds: number,
    options?: {
      cameraX?: number;
      durationSeconds?: number;
      pixelsPerSecond?: number;
      viewportWidth?: number;
    },
  ) {
    const durationSeconds =
      options?.durationSeconds ??
      timelineDurationSecondsRef.current ??
      songRef.current?.durationSeconds ??
      0;
    const clampedPosition = clamp(
      positionSeconds,
      0,
      durationSeconds || Number.MAX_SAFE_INTEGER,
    );
    const timingRegion = getSongTempoRegionAtPosition(
      songRef.current,
      clampedPosition,
    );
    const displayedTempo = timingRegion?.bpm ?? getSongBaseBpm(songRef.current);

    displayPositionSecondsRef.current = clampedPosition;

    if (transportReadoutTempoRef.current) {
      transportReadoutTempoRef.current.textContent = `${displayedTempo.toFixed(2)} BPM`;
    }

    if (transportReadoutValueRef.current) {
      transportReadoutValueRef.current.textContent =
        formatClock(clampedPosition);
    }

    if (transportReadoutBarRef.current) {
      transportReadoutBarRef.current.textContent = formatMusicalPosition(
        clampedPosition,
        songRef.current,
      );
    }
  }

  function getCameraX(options?: {
    cameraX?: number;
    durationSeconds?: number;
    pixelsPerSecond?: number;
    viewportWidth?: number;
  }) {
    return clampCameraX(
      options?.cameraX ?? cameraXRef.current,
      options?.durationSeconds ?? songRef.current?.durationSeconds ?? 0,
      options?.pixelsPerSecond ?? livePixelsPerSecondRef.current,
      options?.viewportWidth ?? laneViewportWidth,
    );
  }

  function updateCameraX(
    nextCameraX: number,
    options?: {
      durationSeconds?: number;
      contentEndSeconds?: number;
      pixelsPerSecond?: number;
      viewportWidth?: number;
      syncPlayhead?: boolean;
      commitToStore?: boolean;
      debounceStoreCommit?: boolean;
    },
  ) {
    const durationSeconds =
      options?.durationSeconds ?? songRef.current?.durationSeconds ?? 0;
    const contentEndSeconds =
      options?.contentEndSeconds ?? timelineContentEndSeconds;
    const effectivePixelsPerSecond =
      options?.pixelsPerSecond ?? livePixelsPerSecondRef.current;
    const viewportWidth = options?.viewportWidth ?? laneViewportWidth;
    const clampedCameraX = clampCameraX(
      nextCameraX,
      durationSeconds,
      effectivePixelsPerSecond,
      viewportWidth,
      contentEndSeconds,
    );

    cameraXRef.current = clampedCameraX;
    if (options?.commitToStore === false) {
      if (options.debounceStoreCommit === false) {
        if (scrollDebounceTimerRef.current !== null) {
          window.clearTimeout(scrollDebounceTimerRef.current);
          scrollDebounceTimerRef.current = null;
        }
      } else {
        if (scrollDebounceTimerRef.current !== null) {
          window.clearTimeout(scrollDebounceTimerRef.current);
        }

        scrollDebounceTimerRef.current = window.setTimeout(() => {
          scrollDebounceTimerRef.current = null;
          setCameraX(cameraXRef.current);
        }, SCROLL_COMMIT_DEBOUNCE_MS);
      }
    } else {
      if (scrollDebounceTimerRef.current !== null) {
        window.clearTimeout(scrollDebounceTimerRef.current);
        scrollDebounceTimerRef.current = null;
      }

      setCameraX(clampedCameraX);
    }
    panelRef.current?.style.setProperty("--lt-camera-x", `${clampedCameraX}px`);

    const shell = timelineShellRef.current;
    if (shell && Math.abs(shell.scrollLeft - clampedCameraX) > 0.5) {
      shell.scrollLeft = clampedCameraX;
    }

    const horizontalScrollbar = horizontalScrollbarRef.current;
    if (
      horizontalScrollbar &&
      Math.abs(horizontalScrollbar.scrollLeft - clampedCameraX) > 0.5
    ) {
      horizontalScrollbar.scrollLeft = clampedCameraX;
    }

    if (options?.syncPlayhead !== false) {
      syncLivePosition(
        playheadDragRef.current?.currentSeconds ??
          displayPositionSecondsRef.current,
        {
          cameraX: clampedCameraX,
          durationSeconds:
            timelineDurationSecondsRef.current || durationSeconds,
          pixelsPerSecond: effectivePixelsPerSecond,
          viewportWidth,
        },
      );
    }

    return clampedCameraX;
  }

  function commitCameraXToStore(nextCameraX: number) {
    updateCameraX(nextCameraX, { commitToStore: true });
  }

  function applyTransportVisualAnchor(
    nextSnapshot: TransportSnapshot,
    anchorMeta: TransportAnchorMeta | null = null,
  ) {
    const isRunning =
      nextSnapshot.playbackState === "playing" &&
      Boolean(nextSnapshot.transportClock?.running);
    const fallbackAnchorPositionSeconds = isRunning
      ? (nextSnapshot.transportClock?.anchorPositionSeconds ??
        nextSnapshot.positionSeconds)
      : nextSnapshot.positionSeconds;
    const baseAnchorPositionSeconds =
      anchorMeta?.anchorPositionSeconds ?? fallbackAnchorPositionSeconds;
    const emittedLatencySeconds =
      isRunning && anchorMeta
        ? Math.max(0, (Date.now() - anchorMeta.emittedAtUnixMs) / 1000)
        : 0;
    const durationSeconds = songDurationSecondsRef.current;
    const maxDuration =
      timelineDurationSecondsRef.current > 0
        ? timelineDurationSecondsRef.current
        : durationSeconds > 0
          ? durationSeconds
          : Number.MAX_SAFE_INTEGER;
    const anchorPositionSeconds = clamp(
      baseAnchorPositionSeconds + emittedLatencySeconds,
      0,
      maxDuration,
    );

    playbackVisualAnchorRef.current = {
      anchorPositionSeconds,
      anchorReceivedAtMs: performance.now(),
      durationSeconds: timelineDurationSecondsRef.current || durationSeconds,
      running: isRunning,
    };

    syncLivePosition(
      isRunning ? anchorPositionSeconds : nextSnapshot.positionSeconds,
    );
  }

  function resolveCurrentVisualPosition() {
    const anchor = playbackVisualAnchorRef.current;
    const elapsedSeconds = anchor.running
      ? (performance.now() - anchor.anchorReceivedAtMs) / 1000
      : 0;
    const durationSeconds =
      anchor.durationSeconds ||
      timelineDurationSecondsRef.current ||
      songDurationSecondsRef.current;

    return clamp(
      anchor.anchorPositionSeconds + elapsedSeconds,
      0,
      durationSeconds || Number.MAX_SAFE_INTEGER,
    );
  }

  function previewSeek(positionSeconds: number) {
    const durationSeconds =
      timelineDurationSecondsRef.current || song?.durationSeconds || 0;
    const clampedPosition = clamp(
      positionSeconds,
      0,
      durationSeconds || Number.MAX_SAFE_INTEGER,
    );

    playbackVisualAnchorRef.current = {
      anchorPositionSeconds: clampedPosition,
      anchorReceivedAtMs: performance.now(),
      durationSeconds,
      running: false,
    };
    syncLivePosition(clampedPosition, { durationSeconds });
  }

  function restoreConfirmedTransportVisual() {
    if (snapshotRef.current) {
      applyTransportVisualAnchor(snapshotRef.current);
      return;
    }

    playbackVisualAnchorRef.current = {
      anchorPositionSeconds: 0,
      anchorReceivedAtMs: performance.now(),
      durationSeconds:
        timelineDurationSecondsRef.current || songDurationSecondsRef.current,
      running: false,
    };
    syncLivePosition(0);
  }

  async function performSeek(positionSeconds: number) {
    previewSeek(positionSeconds);

    try {
      const nextSnapshot = await seekTransport(positionSeconds);
      applyPlaybackSnapshot(nextSnapshot);
      setStatus(
        t("transport.status.cursorMoved", {
          time: formatClock(nextSnapshot.positionSeconds),
        }),
      );
    } catch (error) {
      restoreConfirmedTransportVisual();
      throw error;
    }
  }

  function prewarmTimelinePosition(positionSeconds: number) {
    void prewarmTimelineSeek(positionSeconds).catch(() => undefined);
  }

  function normalizeTimelineSeekSeconds(
    positionSeconds: number,
    durationSeconds = timelineDurationSecondsRef.current ||
      song?.durationSeconds ||
      0,
  ) {
    const clampedPosition = clamp(
      positionSeconds,
      0,
      Math.max(0, durationSeconds),
    );
    const timingRegion = getSongTempoRegionAtPosition(song, clampedPosition);

    return snapEnabled
      ? clamp(
          snapToTimelineGrid(
            clampedPosition,
            timingRegion?.bpm ?? songBaseBpm,
            timingRegion?.timeSignature ?? songBaseTimeSignature,
            liveZoomLevelRef.current,
            livePixelsPerSecondRef.current,
            buildSongTempoRegions(song),
          ),
          0,
          Math.max(0, durationSeconds),
        )
      : clampedPosition;
  }

  function getTimelineScrollContainer() {
    return horizontalScrollbarRef.current ?? timelineShellRef.current;
  }

  function snappedRulerSeconds(
    event: MouseEvent | ReactMouseEvent,
    durationSeconds: number,
  ) {
    return normalizeTimelineSeekSeconds(
      rulerPointerToSeconds(
        event,
        rulerTrackRef.current as HTMLElement,
        getTimelineScrollContainer(),
        durationSeconds,
        livePixelsPerSecondRef.current,
      ),
      durationSeconds,
    );
  }

  function snappedRulerSecondsAtClientX(
    clientX: number,
    durationSeconds: number,
  ) {
    const rulerTrack = rulerTrackRef.current;
    if (!rulerTrack) {
      return 0;
    }

    return normalizeTimelineSeekSeconds(
      rulerClientXToSeconds(
        clientX,
        rulerTrack,
        getCameraX(),
        durationSeconds,
        livePixelsPerSecondRef.current,
      ),
      durationSeconds,
    );
  }

  function clearSelections(message: string) {
    clearSelection();
    setSelectedRegionId(null);
    setSelectedTimelineRange(null);
    setContextMenu(null);
    setStatus(message);
  }

  function previewZoom(
    nextZoomLevel: number,
    anchorViewportX = laneViewportWidth / 2,
    options?: { scheduleCommit?: boolean },
  ) {
    const clampedZoom = clamp(nextZoomLevel, effectiveZoomMin, ZOOM_MAX);
    const nextPixelsPerSecond = clampedZoom * BASE_PIXELS_PER_SECOND;
    const previousPixelsPerSecond = livePixelsPerSecondRef.current;
    const durationSeconds = song?.durationSeconds ?? 0;
    const nextCameraX = zoomCameraAtViewportX({
      durationSeconds,
      contentEndSeconds: timelineContentEndSeconds,
      viewportWidth: laneViewportWidth,
      viewportX: clamp(anchorViewportX, 0, laneViewportWidth),
      currentCameraX: getCameraX(),
      previousPixelsPerSecond,
      nextPixelsPerSecond,
    });

    liveZoomLevelRef.current = clampedZoom;
    livePixelsPerSecondRef.current = nextPixelsPerSecond;
    const clampedCameraX = updateCameraX(nextCameraX, {
      durationSeconds,
      contentEndSeconds: timelineContentEndSeconds,
      pixelsPerSecond: nextPixelsPerSecond,
      viewportWidth: laneViewportWidth,
      commitToStore: false,
      debounceStoreCommit: false,
    });

    const nextView = { cameraX: clampedCameraX, zoomLevel: clampedZoom };

    if (options?.scheduleCommit !== false) {
      if (zoomDebounceTimerRef.current !== null) {
        window.clearTimeout(zoomDebounceTimerRef.current);
      }

      zoomDebounceTimerRef.current = window.setTimeout(() => {
        zoomDebounceTimerRef.current = null;
        setZoomLevel(nextView.zoomLevel);
        commitCameraXToStore(nextView.cameraX);
      }, LIVE_ZOOM_COMMIT_DEBOUNCE_MS);
    }

    return nextView;
  }

  function applyZoom(nextZoomLevel: number, anchorViewportX = laneViewportWidth / 2) {
    previewZoom(nextZoomLevel, anchorViewportX, { scheduleCommit: true });
  }

  function commitZoomViewToStore(nextView: { cameraX: number; zoomLevel: number }) {
    if (zoomDebounceTimerRef.current !== null) {
      window.clearTimeout(zoomDebounceTimerRef.current);
      zoomDebounceTimerRef.current = null;
    }

    liveZoomLevelRef.current = nextView.zoomLevel;
    livePixelsPerSecondRef.current = nextView.zoomLevel * BASE_PIXELS_PER_SECOND;
    setZoomLevel(nextView.zoomLevel);
    updateCameraX(nextView.cameraX, {
      pixelsPerSecond: livePixelsPerSecondRef.current,
      commitToStore: true,
    });
  }

  function applyTrackHeight(nextTrackHeight: number) {
    setTrackHeight(
      clamp(Math.round(nextTrackHeight), TRACK_HEIGHT_MIN, TRACK_HEIGHT_MAX),
    );
  }

  function handleTrackHeadersWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (event.defaultPrevented) {
      return;
    }

    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      applyTrackHeight(
        trackHeight + (event.deltaY < 0 ? TRACK_HEIGHT_STEP : -TRACK_HEIGHT_STEP),
      );
      return;
    }

    const shouldScrollHorizontally =
      event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
    if (!shouldScrollHorizontally) {
      return;
    }

    event.preventDefault();
    updateCameraX(
      cameraXRef.current + event.deltaX + (event.shiftKey ? event.deltaY : 0),
      { commitToStore: false },
    );
  }

  // Camera effects
  useEffect(() => {
    setZoomLevel((current) =>
      current < effectiveZoomMin ? effectiveZoomMin : current,
    );
  }, [effectiveZoomMin]);

  useEffect(() => {
    if (!song) {
      viewportFitStateRef.current = { projectIdentity: null, hadClips: false };
      return;
    }

    const projectIdentity = playbackSongDir
      ? `${playbackSongDir}::${song.id}`
      : song.id;
    const hadClips =
      viewportFitStateRef.current.projectIdentity === projectIdentity
        ? viewportFitStateRef.current.hadClips
        : false;
    const hasClips = song.clips.length > 0;
    const shouldFitViewport =
      laneViewportWidth > 0 &&
      (viewportFitStateRef.current.projectIdentity !== projectIdentity ||
        (!hadClips && hasClips));

    viewportFitStateRef.current = { projectIdentity, hadClips: hasClips };

    if (!shouldFitViewport) {
      return;
    }

    const fittedZoomLevel = clamp(fitAllZoomLevel, ZOOM_MIN, ZOOM_MAX);
    const fittedPixelsPerSecond = fittedZoomLevel * BASE_PIXELS_PER_SECOND;
    liveZoomLevelRef.current = fittedZoomLevel;
    livePixelsPerSecondRef.current = fittedPixelsPerSecond;
    setZoomLevel(fittedZoomLevel);
    updateCameraX(0, {
      durationSeconds: song.durationSeconds,
      contentEndSeconds: timelineContentEndSeconds,
      pixelsPerSecond: fittedPixelsPerSecond,
      viewportWidth: laneViewportWidth,
    });
  }, [fitAllZoomLevel, laneViewportWidth, playbackSongDir, song, timelineContentEndSeconds]);

  useEffect(() => {
    liveZoomLevelRef.current = zoomLevel;
    livePixelsPerSecondRef.current = pixelsPerSecond;
  }, [pixelsPerSecond, zoomLevel]);

  useEffect(() => {
    if (
      zoomDebounceTimerRef.current === null ||
      Math.abs(cameraXRef.current - cameraX) <= 0.5
    ) {
      cameraXRef.current = cameraX;
    }
  }, [cameraX]);

  useEffect(() => {
    return () => {
      if (scrollDebounceTimerRef.current !== null) {
        window.clearTimeout(scrollDebounceTimerRef.current);
      }
      if (zoomDebounceTimerRef.current !== null) {
        window.clearTimeout(zoomDebounceTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    updateCameraX(cameraXRef.current, {
      durationSeconds: song?.durationSeconds ?? 0,
      contentEndSeconds: timelineContentEndSeconds,
      pixelsPerSecond,
      viewportWidth: laneViewportWidth,
    });
  }, [laneViewportWidth, pixelsPerSecond, song?.durationSeconds, timelineContentEndSeconds]);

  useEffect(() => {
    syncLivePosition(
      playheadDragRef.current?.currentSeconds ??
        displayPositionSecondsRef.current,
    );
  }, [pixelsPerSecond, song?.projectRevision, song?.durationSeconds, songBaseBpm, songBaseTimeSignature]);

  return {
    transportSnapshotKey,
    applyTransportVisualAnchor,
    resolveCurrentVisualPosition,
    getCameraX,
    syncLivePosition,
    updateCameraX,
    commitCameraXToStore,
    previewSeek,
    restoreConfirmedTransportVisual,
    performSeek,
    prewarmTimelinePosition,
    normalizeTimelineSeekSeconds,
    getTimelineScrollContainer,
    snappedRulerSeconds,
    snappedRulerSecondsAtClientX,
    clearSelections,
    previewZoom,
    applyZoom,
    commitZoomViewToStore,
    applyTrackHeight,
    handleTrackHeadersWheel,
  };
}
