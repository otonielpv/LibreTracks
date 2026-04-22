import {
  Profiler,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  assignSectionMarkerDigit,
  cancelMarkerJump,
  createSectionMarker,
  createSong,
  createTrack,
  deleteClip,
  deleteSectionMarker,
  deleteTrack,
  duplicateClip,
  getSongView,
  getTransportSnapshot,
  getWaveformSummaries,
  isTauriApp,
  listenToAudioMeters,
  listenToTransportLifecycle,
  moveClip,
  moveClipLive,
  moveTrack,
  openProject,
  pauseTransport,
  pickAndImportSong,
  playTransport,
  redoAction,
  saveProject,
  saveProjectAs,
  scheduleMarkerJump,
  seekTransport,
  splitClip,
  stopTransport,
  undoAction,
  updateSectionMarker,
  updateSongTempo,
  updateTrack,
  updateTrackMixLive,
  type ClipSummary,
  type SectionMarkerSummary,
  type SongView,
  type TrackKind,
  type TransportLifecycleEvent,
  type TrackSummary,
  type TransportSnapshot,
  type WaveformSummaryDto,
  reportUiRenderMetric,
} from "./desktopApi";
import { TimelineRulerCanvas, TimelineTrackCanvas } from "./CanvasTimeline";
import { ImportAudioModal } from "./ImportAudioModal";
import { snapToTimelineGrid, useTimelineGrid } from "./useTimelineGrid";
import {
  BASE_PIXELS_PER_SECOND,
  clampCameraX,
  getMusicalPosition,
  getMaxCameraX,
  screenXToSeconds,
  secondsToScreenX,
  zoomCameraAtViewportX,
} from "./timelineMath";
import { TrackHeaderItem } from "./TrackHeaderItem";
import {
  meterDictionaryFromLevels,
  useTransportStore,
  type OptimisticMixState,
} from "./store";

const HEADER_WIDTH = 260;
const DEFAULT_TIMELINE_VIEWPORT_WIDTH = 1100;
const TIMELINE_FIT_RIGHT_GUTTER_PX = 140;
const DEFAULT_TRACK_HEIGHT = 94;
const TRACK_HEIGHT_MIN = 68;
const TRACK_HEIGHT_MAX = 148;
const TRACK_HEIGHT_STEP = 8;
const RULER_HEIGHT = 64;
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 48;
const ZOOM_WHEEL_STEP = 1.25;
const DRAG_THRESHOLD_PX = 6;
const LIVE_TRACK_MIX_MIN_INTERVAL_MS = 16;

type ContextMenuAction = {
  label: string;
  disabled?: boolean;
  onSelect: () => void | Promise<void>;
};

type ContextMenuState = {
  x: number;
  y: number;
  title: string;
  actions: ContextMenuAction[];
} | null;

type ClipDragState = {
  clipId: string;
  pointerId: number;
  originSeconds: number;
  previewSeconds: number;
  startClientX: number;
  hasMoved: boolean;
} | null;

type PlayheadDragState = {
  pointerId: number;
  currentSeconds: number;
} | null;

type TrackDropState = {
  targetTrackId: string;
  mode: "before" | "after" | "inside-folder";
} | null;

type TrackDragState = {
  trackId: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  currentClientY: number;
  isDragging: boolean;
  rowElement: HTMLDivElement | null;
  headerElement: HTMLDivElement | null;
} | null;

type TimelinePanState = {
  pointerId: number;
  startClientX: number;
  originCameraX: number;
} | null;

type LiveClipMoveState = {
  inFlight: boolean;
  queuedSeconds: number | null;
};

type LiveTrackMixRequestState = {
  inFlight: boolean;
  queuedKeys: Set<keyof OptimisticMixState>;
  lastSentAt: number;
};

type GlobalJumpMode = "immediate" | "after_bars" | "next_marker";

type TransportAnchorMeta = {
  snapshotKey: string;
  anchorPositionSeconds: number;
  emittedAtUnixMs: number;
};

function formatClock(seconds: number) {
  const safeSeconds = Math.max(0, seconds);
  const minutes = Math.floor(safeSeconds / 60);
  const secondsRemainder = safeSeconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${secondsRemainder.toFixed(3).padStart(6, "0")}`;
}

function formatCompactTime(seconds: number) {
  const safeSeconds = Math.max(0, seconds);
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = Math.floor(safeSeconds % 60);
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatTimelineHeaderTime(seconds: number) {
  const safeSeconds = Math.max(0, seconds);
  const minutes = Math.floor(safeSeconds / 60);
  const secondsRemainder = safeSeconds - minutes * 60;
  return `${minutes}:${secondsRemainder.toFixed(3).padStart(6, "0")}`;
}

function formatTimelineHeaderMusicalPosition(barNumber: number, beatInBar: number) {
  return `${barNumber}.${beatInBar}.00`;
}

function formatMusicalPosition(seconds: number, bpm: number, timeSignature: string) {
  return getMusicalPosition(seconds, bpm, timeSignature).display;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function keyboardDigit(eventCode: string) {
  const match = eventCode.match(/^(?:Digit|Numpad)(\d)$/);
  if (match) {
    return Number(match[1]);
  }

  return null;
}

function resolveMarkerShortcut(markers: SectionMarkerSummary[], digit: number) {
  return [...markers]
    .sort((left, right) => left.startSeconds - right.startSeconds)
    .at(digit) ?? null;
}

function buildVisibleTracks(song: SongView, collapsedFolders: Set<string>) {
  const visibility = new Map<string, boolean>();

  for (const track of song.tracks) {
    const parentId = track.parentTrackId ?? null;
    if (!parentId) {
      visibility.set(track.id, true);
      continue;
    }

    const parentVisible = visibility.get(parentId) ?? true;
    const isParentCollapsed = collapsedFolders.has(parentId);
    visibility.set(track.id, parentVisible && !isParentCollapsed);
  }

  return song.tracks.filter((track) => visibility.get(track.id));
}

function findPreviousFolderTrack(song: SongView, trackId: string) {
  const index = song.tracks.findIndex((track) => track.id === trackId);
  if (index <= 0) {
    return null;
  }

  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const track = song.tracks[cursor];
    if (track.kind === "folder") {
      return track;
    }
  }

  return null;
}

function findTrack(song: SongView | null, trackId: string | null) {
  if (!song || !trackId) {
    return null;
  }

  return song.tracks.find((track) => track.id === trackId) ?? null;
}

function findClip(song: SongView | null, clipId: string | null) {
  if (!song || !clipId) {
    return null;
  }

  return song.clips.find((clip) => clip.id === clipId) ?? null;
}

function findSection(song: SongView | null, sectionId: string | null) {
  if (!song || !sectionId) {
    return null;
  }

  return song.sectionMarkers.find((marker) => marker.id === sectionId) ?? null;
}

function trackChildrenCount(song: SongView, trackId: string) {
  return song.tracks.filter((track) => track.parentTrackId === trackId).length;
}

function isClipStructurallyEqual(left: ClipSummary, right: ClipSummary) {
  return (
    left.id === right.id &&
    left.trackId === right.trackId &&
    left.waveformKey === right.waveformKey &&
    left.timelineStartSeconds === right.timelineStartSeconds &&
    left.sourceStartSeconds === right.sourceStartSeconds &&
    left.sourceDurationSeconds === right.sourceDurationSeconds &&
    left.durationSeconds === right.durationSeconds
  );
}

function buildMemoizedClipsByTrack(
  song: SongView,
  current: Record<string, ClipSummary[]>,
): Record<string, ClipSummary[]> {
  const nextBuckets = Object.fromEntries(song.tracks.map((track) => [track.id, [] as ClipSummary[]]));

  for (const clip of song.clips) {
    nextBuckets[clip.trackId] ??= [];
    nextBuckets[clip.trackId].push(clip);
  }

  let hasChanged = Object.keys(current).length !== Object.keys(nextBuckets).length;
  const nextClipsByTrack: Record<string, ClipSummary[]> = {};

  for (const track of song.tracks) {
    const nextTrackClips = nextBuckets[track.id] ?? [];
    const currentTrackClips = current[track.id] ?? [];
    const canReuseTrackClips =
      nextTrackClips.length === currentTrackClips.length &&
      nextTrackClips.every((clip, index) => isClipStructurallyEqual(clip, currentTrackClips[index]));

    nextClipsByTrack[track.id] = canReuseTrackClips ? currentTrackClips : nextTrackClips;
    if (!canReuseTrackClips) {
      hasChanged = true;
    }
  }

  return hasChanged ? nextClipsByTrack : current;
}

function isTrackDescendant(song: SongView, candidateTrackId: string | null, trackId: string) {
  let cursor = candidateTrackId;

  while (cursor) {
    if (cursor === trackId) {
      return true;
    }

    cursor = findTrack(song, cursor)?.parentTrackId ?? null;
  }

  return false;
}

function isInteractiveTimelineTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    ? Boolean(
        target.closest(
          ".lt-marker-hotspot, .lt-track-header, .lt-inline-menu, .lt-context-menu, button, input, select, textarea, label",
        ),
      )
    : false;
}

function isTimelineZoomTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    ? Boolean(
        target.closest(
          ".lt-ruler-track, .lt-ruler-content, .lt-ruler-canvas, .lt-ruler-canvas-overlay, .lt-track-list, .lt-track-row, .lt-track-lane, .lt-track-canvas-layer, .lt-track-canvas, .lt-track-canvas-overlay",
        ),
      )
    : false;
}

function isTrackInfoScrollTarget(target: EventTarget | null) {
  return target instanceof HTMLElement ? Boolean(target.closest(".lt-track-header")) : false;
}

function resolveTrackDropState(
  song: SongView,
  draggingTrackId: string,
  clientX: number,
  clientY: number,
): TrackDropState {
  const hoveredRow = document.elementFromPoint(clientX, clientY)?.closest(".lt-track-row") as
    | HTMLElement
    | null;
  const targetTrackId = hoveredRow?.dataset.trackId ?? null;
  if (!hoveredRow || !targetTrackId || targetTrackId === draggingTrackId) {
    return null;
  }

  const targetTrack = findTrack(song, targetTrackId);
  if (!targetTrack || isTrackDescendant(song, targetTrackId, draggingTrackId)) {
    return null;
  }

  const bounds = hoveredRow.getBoundingClientRect();
  const verticalRatio = bounds.height > 0 ? (clientY - bounds.top) / bounds.height : 0.5;
  const mode =
    targetTrack.kind === "folder" && verticalRatio >= 0.3 && verticalRatio <= 0.7
      ? "inside-folder"
      : verticalRatio < 0.5
        ? "before"
        : "after";

  return {
    targetTrackId,
    mode,
  };
}

function rulerPointerToSeconds(
  event: MouseEvent | ReactMouseEvent,
  element: HTMLElement,
  durationSeconds: number,
  cameraX: number,
  pixelsPerSecond: number,
) {
  const bounds = element.getBoundingClientRect();
  const x = clamp(event.clientX - bounds.left, 0, bounds.width);
  return clamp(
    screenXToSeconds(x, cameraX, pixelsPerSecond),
    0,
    Math.max(0, durationSeconds),
  );
}

function lanePointerToClip(
  clips: ClipSummary[],
  element: HTMLElement,
  clientX: number,
  cameraX: number,
  pixelsPerSecond: number,
) {
  const bounds = element.getBoundingClientRect();
  const pointerX = clamp(clientX - bounds.left, 0, bounds.width);

  for (let index = clips.length - 1; index >= 0; index -= 1) {
    const clip = clips[index];
    const clipLeft = secondsToScreenX(clip.timelineStartSeconds, cameraX, pixelsPerSecond);
    const clipWidth = Math.max(clip.durationSeconds * pixelsPerSecond, 28);

    if (pointerX >= clipLeft && pointerX <= clipLeft + clipWidth) {
      return clip;
    }
  }

  return null;
}

export function TransportPanel() {
  const [song, setSong] = useState<SongView | null>(null);
  const [waveformCache, setWaveformCache] = useState<Record<string, WaveformSummaryDto>>({});
  const [clipsByTrack, setClipsByTrack] = useState<Record<string, ClipSummary[]>>({});
  const [tracksById, setTracksById] = useState<Record<string, TrackSummary>>({});
  const [status, setStatus] = useState("Cargando sesion...");
  const [isBusy, setIsBusy] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isImportingFromModal, setIsImportingFromModal] = useState(false);
  const [tempoDraft, setTempoDraft] = useState("120");
  const [globalJumpMode, setGlobalJumpMode] = useState<GlobalJumpMode>("immediate");
  const [globalJumpBars, setGlobalJumpBars] = useState(4);
  const [zoomLevel, setZoomLevel] = useState(7);
  const [trackHeight, setTrackHeight] = useState(DEFAULT_TRACK_HEIGHT);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [openTopMenu, setOpenTopMenu] = useState<"file" | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(DEFAULT_TIMELINE_VIEWPORT_WIDTH);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const menuBarRef = useRef<HTMLDivElement | null>(null);
  const laneAreaRef = useRef<HTMLDivElement | null>(null);
  const rulerTrackRef = useRef<HTMLDivElement | null>(null);
  const timelineShellRef = useRef<HTMLDivElement | null>(null);
  const horizontalScrollbarRef = useRef<HTMLDivElement | null>(null);
  const playheadHandleRef = useRef<HTMLDivElement | null>(null);
  const playbackVisualAnchorRef = useRef({
    anchorPositionSeconds: 0,
    anchorReceivedAtMs: 0,
    durationSeconds: 0,
    running: false,
  });
  const displayPositionSecondsRef = useRef(0);
  const suppressTrackClickRef = useRef(false);
  const renderMetricTimeoutRef = useRef<number | null>(null);
  const pendingRenderMetricRef = useRef(0);
  const transportReadoutValueRef = useRef<HTMLElement | null>(null);
  const transportReadoutBarRef = useRef<HTMLElement | null>(null);
  const songDurationSecondsRef = useRef(0);
  const transportAnchorMetaRef = useRef<TransportAnchorMeta | null>(null);
  const cameraXRef = useRef(0);
  const snapshotRef = useRef<TransportSnapshot | null>(useTransportStore.getState().playback);
  const songRef = useRef<SongView | null>(null);
  const tracksByIdRef = useRef<Record<string, TrackSummary>>({});
  const clipDragRef = useRef<ClipDragState>(null);
  const clipMoveLiveStatesRef = useRef<Record<string, LiveClipMoveState>>({});
  const trackMixRequestIdsRef = useRef<Record<string, number>>({});
  const trackMixLiveStatesRef = useRef<Record<string, LiveTrackMixRequestState>>({});
  const playheadDragRef = useRef<PlayheadDragState>(null);
  const trackDragRef = useRef<TrackDragState>(null);
  const timelinePanRef = useRef<TimelinePanState>(null);
  const clipPreviewSecondsRef = useRef<Record<string, number>>({});
  const trackDropStateRef = useRef<TrackDropState>(null);
  const draggedTrackRowRef = useRef<HTMLDivElement | null>(null);
  const droppedTrackRowRef = useRef<HTMLDivElement | null>(null);
  const playbackState = useTransportStore((state) => state.playback?.playbackState ?? "empty");
  const playbackProjectRevision = useTransportStore((state) => state.playback?.projectRevision ?? 0);
  const pendingMarkerJumpSignature = useTransportStore((state) => {
    const pendingJump = state.playback?.pendingMarkerJump;
    if (!pendingJump) {
      return "";
    }

    return [
      pendingJump.targetMarkerId,
      pendingJump.targetMarkerName,
      pendingJump.trigger,
      pendingJump.executeAtSeconds.toFixed(6),
    ].join("|");
  });

  songRef.current = song;
  tracksByIdRef.current = tracksById;

  const runAction = useCallback(async (work: () => Promise<void>, options?: { busy?: boolean }) => {
    try {
      if (options?.busy) {
        setIsBusy(true);
      }
      await work();
    } catch (error) {
      setStatus(`Error: ${String(error)}`);
    } finally {
      if (options?.busy) {
        setIsBusy(false);
      }
    }
  }, []);

  const applyPlaybackSnapshot = useCallback((nextSnapshot: TransportSnapshot | null) => {
    snapshotRef.current = nextSnapshot;
    useTransportStore.getState().setPlaybackState(nextSnapshot);
  }, []);

  const getTrackOptimisticMix = useCallback((trackId: string) => {
    return useTransportStore.getState().optimisticMix[trackId] ?? {};
  }, []);

  const setTrackOptimisticMix = useCallback((trackId: string, nextMix: OptimisticMixState) => {
    useTransportStore.getState().setOptimisticMix(trackId, Object.keys(nextMix).length ? nextMix : null);
  }, []);

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

  const resolveTrackMix = useCallback(
    (track: TrackSummary, trackId: string) => {
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
      if (keys.includes("volume") && Math.abs(resolvedMix.volume - track.volume) >= 0.0001) {
        payload.volume = resolvedMix.volume;
      }
      if (keys.includes("pan") && Math.abs(resolvedMix.pan - track.pan) >= 0.0001) {
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
    [applyPlaybackSnapshot, clearTrackOptimisticMixKeys, nextTrackMixRequestId, resolveTrackMix],
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
          const remainingDelay = LIVE_TRACK_MIX_MIN_INTERVAL_MS - (now - liveState.lastSentAt);
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
    [clearTrackOptimisticMixKeys, resolveTrackMix],
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
        clearTrackOptimisticMixKeys(trackId, ["muted", "solo", "volume", "pan"]);
        delete trackMixLiveStatesRef.current[trackId];
        setStatus(`Error: ${String(error)}`);
      });
    },
    [clearTrackOptimisticMixKeys, flushTrackMixLiveUpdates],
  );

  const flushClipMoveLiveUpdates = useCallback(
    async (clipId: string) => {
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
    },
    [],
  );

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
        setStatus(`Error: ${String(error)}`);
      });
    },
    [flushClipMoveLiveUpdates],
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

  const clearTrackDragVisuals = useCallback(() => {
    if (draggedTrackRowRef.current) {
      draggedTrackRowRef.current.style.transform = "";
      draggedTrackRowRef.current.style.zIndex = "";
    }

    const draggedHeader = draggedTrackRowRef.current?.querySelector(".lt-track-header");
    if (draggedHeader instanceof HTMLElement) {
      draggedHeader.classList.remove("is-dragging");
    }

    if (droppedTrackRowRef.current) {
      droppedTrackRowRef.current.classList.remove(
        "is-drop-target",
        "is-drop-before",
        "is-drop-after",
        "is-drop-inside-folder",
      );
    }

    draggedTrackRowRef.current = null;
    droppedTrackRowRef.current = null;
    trackDropStateRef.current = null;
  }, []);

  const applyTrackDragVisuals = useCallback((dragState: NonNullable<TrackDragState>, dropState: TrackDropState) => {
    const deltaY = dragState.currentClientY - dragState.startClientY;

    if (draggedTrackRowRef.current !== dragState.rowElement) {
      clearTrackDragVisuals();
      draggedTrackRowRef.current = dragState.rowElement;
    }

    if (dragState.rowElement) {
      dragState.rowElement.style.transform = `translate3d(0, ${deltaY}px, 0)`;
      dragState.rowElement.style.zIndex = "8";
    }

    if (dragState.headerElement) {
      dragState.headerElement.classList.add("is-dragging");
    }

    if (
      droppedTrackRowRef.current &&
      droppedTrackRowRef.current.dataset.trackId !== dropState?.targetTrackId
    ) {
      droppedTrackRowRef.current.classList.remove(
        "is-drop-target",
        "is-drop-before",
        "is-drop-after",
        "is-drop-inside-folder",
      );
      droppedTrackRowRef.current = null;
    }

    const nextDropRow = dropState?.targetTrackId
      ? (laneAreaRef.current?.querySelector(`[data-track-id="${dropState.targetTrackId}"]`) as HTMLDivElement | null)
      : null;

    if (!dropState || !nextDropRow) {
      trackDropStateRef.current = null;
      return;
    }

    nextDropRow.classList.remove("is-drop-before", "is-drop-after", "is-drop-inside-folder");
    nextDropRow.classList.add("is-drop-target", `is-drop-${dropState.mode}`);
    droppedTrackRowRef.current = nextDropRow;
    trackDropStateRef.current = dropState;
  }, [clearTrackDragVisuals]);

  function transportSnapshotKey(nextSnapshot: TransportSnapshot) {
    return [
      nextSnapshot.playbackState,
      nextSnapshot.positionSeconds.toFixed(6),
      nextSnapshot.transportClock?.anchorPositionSeconds?.toFixed(6) ?? "none",
      nextSnapshot.transportClock?.running ? "1" : "0",
      String(nextSnapshot.projectRevision),
    ].join("|");
  }

  function applyTransportVisualAnchor(
    nextSnapshot: TransportSnapshot,
    anchorMeta: TransportAnchorMeta | null = null,
  ) {
    const isRunning =
      nextSnapshot.playbackState === "playing" && Boolean(nextSnapshot.transportClock?.running);
    const fallbackAnchorPositionSeconds = isRunning
      ? nextSnapshot.transportClock?.anchorPositionSeconds ?? nextSnapshot.positionSeconds
      : nextSnapshot.positionSeconds;
    const baseAnchorPositionSeconds = anchorMeta?.anchorPositionSeconds ?? fallbackAnchorPositionSeconds;
    const emittedLatencySeconds =
      isRunning && anchorMeta
        ? Math.max(0, (Date.now() - anchorMeta.emittedAtUnixMs) / 1000)
        : 0;
    const durationSeconds = songDurationSecondsRef.current;
    const maxDuration = durationSeconds > 0 ? durationSeconds : Number.MAX_SAFE_INTEGER;
    const anchorPositionSeconds = clamp(
      baseAnchorPositionSeconds + emittedLatencySeconds,
      0,
      maxDuration,
    );

    playbackVisualAnchorRef.current = {
      anchorPositionSeconds,
      anchorReceivedAtMs: performance.now(),
      durationSeconds,
      running: isRunning,
    };

    syncLivePosition(isRunning ? anchorPositionSeconds : nextSnapshot.positionSeconds);
  }

  useEffect(() => {
    const syncPlaybackSnapshot = (nextSnapshot: TransportSnapshot | null) => {
      snapshotRef.current = nextSnapshot;

      if (!nextSnapshot) {
        playbackVisualAnchorRef.current = {
          anchorPositionSeconds: 0,
          anchorReceivedAtMs: performance.now(),
          durationSeconds: songDurationSecondsRef.current,
          running: false,
        };
        syncLivePosition(0);
        return;
      }

      const snapshotKey = transportSnapshotKey(nextSnapshot);
      const anchorMeta =
        transportAnchorMetaRef.current?.snapshotKey === snapshotKey
          ? transportAnchorMetaRef.current
          : null;

      if (anchorMeta) {
        transportAnchorMetaRef.current = null;
      }

      applyTransportVisualAnchor(nextSnapshot, anchorMeta);
    };

    syncPlaybackSnapshot(useTransportStore.getState().playback);

    return useTransportStore.subscribe((state) => state.playback, syncPlaybackSnapshot);
  }, []);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;

    async function loadSnapshot() {
      const nextSnapshot = await getTransportSnapshot();
      if (!active) {
        return;
      }

      applyPlaybackSnapshot(nextSnapshot);
      setStatus(
        nextSnapshot.isNativeRuntime
          ? "Sesion desktop lista para edicion."
          : "Modo demo web activo. Las acciones contextuales ya usan el nuevo flujo DAW.",
      );
    }

    void loadSnapshot();

    if (!isTauriApp) {
      return () => {
        active = false;
      };
    }

    void listenToTransportLifecycle((event: TransportLifecycleEvent) => {
      if (!active) {
        return;
      }

      transportAnchorMetaRef.current = {
        snapshotKey: transportSnapshotKey(event.snapshot),
        anchorPositionSeconds: event.anchorPositionSeconds,
        emittedAtUnixMs: event.emittedAtUnixMs,
      };
      applyPlaybackSnapshot(event.snapshot);
    }).then((nextUnlisten) => {
      if (!active) {
        nextUnlisten();
        return;
      }

      unlisten = nextUnlisten;
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, [applyPlaybackSnapshot]);

  useEffect(() => {
    if (!isTauriApp) {
      return () => {};
    }

    let active = true;
    let unlisten: (() => void) | undefined;
    let frameId: number | null = null;
    let pendingMeters: ReturnType<typeof meterDictionaryFromLevels> | null = null;

    const flushMeters = () => {
      frameId = null;
      if (!active || pendingMeters === null) {
        return;
      }

      useTransportStore.getState().setMeters(pendingMeters);
      pendingMeters = null;
    };

    void listenToAudioMeters((levels) => {
      if (!active) {
        return;
      }

      pendingMeters = meterDictionaryFromLevels(levels);
      if (frameId === null) {
        frameId = window.requestAnimationFrame(flushMeters);
      }
    }).then((nextUnlisten) => {
      if (!active) {
        nextUnlisten();
        return;
      }

      unlisten = nextUnlisten;
    });

    return () => {
      active = false;
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      pendingMeters = null;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const shell = timelineShellRef.current;
    if (!shell) {
      return;
    }

    const updateViewportWidth = () => {
      setTimelineViewportWidth(shell.clientWidth || DEFAULT_TIMELINE_VIEWPORT_WIDTH);
    };

    updateViewportWidth();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(updateViewportWidth);
      observer.observe(shell);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", updateViewportWidth);
    return () => {
      window.removeEventListener("resize", updateViewportWidth);
    };
  }, [song?.tracks.length]);

  useEffect(() => {
    let active = true;

    async function loadSong() {
      if (playbackProjectRevision === 0) {
        setSong(null);
        return;
      }

      const nextSong = await getSongView();
      if (!active) {
        return;
      }

      setSong(nextSong);
    }

    void loadSong();

    return () => {
      active = false;
    };
  }, [playbackProjectRevision]);

  useEffect(() => {
    if (!song) {
      setWaveformCache({});
    }
    // Mantenemos la caché viva entre revisiones del mismo proyecto.
    // Solo se limpia si cerramos la canción (!song) o cambiamos de proyecto.
  }, [song?.id]);

  useEffect(() => {
    if (!song) {
      return;
    }

    setTempoDraft(String(song.bpm));
  }, [song?.bpm, song?.projectRevision]);

  useEffect(() => {
    let active = true;

    async function loadMissingWaveforms() {
      if (!song) {
        return;
      }

      const missingWaveformKeys = song.clips
        .map((clip) => clip.waveformKey)
        .filter((waveformKey, index, keys) => keys.indexOf(waveformKey) === index)
        .filter((waveformKey) => !waveformCache[waveformKey]);

      if (!missingWaveformKeys.length) {
        return;
      }

      const summaries = await getWaveformSummaries(missingWaveformKeys);
      if (!active) {
        return;
      }

      setWaveformCache((current) => ({
        ...current,
        ...Object.fromEntries(summaries.map((summary) => [summary.waveformKey, summary])),
      }));
    }

    void loadMissingWaveforms();

    return () => {
      active = false;
    };
  }, [song, waveformCache]);

  useEffect(() => {
    if (playbackState === "playing") {
      return;
    }

    useTransportStore.getState().setMeters({});
  }, [playbackState, song?.projectRevision]);

  useEffect(() => {
    if (!song) {
      setClipsByTrack({});
      setTracksById({});
      return;
    }

    const nextTracksById = Object.fromEntries(song.tracks.map((track) => [track.id, track]));

    setTracksById(nextTracksById);
    setClipsByTrack((current) => buildMemoizedClipsByTrack(song, current));
  }, [song]);

  useEffect(() => {
    songDurationSecondsRef.current = song?.durationSeconds ?? 0;
  }, [song?.durationSeconds]);

  useEffect(() => {
    const songDurationSeconds = song?.durationSeconds ?? 0;
    songDurationSecondsRef.current = songDurationSeconds;

    if (!snapshotRef.current) {
      return;
    }

    applyTransportVisualAnchor(snapshotRef.current);
  }, [song?.durationSeconds]);

  useEffect(() => {
    const optimisticMixEntries = Object.entries(useTransportStore.getState().optimisticMix);

    if (!song) {
      for (const [trackId] of optimisticMixEntries) {
        useTransportStore.getState().setOptimisticMix(trackId, null);
      }
      trackMixRequestIdsRef.current = {};
      trackMixLiveStatesRef.current = {};
      return;
    }

    const nextTracksById = Object.fromEntries(song.tracks.map((track) => [track.id, track]));
    const validTrackIds = new Set(song.tracks.map((track) => track.id));

    for (const trackId of Object.keys(trackMixRequestIdsRef.current)) {
      if (validTrackIds.has(trackId)) {
        continue;
      }

      delete trackMixRequestIdsRef.current[trackId];
    }

    for (const trackId of Object.keys(trackMixLiveStatesRef.current)) {
      if (validTrackIds.has(trackId)) {
        continue;
      }

      delete trackMixLiveStatesRef.current[trackId];
    }

    for (const [trackId, optimisticMix] of optimisticMixEntries) {
      const track = nextTracksById[trackId];
      if (!track) {
        useTransportStore.getState().setOptimisticMix(trackId, null);
        continue;
      }

      const nextOptimisticMix: OptimisticMixState = {};
      if (optimisticMix.muted !== undefined && optimisticMix.muted !== track.muted) {
        nextOptimisticMix.muted = optimisticMix.muted;
      }
      if (optimisticMix.solo !== undefined && optimisticMix.solo !== track.solo) {
        nextOptimisticMix.solo = optimisticMix.solo;
      }
      if (optimisticMix.volume !== undefined && Math.abs(optimisticMix.volume - track.volume) >= 0.0001) {
        nextOptimisticMix.volume = optimisticMix.volume;
      }
      if (optimisticMix.pan !== undefined && Math.abs(optimisticMix.pan - track.pan) >= 0.0001) {
        nextOptimisticMix.pan = optimisticMix.pan;
      }

      useTransportStore.getState().setOptimisticMix(trackId, nextOptimisticMix);
    }
  }, [song]);

  useEffect(() => {
    return () => {
      if (renderMetricTimeoutRef.current !== null) {
        window.clearTimeout(renderMetricTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (playbackState !== "playing") {
      return;
    }

    let animationFrameId = 0;

    const tick = () => {
      if (playheadDragRef.current) {
        animationFrameId = window.requestAnimationFrame(tick);
        return;
      }

      const anchor = playbackVisualAnchorRef.current;
      const elapsedSeconds = anchor.running
        ? (performance.now() - anchor.anchorReceivedAtMs) / 1000
        : 0;
      const nextPositionSeconds = Math.min(
        anchor.durationSeconds || Number.MAX_SAFE_INTEGER,
        anchor.anchorPositionSeconds + elapsedSeconds,
      );

      if (anchor.durationSeconds > 0 && nextPositionSeconds >= anchor.durationSeconds) {
        const currentSnapshot = snapshotRef.current;
        const stoppedSnapshot =
          currentSnapshot?.playbackState === "playing"
            ? {
                ...currentSnapshot,
                playbackState: "stopped" as const,
                positionSeconds: 0,
                transportClock: currentSnapshot.transportClock
                  ? {
                      ...currentSnapshot.transportClock,
                      anchorPositionSeconds: 0,
                      running: false,
                    }
                  : currentSnapshot.transportClock,
              }
            : null;

        playbackVisualAnchorRef.current = {
          anchorPositionSeconds: 0,
          anchorReceivedAtMs: performance.now(),
          durationSeconds: anchor.durationSeconds,
          running: false,
        };
        displayPositionSecondsRef.current = 0;
        if (stoppedSnapshot) {
          applyPlaybackSnapshot(stoppedSnapshot);
        }
        return;
      }

      syncLivePosition(nextPositionSeconds);
      animationFrameId = window.requestAnimationFrame(tick);
    };

    animationFrameId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [applyPlaybackSnapshot, playbackState]);

  useEffect(() => {
    if (!isTauriApp || playbackState !== "playing") {
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

    const intervalId = window.setInterval(() => {
      void refreshSnapshot();
    }, 120);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [applyPlaybackSnapshot, playbackState]);

  useEffect(() => {
    const closeMenu = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }
      if (event.target instanceof HTMLElement && event.target.closest(".lt-context-menu")) {
        return;
      }
      setContextMenu(null);
    };
    const closeMenuOnBlur = () => setContextMenu(null);

    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("blur", closeMenuOnBlur);

    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("blur", closeMenuOnBlur);
    };
  }, []);

  useEffect(() => {
    if (!openTopMenu) {
      return;
    }

    const closeTopMenu = (event: PointerEvent) => {
      if (event.target instanceof Node && menuBarRef.current?.contains(event.target)) {
        return;
      }

      setOpenTopMenu(null);
    };
    const closeTopMenuOnBlur = () => setOpenTopMenu(null);

    window.addEventListener("pointerdown", closeTopMenu);
    window.addEventListener("blur", closeTopMenuOnBlur);

    return () => {
      window.removeEventListener("pointerdown", closeTopMenu);
      window.removeEventListener("blur", closeTopMenuOnBlur);
    };
  }, [openTopMenu]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTypingTarget =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable;

      if (isTypingTarget) {
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        void runAction(async () => {
          if (snapshotRef.current?.playbackState === "playing") {
            const nextSnapshot = await pauseTransport();
            applyPlaybackSnapshot(nextSnapshot);
            setStatus("Reproduccion pausada.");
            return;
          }

          const nextSnapshot = await playTransport();
          applyPlaybackSnapshot(nextSnapshot);
          setStatus("Reproduccion iniciada.");
        });
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();

        if (event.shiftKey) {
          handleSaveProjectAsClick();
          return;
        }

        handleSaveProjectClick();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void runAction(async () => {
          const nextSnapshot = event.shiftKey ? await redoAction() : await undoAction();
          applyPlaybackSnapshot(nextSnapshot);
          setStatus(event.shiftKey ? "Accion rehecha." : "Accion deshecha.");
        });
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        void runAction(async () => {
          const nextSnapshot = await redoAction();
          applyPlaybackSnapshot(nextSnapshot);
          setStatus("Accion rehecha.");
        });
        return;
      }

      const keyDigit = keyboardDigit(event.code);
      if (keyDigit !== null) {
        event.preventDefault();

        const marker = song ? resolveMarkerShortcut(song.sectionMarkers, keyDigit) : null;
        if (!marker) {
          setStatus(`No hay marca disponible para el digito ${keyDigit}.`);
          return;
        }

        void runAction(async () => {
          const pendingJump = snapshotRef.current?.pendingMarkerJump;
          if (pendingJump && pendingJump.targetMarkerId === marker.id) {
            const nextSnapshot = await cancelMarkerJump();
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(`Salto cancelado para digito ${keyDigit}.`);
            return;
          }

          await scheduleMarkerJumpWithGlobalMode(marker.id, marker.name);
        });

        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();

        if (openTopMenu) {
          setOpenTopMenu(null);
          return;
        }

        if (snapshotRef.current?.pendingMarkerJump) {
          void runAction(async () => {
            const nextSnapshot = await cancelMarkerJump();
            applyPlaybackSnapshot(nextSnapshot);
            setStatus("Salto cancelado.");
          });
          return;
        }

        clearSelections("Selecciones limpiadas.");
        return;
      }

      if (event.key === "Delete" && selectedClipId) {
        event.preventDefault();
        void runAction(async () => {
          const nextSnapshot = await deleteClip(selectedClipId);
          applyPlaybackSnapshot(nextSnapshot);
          setSelectedClipId(null);
          setStatus("Clip eliminado.");
        });
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [
    applyPlaybackSnapshot,
    clearSelections,
    handleSaveProjectAsClick,
    handleSaveProjectClick,
    openTopMenu,
    runAction,
    scheduleMarkerJumpWithGlobalMode,
    selectedClipId,
    song,
  ]);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      const clipDrag = clipDragRef.current;
      const effectSong = songRef.current;
      if (clipDrag && effectSong) {
        const effectPixelsPerSecond = zoomLevel * BASE_PIXELS_PER_SECOND;
        const exceededThreshold = Math.abs(event.clientX - clipDrag.startClientX) > DRAG_THRESHOLD_PX;
        const deltaSeconds = (event.clientX - clipDrag.startClientX) / effectPixelsPerSecond;
        const nextSeconds = snapEnabled
          ? snapToTimelineGrid(
              clipDrag.originSeconds + deltaSeconds,
              effectSong.bpm,
              effectSong.timeSignature,
              zoomLevel,
              effectPixelsPerSecond,
            )
          : clipDrag.originSeconds + deltaSeconds;

        const nextDrag = {
          ...clipDrag,
          hasMoved: clipDrag.hasMoved || exceededThreshold,
          previewSeconds: clamp(nextSeconds, 0, effectSong.durationSeconds),
        };
        clipDragRef.current = nextDrag;
        clipPreviewSecondsRef.current = { [nextDrag.clipId]: nextDrag.previewSeconds };
        if (nextDrag.hasMoved) {
          queueClipMoveLiveUpdate(nextDrag.clipId, nextDrag.previewSeconds);
        }
      }

      const playheadDrag = playheadDragRef.current;
      if (playheadDrag && songRef.current && rulerTrackRef.current) {
        const effectSong = songRef.current;
        const effectPixelsPerSecond = zoomLevel * BASE_PIXELS_PER_SECOND;
        const effectCameraX = getCameraX({
          durationSeconds: effectSong.durationSeconds,
          pixelsPerSecond: effectPixelsPerSecond,
        });
        const rawSeconds = rulerPointerToSeconds(
          event,
          rulerTrackRef.current,
          effectSong.durationSeconds,
          effectCameraX,
          effectPixelsPerSecond,
        );
        const nextSeconds = snapEnabled
          ? snapToTimelineGrid(
              rawSeconds,
              effectSong.bpm,
              effectSong.timeSignature,
              zoomLevel,
              effectPixelsPerSecond,
            )
          : rawSeconds;

        playheadDragRef.current = {
          ...playheadDrag,
          currentSeconds: nextSeconds,
        };
        syncLivePosition(nextSeconds);
      }

      const trackDrag = trackDragRef.current;
      if (trackDrag && songRef.current) {
        const exceededThreshold =
          Math.abs(event.clientX - trackDrag.startClientX) > DRAG_THRESHOLD_PX ||
          Math.abs(event.clientY - trackDrag.startClientY) > DRAG_THRESHOLD_PX;
        const isDraggingNow = trackDrag.isDragging || exceededThreshold;
        const nextDrag = {
          ...trackDrag,
          currentClientY: event.clientY,
          isDragging: isDraggingNow,
        };
        trackDragRef.current = nextDrag;

        if (!isDraggingNow) {
          return;
        }

        const dropState = resolveTrackDropState(
          songRef.current,
          trackDrag.trackId,
          event.clientX,
          event.clientY,
        );
        applyTrackDragVisuals(nextDrag, dropState);
      }
    };

    const onMouseUp = (event: MouseEvent) => {
      if (event.button !== 0) {
        return;
      }

      const activeClipDrag = clipDragRef.current;
      clipDragRef.current = null;
      if (activeClipDrag) {
        const movedEnough =
          activeClipDrag.hasMoved ||
          Math.abs(event.clientX - activeClipDrag.startClientX) > DRAG_THRESHOLD_PX;
        if (movedEnough) {
          queueClipMoveLiveUpdate(activeClipDrag.clipId, activeClipDrag.previewSeconds);
          void runAction(async () => {
            await waitForClipMoveLiveIdle(activeClipDrag.clipId);
            const nextSnapshot = await moveClip(activeClipDrag.clipId, activeClipDrag.previewSeconds);
            applyPlaybackSnapshot(nextSnapshot);
            const clip = findClip(songRef.current, activeClipDrag.clipId);
            setStatus(`Clip movido: ${clip?.trackName ?? activeClipDrag.clipId}`);
          });
        } else {
          clipPreviewSecondsRef.current = {};
        }
      } else {
        clipPreviewSecondsRef.current = {};
      }

      const activePlayheadDrag = playheadDragRef.current;
      if (activePlayheadDrag) {
        playheadDragRef.current = null;
        playheadHandleRef.current?.classList.remove("is-dragging");
        void runAction(async () => {
          await performSeek(activePlayheadDrag.currentSeconds);
        });
      }

      const activeTrackDrag = trackDragRef.current;
      if (activeTrackDrag) {
        const currentSong = songRef.current;
        const movedEnough =
          Math.abs(event.clientX - activeTrackDrag.startClientX) > DRAG_THRESHOLD_PX ||
          Math.abs(event.clientY - activeTrackDrag.startClientY) > DRAG_THRESHOLD_PX;
        const shouldTreatAsDrag = Boolean(currentSong) && (activeTrackDrag.isDragging || movedEnough);
        const dropState = shouldTreatAsDrag && currentSong
          ? resolveTrackDropState(
              currentSong,
              activeTrackDrag.trackId,
              event.clientX,
              event.clientY,
            )
          : null;

        trackDragRef.current = null;
        suppressTrackClickRef.current = shouldTreatAsDrag;
        clearTrackDragVisuals();

        if (dropState) {
          void handleTrackDrop(activeTrackDrag.trackId, dropState);
        }
      }

      timelinePanRef.current = null;
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [
    applyPlaybackSnapshot,
    applyTrackDragVisuals,
    clearTrackDragVisuals,
    handleTrackDrop,
    performSeek,
    runAction,
    snapEnabled,
    waitForClipMoveLiveIdle,
    zoomLevel,
  ]);

  useEffect(() => {
    return () => {
      clearTrackDragVisuals();
      playheadHandleRef.current?.classList.remove("is-dragging");
    };
  }, [clearTrackDragVisuals]);

  function getCameraX(options?: {
    cameraX?: number;
    durationSeconds?: number;
    pixelsPerSecond?: number;
    viewportWidth?: number;
  }) {
    return clampCameraX(
      options?.cameraX ?? cameraXRef.current,
      options?.durationSeconds ?? songRef.current?.durationSeconds ?? 0,
      options?.pixelsPerSecond ?? pixelsPerSecond,
      options?.viewportWidth ?? laneViewportWidth,
    );
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
    const durationSeconds = options?.durationSeconds ?? songRef.current?.durationSeconds ?? 0;
    const clampedPosition = clamp(positionSeconds, 0, durationSeconds || Number.MAX_SAFE_INTEGER);
    const playheadOffset = secondsToScreenX(
      clampedPosition,
      getCameraX(options),
      options?.pixelsPerSecond ?? pixelsPerSecond,
    );
    const snappedPlayheadOffset = Math.round(playheadOffset) + 0.5;

    displayPositionSecondsRef.current = clampedPosition;
    panelRef.current?.style.setProperty("--lt-playhead-left", `${snappedPlayheadOffset}px`);

    if (transportReadoutValueRef.current) {
      transportReadoutValueRef.current.textContent = formatClock(clampedPosition);
    }

    if (transportReadoutBarRef.current) {
      transportReadoutBarRef.current.textContent = formatMusicalPosition(
        clampedPosition,
        songRef.current?.bpm ?? 120,
        songRef.current?.timeSignature ?? "4/4",
      );
    }
  }

  function updateCameraX(
    nextCameraX: number,
    options?: {
      durationSeconds?: number;
      pixelsPerSecond?: number;
      viewportWidth?: number;
      syncPlayhead?: boolean;
    },
  ) {
    const durationSeconds = options?.durationSeconds ?? songRef.current?.durationSeconds ?? 0;
    const effectivePixelsPerSecond = options?.pixelsPerSecond ?? pixelsPerSecond;
    const viewportWidth = options?.viewportWidth ?? laneViewportWidth;
    const clampedCameraX = clampCameraX(
      nextCameraX,
      durationSeconds,
      effectivePixelsPerSecond,
      viewportWidth,
    );

    cameraXRef.current = clampedCameraX;
    panelRef.current?.style.setProperty("--lt-camera-x", `${clampedCameraX}px`);

    const shell = timelineShellRef.current;
    if (shell && Math.abs(shell.scrollLeft - clampedCameraX) > 0.5) {
      shell.scrollLeft = clampedCameraX;
    }

    const horizontalScrollbar = horizontalScrollbarRef.current;
    if (horizontalScrollbar && Math.abs(horizontalScrollbar.scrollLeft - clampedCameraX) > 0.5) {
      horizontalScrollbar.scrollLeft = clampedCameraX;
    }

    if (options?.syncPlayhead !== false) {
      syncLivePosition(playheadDragRef.current?.currentSeconds ?? displayPositionSecondsRef.current, {
        cameraX: clampedCameraX,
        durationSeconds,
        pixelsPerSecond: effectivePixelsPerSecond,
        viewportWidth,
      });
    }

    return clampedCameraX;
  }

  function previewSeek(positionSeconds: number) {
    const durationSeconds = song?.durationSeconds ?? 0;
    const clampedPosition = clamp(positionSeconds, 0, durationSeconds || Number.MAX_SAFE_INTEGER);

    playbackVisualAnchorRef.current = {
      anchorPositionSeconds: clampedPosition,
      anchorReceivedAtMs: performance.now(),
      durationSeconds,
      running: false,
    };
    syncLivePosition(clampedPosition);
  }

  function restoreConfirmedTransportVisual() {
    if (snapshotRef.current) {
      applyTransportVisualAnchor(snapshotRef.current);
      return;
    }

    playbackVisualAnchorRef.current = {
      anchorPositionSeconds: 0,
      anchorReceivedAtMs: performance.now(),
      durationSeconds: songDurationSecondsRef.current,
      running: false,
    };
    syncLivePosition(0);
  }

  async function performSeek(positionSeconds: number) {
    previewSeek(positionSeconds);

    try {
      const nextSnapshot = await seekTransport(positionSeconds);
      applyPlaybackSnapshot(nextSnapshot);
      setStatus(`Cursor movido a ${formatClock(nextSnapshot.positionSeconds)}`);
    } catch (error) {
      restoreConfirmedTransportVisual();
      throw error;
    }
  }

  function snappedRulerSeconds(event: MouseEvent | ReactMouseEvent, durationSeconds: number) {
    const rawSeconds = rulerPointerToSeconds(
      event,
      rulerTrackRef.current as HTMLElement,
      durationSeconds,
      getCameraX(),
      pixelsPerSecond,
    );

    return snapEnabled
      ? snapToTimelineGrid(rawSeconds, song?.bpm ?? 120, song?.timeSignature ?? "4/4", zoomLevel, pixelsPerSecond)
      : rawSeconds;
  }

  const laneViewportWidth = Math.max(320, timelineViewportWidth - HEADER_WIDTH);
  const timelineFitViewportWidth = Math.max(
    320,
    laneViewportWidth - Math.min(TIMELINE_FIT_RIGHT_GUTTER_PX, laneViewportWidth * 0.16),
  );
  const fitAllZoomLevel = song?.durationSeconds
    ? clamp(
        timelineFitViewportWidth / (Math.max(song.durationSeconds, 1) * BASE_PIXELS_PER_SECOND),
        ZOOM_MIN,
        ZOOM_MAX,
      )
    : ZOOM_MIN;
  const effectiveZoomMin = song ? fitAllZoomLevel : ZOOM_MIN;
  const pixelsPerSecond = zoomLevel * BASE_PIXELS_PER_SECOND;
  const maxTimelineCameraX = getMaxCameraX(song?.durationSeconds ?? 0, pixelsPerSecond, laneViewportWidth);
  const pendingMarkerJump = pendingMarkerJumpSignature
    ? snapshotRef.current?.pendingMarkerJump ?? null
    : null;
  const readoutPositionSeconds = displayPositionSecondsRef.current;
  const musicalPositionLabel = song
    ? formatMusicalPosition(readoutPositionSeconds, song.bpm, song.timeSignature)
    : "1.1.00";
  const tempoSourceLabel =
    song?.tempoMetadata.source === "auto_import"
      ? `Detectado en importacion${song.tempoMetadata.confidence != null ? ` (${Math.round(song.tempoMetadata.confidence * 100)}%)` : ""}`
      : "Manual";
  const canPersistProject = Boolean(song);
  const isProjectEmpty = !song || song.tracks.length === 0;
  const isProjectPending = Boolean(playbackProjectRevision > 0 && !song);
  const shouldShowEmptyState = !isProjectPending && isProjectEmpty;
  const timelineRowWidth = HEADER_WIDTH + laneViewportWidth;
  const visibleTracks = song ? buildVisibleTracks(song, collapsedFolders) : [];
  const timelineGrid = useTimelineGrid({
    durationSeconds: song?.durationSeconds ?? 0,
    bpm: song?.bpm ?? 120,
    timeSignature: song?.timeSignature ?? "4/4",
    zoomLevel,
    pixelsPerSecond,
    viewportStartSeconds: 0,
    viewportEndSeconds: song?.durationSeconds ?? 0,
  });
  const timelineHeaderMarkers = useMemo(
    () =>
      timelineGrid.markers.filter((marker) =>
        timelineGrid.showBeatLabels
          ? true
          : marker.isBarStart && (marker.barNumber - 1) % timelineGrid.barLabelStep === 0,
      ),
    [timelineGrid.barLabelStep, timelineGrid.markers, timelineGrid.showBeatLabels],
  );

  async function scheduleMarkerJumpWithGlobalMode(markerId: string, markerName: string) {
    const trigger =
      globalJumpMode === "after_bars" ? "after_bars" : globalJumpMode;
    const bars = Math.max(1, Math.floor(globalJumpBars));
    const nextSnapshot = await scheduleMarkerJump(
      markerId,
      trigger,
      trigger === "after_bars" ? bars : undefined,
    );
    applyPlaybackSnapshot(nextSnapshot);

    if (trigger === "next_marker" && !nextSnapshot.pendingMarkerJump) {
      setStatus("Aviso: no quedan marcas por delante; salto en la siguiente marca ignorado.");
      return nextSnapshot;
    }

    setStatus(
      trigger === "immediate"
        ? `Salto inmediato a ${markerName}.`
        : trigger === "next_marker"
          ? `Salto armado en la siguiente marca hacia ${markerName}.`
          : `Salto armado en ${bars} compases hacia ${markerName}.`,
    );

    return nextSnapshot;
  }

  async function handleMarkerPrimaryAction(section: SectionMarkerSummary) {
    setSelectedSectionId(section.id);
    setSelectedClipId(null);
    setSelectedTrackId(null);
    setContextMenu(null);

    if (snapshotRef.current?.pendingMarkerJump?.targetMarkerId === section.id) {
      const nextSnapshot = await cancelMarkerJump();
      applyPlaybackSnapshot(nextSnapshot);
      setStatus(`Salto cancelado para ${section.name}.`);
      return;
    }

    await scheduleMarkerJumpWithGlobalMode(section.id, section.name);
  }

  useEffect(() => {
    setZoomLevel((current) => (current < effectiveZoomMin ? effectiveZoomMin : current));
  }, [effectiveZoomMin]);

  useEffect(() => {
    updateCameraX(cameraXRef.current, {
      durationSeconds: song?.durationSeconds ?? 0,
      pixelsPerSecond,
      viewportWidth: laneViewportWidth,
    });
  }, [laneViewportWidth, pixelsPerSecond, song?.durationSeconds]);

  useEffect(() => {
    syncLivePosition(playheadDragRef.current?.currentSeconds ?? displayPositionSecondsRef.current);
  }, [
    pixelsPerSecond,
    song?.bpm,
    song?.durationSeconds,
    song?.timeSignature,
  ]);

  function clearSelections(message: string) {
    setSelectedTrackId(null);
    setSelectedClipId(null);
    setSelectedSectionId(null);
    setContextMenu(null);
    setStatus(message);
  }

  function rulerContextMenu(positionSeconds: number): ContextMenuAction[] {
    return [
      {
        label: "Create marker",
        onSelect: async () => {
          await runAction(async () => {
            const nextSnapshot = await createSectionMarker(positionSeconds);
            applyPlaybackSnapshot(nextSnapshot);
            setSelectedClipId(null);
            setSelectedTrackId(null);
            setSelectedSectionId(null);
            setStatus(`Marca creada en ${formatClock(positionSeconds)}.`);
          });
        },
      },
    ];
  }

  function applyZoom(nextZoomLevel: number, anchorViewportX = laneViewportWidth / 2) {
    const clampedZoom = clamp(nextZoomLevel, effectiveZoomMin, ZOOM_MAX);
    const nextPixelsPerSecond = clampedZoom * BASE_PIXELS_PER_SECOND;
    const durationSeconds = song?.durationSeconds ?? 0;
    const nextCameraX = zoomCameraAtViewportX({
      durationSeconds,
      viewportWidth: laneViewportWidth,
      viewportX: clamp(anchorViewportX, 0, laneViewportWidth),
      currentCameraX: getCameraX(),
      previousPixelsPerSecond: pixelsPerSecond,
      nextPixelsPerSecond,
    });

    setZoomLevel(clampedZoom);
    updateCameraX(nextCameraX, {
      durationSeconds,
      pixelsPerSecond: nextPixelsPerSecond,
      viewportWidth: laneViewportWidth,
    });
  }

  function applyTrackHeight(nextTrackHeight: number) {
    setTrackHeight(clamp(Math.round(nextTrackHeight), TRACK_HEIGHT_MIN, TRACK_HEIGHT_MAX));
  }

  function handleTimelineWheel(event: WheelEvent, shell: HTMLDivElement) {
    if (!song) {
      return;
    }

    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      applyTrackHeight(trackHeight + (event.deltaY < 0 ? TRACK_HEIGHT_STEP : -TRACK_HEIGHT_STEP));
      return;
    }

    if (isTrackInfoScrollTarget(event.target)) {
      return;
    }

    event.preventDefault();
    if (!isTimelineZoomTarget(event.target)) {
      return;
    }

    const bounds = shell.getBoundingClientRect();
    const anchorViewportX = clamp(event.clientX - bounds.left - HEADER_WIDTH, 0, laneViewportWidth);

    applyZoom(
      zoomLevel + (event.deltaY < 0 ? ZOOM_WHEEL_STEP : -ZOOM_WHEEL_STEP),
      anchorViewportX,
    );
  }

  useEffect(() => {
    const shell = timelineShellRef.current;
    if (!shell) {
      return;
    }

    const onWheel = (event: WheelEvent) => {
      handleTimelineWheel(event, shell);
    };

    shell.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
      shell.removeEventListener("wheel", onWheel, true);
    };
  }, [handleTimelineWheel, laneViewportWidth, song, trackHeight, zoomLevel]);

  async function handleTrackDrop(trackId: string, dropState: NonNullable<TrackDropState>) {
    const targetTrack = tracksById[dropState.targetTrackId] ?? null;
    if (!song || !targetTrack || trackId === targetTrack.id) {
      return;
    }

    const moveArgs =
      dropState.mode === "inside-folder"
        ? {
            trackId,
            insertAfterTrackId: null,
            insertBeforeTrackId: null,
            parentTrackId: targetTrack.id,
          }
        : dropState.mode === "before"
          ? {
              trackId,
              insertAfterTrackId: null,
              insertBeforeTrackId: targetTrack.id,
              parentTrackId: targetTrack.parentTrackId ?? null,
            }
          : {
              trackId,
              insertAfterTrackId: targetTrack.id,
              insertBeforeTrackId: null,
              parentTrackId: targetTrack.parentTrackId ?? null,
            };

    await runAction(async () => {
      const nextSnapshot = await moveTrack(moveArgs);
      applyPlaybackSnapshot(nextSnapshot);
      setStatus(
        dropState.mode === "inside-folder"
          ? `Track movido dentro de ${targetTrack.name}.`
          : dropState.mode === "before"
            ? `Track reordenado encima de ${targetTrack.name}.`
            : `Track reordenado debajo de ${targetTrack.name}.`,
      );
    });
  }

  function openMenu(
    event: ReactMouseEvent,
    title: string,
    actions: ContextMenuAction[],
  ) {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      title,
      actions,
    });
  }

  async function handleCreateTrack(kind: TrackKind, anchorTrack: TrackSummary | null, parentTrackId?: string | null) {
    const defaultName = kind === "folder" ? "Folder track" : "Audio track";
    const name = window.prompt("Nombre del track", defaultName)?.trim();
    if (!name) {
      return;
    }

    await runAction(async () => {
      const nextSnapshot = await createTrack({
        name,
        kind,
        insertAfterTrackId: anchorTrack?.id ?? null,
        parentTrackId: parentTrackId ?? null,
      });
      applyPlaybackSnapshot(nextSnapshot);
      setStatus(`Track creado: ${name}`);
    });
  }

  function trackContextMenu(track: TrackSummary) {
    const currentSong = songRef.current;
    if (!currentSong) {
      return [];
    }

    const previousFolder = findPreviousFolderTrack(currentSong, track.id);
    const parentTrack = findTrack(currentSong, track.parentTrackId ?? null);
    const parentOfParent = parentTrack?.parentTrackId ?? null;

    return [
      {
        label: "Insertar track",
        onSelect: () => handleCreateTrack("audio", track, track.parentTrackId ?? null),
      },
      {
        label: "Insertar folder track",
        onSelect: () => handleCreateTrack("folder", track, track.parentTrackId ?? null),
      },
      {
        label: "Renombrar",
        onSelect: async () => {
          const nextName = window.prompt("Nuevo nombre del track", track.name)?.trim();
          if (!nextName) {
            return;
          }
          await runAction(async () => {
            const nextSnapshot = await updateTrack({ trackId: track.id, name: nextName });
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(`Track renombrado: ${nextName}`);
          });
        },
      },
      {
        label: "Borrar",
        onSelect: async () => {
          const clipCount = currentSong.clips.filter((clip) => clip.trackId === track.id).length;
          if (
            track.kind === "audio" &&
            clipCount > 0 &&
            !window.confirm("Este audio track tiene clips. ¿Quieres borrarlo junto con sus clips?")
          ) {
            return;
          }

          await runAction(async () => {
            const nextSnapshot = await deleteTrack(track.id);
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(`Track borrado: ${track.name}`);
          });
        },
      },
      {
        label: "Indentar dentro del folder anterior",
        disabled: !previousFolder,
        onSelect: async () => {
          if (!previousFolder) {
            return;
          }
          await runAction(async () => {
            const nextSnapshot = await moveTrack({
              trackId: track.id,
              parentTrackId: previousFolder.id,
            });
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(`Track movido dentro de ${previousFolder.name}`);
          });
        },
      },
      {
        label: "Sacar del folder",
        disabled: !track.parentTrackId,
        onSelect: async () => {
          await runAction(async () => {
            const nextSnapshot = await moveTrack({
              trackId: track.id,
              insertAfterTrackId: track.parentTrackId ?? null,
              parentTrackId: parentOfParent,
            });
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(`Track sacado del folder: ${track.name}`);
          });
        },
      },
    ];
  }

  const handleTrackHeaderSelect = useCallback((trackId: string, trackName: string) => {
    if (suppressTrackClickRef.current) {
      suppressTrackClickRef.current = false;
      return;
    }

    setSelectedTrackId(trackId);
    setSelectedClipId(null);
    setSelectedSectionId(null);
    setStatus(`Track seleccionado: ${trackName}`);
  }, []);

  function handleTrackHeaderContextMenu(event: ReactMouseEvent<HTMLDivElement>, trackId: string) {
    const track = findTrack(songRef.current, trackId);
    if (!track) {
      return;
    }

    setSelectedTrackId(track.id);
    openMenu(event, track.name, trackContextMenu(track));
  }

  const handleTrackHeaderDragStart = useCallback(
    (event: ReactMouseEvent<HTMLElement>, trackId: string) => {
      if (event.button !== 0) {
        return;
      }

      event.stopPropagation();
      setContextMenu(null);
      const headerElement = event.currentTarget.closest(".lt-track-header") as HTMLDivElement | null;
      trackDragRef.current = {
        trackId,
        pointerId: 1,
        startClientX: event.clientX,
        startClientY: event.clientY,
        currentClientY: event.clientY,
        isDragging: false,
        rowElement: event.currentTarget.closest(".lt-track-row") as HTMLDivElement | null,
        headerElement,
      };
    },
    [],
  );

  const handleTrackHeaderFolderToggle = useCallback((trackId: string) => {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(trackId)) {
        next.delete(trackId);
      } else {
        next.add(trackId);
      }
      return next;
    });
  }, []);

  const handleTrackHeaderMuteToggle = useCallback((trackId: string) => {
    const track = findTrack(songRef.current, trackId);
    if (!track) {
      return;
    }

    patchTrackOptimisticMix(trackId, {
      muted: !resolveTrackMix(track, trackId).muted,
    });
    queueTrackMixLiveUpdate(trackId, ["muted"]);

    void runAction(async () => {
      await persistTrackMix(trackId, ["muted"]);
    });
  }, [patchTrackOptimisticMix, persistTrackMix, queueTrackMixLiveUpdate, resolveTrackMix, runAction]);

  const handleTrackHeaderSoloToggle = useCallback((trackId: string) => {
    const track = findTrack(songRef.current, trackId);
    if (!track) {
      return;
    }

    patchTrackOptimisticMix(trackId, {
      solo: !resolveTrackMix(track, trackId).solo,
    });
    queueTrackMixLiveUpdate(trackId, ["solo"]);

    void runAction(async () => {
      await persistTrackMix(trackId, ["solo"]);
    });
  }, [patchTrackOptimisticMix, persistTrackMix, queueTrackMixLiveUpdate, resolveTrackMix, runAction]);

  const handleTrackHeaderVolumeChange = useCallback((trackId: string, nextVolume: number) => {
    patchTrackOptimisticMix(trackId, {
      volume: clamp(nextVolume, 0, 1),
    });
    queueTrackMixLiveUpdate(trackId, ["volume"]);
  }, [patchTrackOptimisticMix, queueTrackMixLiveUpdate]);

  const handleTrackHeaderVolumeCommit = useCallback((trackId: string) => {
    void runAction(async () => {
      await persistTrackMix(trackId, ["volume"]);
    });
  }, [persistTrackMix, runAction]);

  const handleTrackHeaderPanChange = useCallback((trackId: string, nextPan: number) => {
    patchTrackOptimisticMix(trackId, {
      pan: clamp(nextPan, -1, 1),
    });
    queueTrackMixLiveUpdate(trackId, ["pan"]);
  }, [patchTrackOptimisticMix, queueTrackMixLiveUpdate]);

  const handleTrackHeaderPanCommit = useCallback((trackId: string) => {
    void runAction(async () => {
      await persistTrackMix(trackId, ["pan"]);
    });
  }, [persistTrackMix, runAction]);

  function clipContextMenu(clip: ClipSummary) {
    const currentCursorSeconds = displayPositionSecondsRef.current;
    const canSplit =
      currentCursorSeconds > clip.timelineStartSeconds &&
      currentCursorSeconds < clip.timelineStartSeconds + clip.durationSeconds;

    return [
      {
        label: "Cortar en cursor",
        disabled: !canSplit,
        onSelect: async () => {
          await runAction(async () => {
            const nextSnapshot = await splitClip(clip.id, currentCursorSeconds);
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(`Clip cortado en ${formatClock(currentCursorSeconds)}`);
          });
        },
      },
      {
        label: "Duplicar",
        onSelect: async () => {
          await runAction(async () => {
            const nextSnapshot = await duplicateClip(
              clip.id,
              clip.timelineStartSeconds + clip.durationSeconds + 1,
            );
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(`Clip duplicado: ${clip.trackName}`);
          });
        },
      },
      {
        label: "Borrar",
        onSelect: async () => {
          await runAction(async () => {
            const nextSnapshot = await deleteClip(clip.id);
            applyPlaybackSnapshot(nextSnapshot);
            setSelectedClipId(null);
            setStatus(`Clip eliminado: ${clip.trackName}`);
          });
        },
      },
    ];
  }

  function handleTrackLaneMouseDown(
    event: ReactMouseEvent<HTMLDivElement>,
    track: TrackSummary,
    trackClips: ClipSummary[],
  ) {
    if (event.button !== 0 || isInteractiveTimelineTarget(event.target)) {
      return;
    }

    const hitClip = lanePointerToClip(
      trackClips,
      event.currentTarget,
      event.clientX,
      getCameraX(),
      pixelsPerSecond,
    );

    if (hitClip) {
      event.preventDefault();
      setSelectedClipId(hitClip.id);
      setSelectedTrackId(track.id);
      setSelectedSectionId(null);
      setContextMenu(null);
      clipDragRef.current = {
        clipId: hitClip.id,
        pointerId: 1,
        originSeconds: hitClip.timelineStartSeconds,
        previewSeconds: hitClip.timelineStartSeconds,
        startClientX: event.clientX,
        hasMoved: false,
      };
      clipPreviewSecondsRef.current = { [hitClip.id]: hitClip.timelineStartSeconds };
      return;
    }

    event.preventDefault();
    setContextMenu(null);
    const panOriginCameraX = timelineShellRef.current?.scrollLeft ?? getCameraX();
    const activePan: NonNullable<TimelinePanState> = {
      pointerId: 1,
      startClientX: event.clientX,
      originCameraX: panOriginCameraX,
    };
    timelinePanRef.current = activePan;

    const onMouseMove = (windowEvent: MouseEvent) => {
      const deltaX = activePan.startClientX - windowEvent.clientX;
      updateCameraX(activePan.originCameraX + deltaX);
    };

    const onMouseUp = (windowEvent: MouseEvent) => {
      if (windowEvent.button !== 0) {
        return;
      }

      timelinePanRef.current = null;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  function handleTrackLaneContextMenu(
    event: ReactMouseEvent<HTMLDivElement>,
    track: TrackSummary,
    trackClips: ClipSummary[],
  ) {
    const hitClip = lanePointerToClip(
      trackClips,
      event.currentTarget,
      event.clientX,
      getCameraX(),
      pixelsPerSecond,
    );

    if (hitClip) {
      setSelectedClipId(hitClip.id);
      setSelectedTrackId(track.id);
      setSelectedSectionId(null);
      openMenu(event, hitClip.trackName, clipContextMenu(hitClip));
      return;
    }

    setSelectedClipId(null);
    setSelectedTrackId(track.id);
    setSelectedSectionId(null);
    openMenu(event, track.name, trackContextMenu(track));
  }

  function sectionContextMenu(section: SectionMarkerSummary) {
    const canEditMarker = Boolean(section);

    return [
      {
        label: "Jump to this marker",
        disabled: !canEditMarker,
        onSelect: async () => {
          await runAction(async () => {
            const nextSnapshot = await scheduleMarkerJump(section.id, "immediate");
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(`Cursor enviado a ${section.name}`);
          });
        },
      },
      {
        label: "Rename",
        disabled: !canEditMarker,
        onSelect: async () => {
          const nextName = window.prompt("Nuevo nombre de la marca", section.name)?.trim();
          if (!nextName) {
            return;
          }
          await runAction(async () => {
            const nextSnapshot = await updateSectionMarker(section.id, nextName, section.startSeconds);
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(`Marca renombrada: ${nextName}`);
          });
        },
      },
      {
        label: "Delete",
        disabled: !canEditMarker,
        onSelect: async () => {
          await runAction(async () => {
            const nextSnapshot = await deleteSectionMarker(section.id);
            applyPlaybackSnapshot(nextSnapshot);
            setSelectedSectionId(null);
            setStatus(`Marca eliminada: ${section.name}`);
          });
        },
      },
    ];
  }

  function handlePanelRender(
    _id: string,
    _phase: "mount" | "update" | "nested-update",
    actualDuration: number,
  ) {
    pendingRenderMetricRef.current = actualDuration;
    if (renderMetricTimeoutRef.current !== null) {
      return;
    }

    renderMetricTimeoutRef.current = window.setTimeout(() => {
      renderMetricTimeoutRef.current = null;
      void reportUiRenderMetric(pendingRenderMetricRef.current);
    }, 250);
  }

  async function importFromModal() {
    setIsImportingFromModal(true);
    await runAction(
      async () => {
        const nextSnapshot = await pickAndImportSong();
        if (nextSnapshot) {
          applyPlaybackSnapshot(nextSnapshot);
        }
        setStatus("Importacion de audio ejecutada.");
        setIsImportModalOpen(false);
      },
      { busy: true },
    );
    setIsImportingFromModal(false);
  }

  function handleCreateSongClick() {
    void runAction(
      async () => {
        const nextSnapshot = await createSong();
        if (!nextSnapshot) {
          return;
        }

        applyPlaybackSnapshot(nextSnapshot);
        setStatus(
          nextSnapshot.songFilePath
            ? `Proyecto creado en ${nextSnapshot.songFilePath}.`
            : "Proyecto creado.",
        );
      },
      { busy: true },
    );
  }

  function handleOpenProjectClick() {
    void runAction(async () => applyPlaybackSnapshot((await openProject()) ?? snapshotRef.current), { busy: true });
  }

  function handleToggleTopMenu(menuKey: "file") {
    setOpenTopMenu((currentMenu) => (currentMenu === menuKey ? null : menuKey));
  }

  function handleTopMenuAction(action: () => void) {
    setOpenTopMenu(null);
    action();
  }

  function handleSaveProjectClick() {
    void runAction(
      async () => {
        const nextSnapshot = await saveProject();
        applyPlaybackSnapshot(nextSnapshot);
        setStatus(
          nextSnapshot.songFilePath
            ? `Proyecto guardado en ${nextSnapshot.songFilePath}.`
            : "Proyecto guardado.",
        );
      },
      { busy: true },
    );
  }

  function handleSaveProjectAsClick() {
    void runAction(
      async () => {
        const nextSnapshot = await saveProjectAs();
        if (!nextSnapshot) {
          return;
        }

        applyPlaybackSnapshot(nextSnapshot);
        setStatus(
          nextSnapshot.songFilePath
            ? `Proyecto guardado en ${nextSnapshot.songFilePath}.`
            : "Proyecto guardado en nueva ubicacion.",
        );
      },
      { busy: true },
    );
  }

  function handleImportWavsClick() {
    setIsImportModalOpen(true);
  }

  return (
    <Profiler id="transport-panel" onRender={handlePanelRender}>
      <div className="lt-daw-shell" ref={panelRef} onContextMenu={(event) => event.preventDefault()}>
      {isBusy ? (
        <div className="busy-overlay" aria-live="polite">
          <div className="busy-overlay-card">
            <strong>Aplicando cambios</strong>
            <p>Sincronizando el estado del proyecto y del timeline.</p>
          </div>
        </div>
      ) : null}

      <header className="lt-topbar">
        <div className="lt-topbar-menu-row">
          <div className="lt-brand">
            <span className="lt-brand-title">LIBRETRACKS</span>
          </div>

          <nav className="lt-menu-bar" aria-label="Menu principal" ref={menuBarRef}>
            <div className={`lt-top-menu ${openTopMenu === "file" ? "is-open" : ""}`}>
              <button
                type="button"
                className="lt-top-menu-trigger"
                aria-haspopup="menu"
                aria-expanded={openTopMenu === "file"}
                onClick={() => handleToggleTopMenu("file")}
              >
                <span className="lt-button-label">Archivo</span>
                <span className="material-symbols-outlined" aria-hidden="true">arrow_drop_down</span>
              </button>

              {openTopMenu === "file" ? (
                <div className="lt-top-menu-dropdown" role="menu" aria-label="Archivo">
                  <button type="button" role="menuitem" onClick={() => handleTopMenuAction(handleCreateSongClick)}>
                    <span>Nuevo proyecto</span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => handleTopMenuAction(handleOpenProjectClick)}>
                    <span>Abrir</span>
                  </button>
                  <div className="lt-top-menu-separator" aria-hidden="true" />
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!canPersistProject}
                    onClick={() => handleTopMenuAction(handleSaveProjectClick)}
                  >
                    <span>Guardar</span>
                    <span className="lt-top-menu-shortcut">Ctrl+S</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!canPersistProject}
                    onClick={() => handleTopMenuAction(handleSaveProjectAsClick)}
                  >
                    <span>Guardar como</span>
                    <span className="lt-top-menu-shortcut">Ctrl+Shift+S</span>
                  </button>
                  <div className="lt-top-menu-separator" aria-hidden="true" />
                  <button type="button" role="menuitem" onClick={() => handleTopMenuAction(handleImportWavsClick)}>
                    <span>Importar WAVs</span>
                  </button>
                </div>
              ) : null}
            </div>
          </nav>
        </div>

        <div className="lt-topbar-main-row">
          <div className="lt-transport">
          <label className="lt-bpm-control">
            <span>BPM</span>
            <input
              aria-label="BPM de la cancion"
              disabled={isProjectEmpty}
              type="number"
              min={1}
              step={0.1}
              value={tempoDraft}
              onChange={(event) => setTempoDraft(event.target.value)}
              onBlur={() => {
                const nextBpm = Number(tempoDraft);
                if (!song || !Number.isFinite(nextBpm) || nextBpm <= 0 || nextBpm === song.bpm) {
                  setTempoDraft(String(song?.bpm ?? 120));
                  return;
                }

                void runAction(async () => {
                  const nextSnapshot = await updateSongTempo(nextBpm);
                  applyPlaybackSnapshot(nextSnapshot);
                  setStatus(`Tempo actualizado a ${nextBpm.toFixed(1)} BPM.`);
                });
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") {
                  return;
                }

                event.currentTarget.blur();
              }}
            />
            <small title={song?.tempoMetadata.referenceFilePath ?? undefined}>{tempoSourceLabel}</small>
          </label>

          <div className="lt-transport-buttons">
            <button type="button" aria-label="Anterior" disabled={isProjectEmpty}>
              <span className="material-symbols-outlined">skip_previous</span>
            </button>
            <button
              type="button"
              aria-label="Detener"
              disabled={isProjectEmpty}
              onClick={() =>
                void runAction(async () => {
                  const nextSnapshot = await stopTransport();
                  applyPlaybackSnapshot(nextSnapshot);
                  setStatus("Reproduccion detenida.");
                })
              }
            >
              <span className="material-symbols-outlined">stop</span>
            </button>
            <button
              type="button"
              aria-label="Reproducir"
              className="is-play"
              disabled={isProjectEmpty}
              onClick={() =>
                void runAction(async () => {
                  const nextSnapshot = await playTransport();
                  applyPlaybackSnapshot(nextSnapshot);
                  setStatus("Reproduccion iniciada.");
                })
              }
            >
              <span className="material-symbols-outlined">play_arrow</span>
            </button>
            <button
              type="button"
              aria-label="Pausar"
              disabled={isProjectEmpty}
              onClick={() =>
                void runAction(async () => {
                  const nextSnapshot = await pauseTransport();
                  applyPlaybackSnapshot(nextSnapshot);
                  setStatus("Reproduccion pausada.");
                })
              }
            >
              <span className="material-symbols-outlined">pause</span>
            </button>
            <button type="button" aria-label="Siguiente" disabled={isProjectEmpty}>
              <span className="material-symbols-outlined">skip_next</span>
            </button>
          </div>

          <div className="lt-transport-readout">
            <div className="lt-readout-block">
              <span>Tempo</span>
              <strong>{song ? `${song.bpm.toFixed(2)} BPM` : "120.00 BPM"}</strong>
            </div>
            <div className="lt-readout-block">
              <span>Bar</span>
              <strong ref={transportReadoutBarRef}>{musicalPositionLabel}</strong>
            </div>
            <div className="lt-readout-block is-timecode">
              <span>Timecode</span>
              <strong ref={transportReadoutValueRef}>{formatClock(readoutPositionSeconds)}</strong>
            </div>
            <span className={`transport-pill is-${playbackState}`}>
              {playbackState}
            </span>
          </div>
          </div>
        </div>
      </header>

      <div className="lt-shell-body">
        <aside className="lt-side-nav" aria-label="Navegacion principal">
          <button type="button" className="is-active" aria-label="Browser">
            <span className="material-symbols-outlined">folder_open</span>
            Browser
          </button>
          <button type="button" aria-label="Markers">
            <span className="material-symbols-outlined">sell</span>
            Markers
          </button>
          <button type="button" aria-label="Library">
            <span className="material-symbols-outlined">library_music</span>
            Library
          </button>
          <button type="button" aria-label="Routing">
            <span className="material-symbols-outlined">settings_input_component</span>
            Routing
          </button>
          <button type="button" aria-label="Settings">
            <span className="material-symbols-outlined">settings</span>
            Settings
          </button>
        </aside>

        <div className="lt-workspace">
      {shouldShowEmptyState ? (
        <div className="lt-empty-state">
          <div className="lt-empty-state-card">
            <span className="lt-empty-state-eyebrow">LibreTracks DAW</span>
            <h1>Import tracks to start</h1>
            <p>Open an existing session or import WAV stems to start building the arrangement.</p>
            <div className="lt-empty-state-actions">
              <button type="button" className="is-primary" onClick={handleOpenProjectClick}>
                Open
              </button>
              <button type="button" onClick={handleImportWavsClick}>
                Import WAVs
              </button>
            </div>
          </div>
        </div>
      ) : (
      <section className="lt-main-stage">
        <div className="lt-timeline-topline">
          <div className="lt-timeline-meta">
            <div className="lt-bottom-controls lt-timeline-controls">
              <button
                type="button"
                className={`lt-icon-button ${snapEnabled ? "is-active" : ""}`}
                aria-label={snapEnabled ? "Desactivar snap to grid" : "Activar snap to grid"}
                aria-pressed={snapEnabled}
                title={`Snap to Grid (${timelineGrid.subdivisionPerBeat}/1)`}
                onClick={() => setSnapEnabled((current) => !current)}
              >
                <span className="material-symbols-outlined">{snapEnabled ? "grid_on" : "grid_off"}</span>
              </button>
              <label className="lt-zoom-control lt-jump-mode-control">
                <span>Salto</span>
                <select
                  aria-label="Modo global de salto"
                  disabled={isProjectEmpty}
                  value={globalJumpMode}
                  onChange={(event) => setGlobalJumpMode(event.target.value as GlobalJumpMode)}
                >
                  <option value="immediate">Immediate</option>
                  <option value="after_bars">After X bars</option>
                  <option value="next_marker">At next marker</option>
                </select>
              </label>
              {globalJumpMode === "after_bars" ? (
                <label className="lt-zoom-control">
                  <span>Compases</span>
                  <input
                    aria-label="Compases para salto global"
                    type="number"
                    min={1}
                    step={1}
                    value={globalJumpBars}
                    onChange={(event) => setGlobalJumpBars(Math.max(1, Number(event.target.value) || 1))}
                  />
                </label>
              ) : null}
              {pendingMarkerJump ? (
                <span>
                  Armado: {pendingMarkerJump.targetMarkerName} | {pendingMarkerJump.trigger}
                </span>
              ) : null}
              <button
                type="button"
                className="lt-icon-button"
                aria-label="Cancelar salto"
                title="Cancelar salto"
                disabled={!pendingMarkerJump}
                onClick={() =>
                  void runAction(async () => {
                    const nextSnapshot = await cancelMarkerJump();
                    applyPlaybackSnapshot(nextSnapshot);
                    setStatus("Salto cancelado.");
                  })
                }
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="lt-timeline-stats">
              <span>{song?.tracks.length ?? 0} tracks</span>
              <span>{song?.clips.length ?? 0} clips</span>
              <span>{song?.sectionMarkers.length ?? 0} marcas</span>
            </div>
          </div>
        </div>

          <div
            className="lt-timeline-shell"
            ref={timelineShellRef}
          >
          <div
            className="lt-ruler-row"
            style={{ width: timelineRowWidth, gridTemplateColumns: `${HEADER_WIDTH}px ${laneViewportWidth}px` }}
          >
            <div className="lt-ruler-header">
              <span>Tracks</span>
            </div>
            <div
              className="lt-ruler-track"
              ref={rulerTrackRef}
              onMouseDown={(event) => {
                if (!song || event.button !== 0 || !rulerTrackRef.current) {
                  return;
                }

                event.preventDefault();
                const startSeconds = rulerPointerToSeconds(
                  event,
                  rulerTrackRef.current,
                  song.durationSeconds,
                  getCameraX(),
                  pixelsPerSecond,
                );
                const snappedSeconds = snapEnabled
                  ? snapToTimelineGrid(startSeconds, song.bpm, song.timeSignature, zoomLevel, pixelsPerSecond)
                  : startSeconds;
                setSelectedSectionId(null);
                setSelectedClipId(null);
                setSelectedTrackId(null);
                setContextMenu(null);
                void runAction(async () => {
                  await performSeek(snappedSeconds);
                });
              }}
              onContextMenu={(event) => {
                if (!song || !rulerTrackRef.current) {
                  return;
                }

                const positionSeconds = snappedRulerSeconds(event, song.durationSeconds);
                setSelectedSectionId(null);
                setSelectedClipId(null);
                setSelectedTrackId(null);
                openMenu(event, `Timeline ${formatClock(positionSeconds)}`, rulerContextMenu(positionSeconds));
              }}
            >
              <div className="lt-ruler-content" style={{ width: laneViewportWidth }}>
                <TimelineRulerCanvas
                  width={laneViewportWidth}
                  height={RULER_HEIGHT}
                  cameraXRef={cameraXRef}
                  pixelsPerSecond={pixelsPerSecond}
                  timelineGrid={timelineGrid}
                  markers={song?.sectionMarkers ?? []}
                  selectedMarkerId={selectedSectionId}
                  pendingMarkerJump={pendingMarkerJump}
                  playheadSecondsRef={displayPositionSecondsRef}
                  playheadDragRef={playheadDragRef}
                >
                  {timelineHeaderMarkers.map((marker) => {
                    const markerLeft = marker.seconds * pixelsPerSecond;

                    return (
                      <div
                        key={`marker-${marker.seconds.toFixed(4)}`}
                        className={`lt-ruler-mark ${marker.isBarStart ? "is-bar" : "is-beat"}`}
                        style={{ left: markerLeft }}
                      >
                        <strong>{formatTimelineHeaderMusicalPosition(marker.barNumber, marker.beatInBar)}</strong>
                        <small>{formatTimelineHeaderTime(marker.seconds)}</small>
                      </div>
                    );
                  })}

                  {song?.sectionMarkers.map((section) => {
                    const sectionLeft = section.startSeconds * pixelsPerSecond;

                    return (
                      <button
                        key={section.id}
                        type="button"
                        className={`lt-marker-hotspot ${selectedSectionId === section.id ? "is-selected" : ""}`}
                        aria-label={section.name}
                        title={section.name}
                        style={{ left: sectionLeft }}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                          void runAction(async () => {
                            await handleMarkerPrimaryAction(section);
                          });
                        }}
                        onContextMenu={(event) => {
                          event.stopPropagation();
                          setSelectedSectionId(section.id);
                          openMenu(event, section.name, sectionContextMenu(section));
                        }}
                      >
                        <span className="lt-sr-only">{section.name}</span>
                      </button>
                    );
                  })}
                </TimelineRulerCanvas>

                <div
                  className="lt-playhead is-handle"
                  ref={playheadHandleRef}
                  onMouseDown={(event) => {
                    if (!song || event.button !== 0) {
                      return;
                    }

                    event.preventDefault();
                    event.stopPropagation();
                    setContextMenu(null);
                    playheadDragRef.current = {
                      pointerId: 1,
                      currentSeconds: displayPositionSecondsRef.current,
                    };
                    playheadHandleRef.current?.classList.add("is-dragging");
                  }}
                />
              </div>
            </div>
          </div>

          <div className="lt-track-list" ref={laneAreaRef} style={{ width: timelineRowWidth }}>
            {song ? (
              <TimelineTrackCanvas
                width={laneViewportWidth}
                height={visibleTracks.length * trackHeight}
                trackHeight={trackHeight}
                song={song}
                visibleTracks={visibleTracks}
                clipsByTrack={clipsByTrack}
                waveformCache={waveformCache}
                cameraXRef={cameraXRef}
                pixelsPerSecond={pixelsPerSecond}
                timelineGrid={timelineGrid}
                selectedClipId={selectedClipId}
                clipPreviewSecondsRef={clipPreviewSecondsRef}
                playheadSecondsRef={displayPositionSecondsRef}
                playheadDragRef={playheadDragRef}
              />
            ) : null}

            {song?.tracks && visibleTracks.map((track) => {
                const trackClips = clipsByTrack[track.id] ?? [];
                const isTrackSelected = selectedTrackId === track.id;
                const childCount = trackChildrenCount(song, track.id);
                const trackDensityClass =
                  trackHeight <= 76 ? "is-compact" : trackHeight <= 88 ? "is-condensed" : "";

                return (
                <div
                  key={track.id}
                  className="lt-track-row"
                  data-track-id={track.id}
                  style={{
                    width: timelineRowWidth,
                    gridTemplateColumns: `${HEADER_WIDTH}px ${laneViewportWidth}px`,
                  }}
                >
                  <TrackHeaderItem
                    trackId={track.id}
                    trackName={track.name}
                    trackKind={track.kind}
                    trackDepth={track.depth}
                    childCount={childCount}
                    trackHeight={trackHeight}
                    panValue={track.pan}
                    trackMuted={track.muted}
                    trackSolo={track.solo}
                    volumeValue={track.volume}
                    isCollapsed={collapsedFolders.has(track.id)}
                    isSelected={isTrackSelected}
                    isDropTarget={false}
                    dropMode={null}
                    isDragging={false}
                    densityClass={trackDensityClass}
                    onSelectTrack={handleTrackHeaderSelect}
                    onOpenContextMenu={handleTrackHeaderContextMenu}
                    onStartTrackDrag={handleTrackHeaderDragStart}
                    onToggleFolder={handleTrackHeaderFolderToggle}
                    onToggleMute={handleTrackHeaderMuteToggle}
                    onToggleSolo={handleTrackHeaderSoloToggle}
                    onVolumeChange={handleTrackHeaderVolumeChange}
                    onCommitVolume={handleTrackHeaderVolumeCommit}
                    onPanChange={handleTrackHeaderPanChange}
                    onCommitPan={handleTrackHeaderPanCommit}
                  />

                  <div
                    className={`lt-track-lane ${track.kind === "folder" ? "is-folder" : ""}`}
                    style={{ height: trackHeight }}
                    aria-label={`Lane ${track.name}`}
                    onMouseDown={(event) => handleTrackLaneMouseDown(event, track, trackClips)}
                    onContextMenu={(event) => handleTrackLaneContextMenu(event, track, trackClips)}
                  />
                </div>
              );
            })}
          </div>
          <div className="lt-horizontal-scrollbar">
            <div className="lt-horizontal-scrollbar-spacer" aria-hidden="true" />
            <div
              ref={horizontalScrollbarRef}
              className="lt-horizontal-scrollbar-rail"
              aria-label="Desplazamiento horizontal del timeline"
              onScroll={(event) => {
                cameraXRef.current = event.currentTarget.scrollLeft;
                updateCameraX(event.currentTarget.scrollLeft);
              }}
            >
              <div
                className="lt-horizontal-scrollbar-content"
                style={{ width: laneViewportWidth + maxTimelineCameraX }}
              />
            </div>
            </div>
          </div>

  </section>
  )}

        {contextMenu ? (
        <div
          className="lt-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <strong>{contextMenu.title}</strong>
          {contextMenu.actions.map((action) => (
            <button
              key={action.label}
              type="button"
              disabled={action.disabled}
              onClick={() => {
                setContextMenu(null);
                void action.onSelect();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}

        <ImportAudioModal
          isOpen={isImportModalOpen}
          isImporting={isImportingFromModal}
          onClose={() => {
            if (!isImportingFromModal) {
              setIsImportModalOpen(false);
            }
          }}
          onImport={importFromModal}
        />

        <div className="lt-status-overlay" aria-live="polite">
          <span>{status}</span>
        </div>
        </div>
      </div>
      </div>
    </Profiler>
  );
}
