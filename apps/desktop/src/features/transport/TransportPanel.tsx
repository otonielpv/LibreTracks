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
  listenToTransportLifecycle,
  moveClip,
  moveTrack,
  openProject,
  pauseTransport,
  pickAndImportSong,
  playTransport,
  saveProject,
  saveProjectAs,
  scheduleMarkerJump,
  seekTransport,
  splitClip,
  stopTransport,
  updateSectionMarker,
  updateSongTempo,
  updateTrack,
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
} | null;

type TimelinePanState = {
  pointerId: number;
  startClientX: number;
  originCameraX: number;
} | null;

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
  const [snapshot, setSnapshot] = useState<TransportSnapshot | null>(null);
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
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [clipDrag, setClipDrag] = useState<ClipDragState>(null);
  const [playheadDrag, setPlayheadDrag] = useState<PlayheadDragState>(null);
  const [displayPositionSeconds, setDisplayPositionSeconds] = useState(0);
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(DEFAULT_TIMELINE_VIEWPORT_WIDTH);
  const [trackDrag, setTrackDrag] = useState<TrackDragState>(null);
  const [timelinePan, setTimelinePan] = useState<TimelinePanState>(null);
  const [volumeDrafts, setVolumeDrafts] = useState<Record<string, number>>({});
  const [draggingTrackId, setDraggingTrackId] = useState<string | null>(null);
  const [trackDropState, setTrackDropState] = useState<TrackDropState>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const laneAreaRef = useRef<HTMLDivElement | null>(null);
  const rulerTrackRef = useRef<HTMLDivElement | null>(null);
  const timelineShellRef = useRef<HTMLDivElement | null>(null);
  const horizontalScrollbarRef = useRef<HTMLDivElement | null>(null);
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
  const songRef = useRef<SongView | null>(null);
  const tracksByIdRef = useRef<Record<string, TrackSummary>>({});
  const volumeDraftsRef = useRef<Record<string, number>>({});
  const playheadDragRef = useRef<PlayheadDragState>(null);

  songRef.current = song;
  tracksByIdRef.current = tracksById;
  volumeDraftsRef.current = volumeDrafts;
  playheadDragRef.current = playheadDrag;

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

    setDisplayPositionSeconds(nextSnapshot.positionSeconds);
    syncLivePosition(isRunning ? anchorPositionSeconds : nextSnapshot.positionSeconds);
  }

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;

    async function loadSnapshot() {
      const nextSnapshot = await getTransportSnapshot();
      if (!active) {
        return;
      }

      applyTransportVisualAnchor(nextSnapshot);
      setSnapshot(nextSnapshot);
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
      setSnapshot(event.snapshot);
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
      if (!snapshot || snapshot.projectRevision === 0) {
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
  }, [snapshot?.projectRevision]);

  useEffect(() => {
    if (!song) {
      setWaveformCache({});
      return;
    }

    setWaveformCache({});
  }, [song?.projectRevision]);

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
    if (!song) {
      setClipsByTrack({});
      setTracksById({});
      return;
    }

    const nextTracksById = Object.fromEntries(song.tracks.map((track) => [track.id, track]));
    const nextClipsByTrack = Object.fromEntries(song.tracks.map((track) => [track.id, [] as ClipSummary[]]));

    for (const clip of song.clips) {
      nextClipsByTrack[clip.trackId] ??= [];
      nextClipsByTrack[clip.trackId].push(clip);
    }

    setTracksById(nextTracksById);
    setClipsByTrack(nextClipsByTrack);
  }, [song]);

  useEffect(() => {
    songDurationSecondsRef.current = song?.durationSeconds ?? 0;
  }, [song?.durationSeconds]);

  useEffect(() => {
    const songDurationSeconds = song?.durationSeconds ?? 0;
    songDurationSecondsRef.current = songDurationSeconds;

    if (!snapshot) {
      return;
    }

    const snapshotKey = transportSnapshotKey(snapshot);
    const anchorMeta =
      transportAnchorMetaRef.current?.snapshotKey === snapshotKey
        ? transportAnchorMetaRef.current
        : null;

    if (anchorMeta) {
      transportAnchorMetaRef.current = null;
    }

    applyTransportVisualAnchor(snapshot, anchorMeta);
  }, [
    snapshot,
    snapshot?.playbackState,
    snapshot?.positionSeconds,
    song?.durationSeconds,
    snapshot?.transportClock?.anchorPositionSeconds,
    snapshot?.transportClock?.running,
  ]);

  useEffect(() => {
    if (!song) {
      setVolumeDrafts({});
      return;
    }

    setVolumeDrafts((current) => {
      const validTrackIds = new Set(song.tracks.map((track) => track.id));
      const next = Object.fromEntries(
        Object.entries(current).filter(([trackId]) => validTrackIds.has(trackId)),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [song]);

  useEffect(() => {
    return () => {
      if (renderMetricTimeoutRef.current !== null) {
        window.clearTimeout(renderMetricTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (snapshot?.playbackState !== "playing") {
      return;
    }

    let animationFrameId = 0;

    const tick = () => {
      if (playheadDrag) {
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
        const stoppedSnapshot =
          snapshot?.playbackState === "playing"
            ? {
                ...snapshot,
                playbackState: "stopped" as const,
                positionSeconds: 0,
                transportClock: snapshot.transportClock
                  ? {
                      ...snapshot.transportClock,
                      anchorPositionSeconds: 0,
                      running: false,
                    }
                  : snapshot.transportClock,
              }
            : null;

        playbackVisualAnchorRef.current = {
          anchorPositionSeconds: 0,
          anchorReceivedAtMs: performance.now(),
          durationSeconds: anchor.durationSeconds,
          running: false,
        };
        displayPositionSecondsRef.current = 0;
        setDisplayPositionSeconds(0);
        if (stoppedSnapshot) {
          setSnapshot(stoppedSnapshot);
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
  }, [playheadDrag, snapshot]);

  useEffect(() => {
    if (!isTauriApp || snapshot?.playbackState !== "playing") {
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

        setSnapshot(nextSnapshot);
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
  }, [snapshot?.playbackState]);

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
          if (snapshot?.playbackState === "playing") {
            const nextSnapshot = await pauseTransport();
            setSnapshot(nextSnapshot);
            setStatus("Reproduccion pausada.");
            return;
          }

          const nextSnapshot = await playTransport();
          setSnapshot(nextSnapshot);
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

      const keyDigit = keyboardDigit(event.code);
      if (keyDigit !== null) {
        event.preventDefault();

        const marker = song ? resolveMarkerShortcut(song.sectionMarkers, keyDigit) : null;
        if (!marker) {
          setStatus(`No hay marca disponible para el digito ${keyDigit}.`);
          return;
        }

        void runAction(async () => {
          const pendingJump = snapshot?.pendingMarkerJump;
          if (pendingJump && pendingJump.targetMarkerId === marker.id) {
            const nextSnapshot = await cancelMarkerJump();
            setSnapshot(nextSnapshot);
            setStatus(`Salto cancelado para digito ${keyDigit}.`);
            return;
          }

          await scheduleMarkerJumpWithGlobalMode(marker.id, marker.name);
        });

        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();

        if (snapshot?.pendingMarkerJump) {
          void runAction(async () => {
            const nextSnapshot = await cancelMarkerJump();
            setSnapshot(nextSnapshot);
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
          setSnapshot(nextSnapshot);
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
    globalJumpBars,
    globalJumpMode,
    selectedClipId,
    snapshot?.pendingMarkerJump,
    snapshot?.playbackState,
    song,
  ]);

  useEffect(() => {
    if (!clipDrag || !song || !laneAreaRef.current) {
      return;
    }

    const effectSong = song;
    const effectPixelsPerSecond = zoomLevel * BASE_PIXELS_PER_SECOND;
    let activeDrag = clipDrag;

    const onMouseMove = (event: MouseEvent) => {
      const exceededThreshold = Math.abs(event.clientX - activeDrag.startClientX) > DRAG_THRESHOLD_PX;
      const deltaSeconds = (event.clientX - activeDrag.startClientX) / effectPixelsPerSecond;
      const nextSeconds = snapEnabled
        ? snapToTimelineGrid(
            activeDrag.originSeconds + deltaSeconds,
            effectSong.bpm,
            effectSong.timeSignature,
            zoomLevel,
            effectPixelsPerSecond,
          )
        : activeDrag.originSeconds + deltaSeconds;

      activeDrag = {
        ...activeDrag,
        hasMoved: activeDrag.hasMoved || exceededThreshold,
        previewSeconds: clamp(nextSeconds, 0, effectSong.durationSeconds),
      };
      setClipDrag(activeDrag);
    };

    const onMouseUp = async (event: MouseEvent) => {
      if (event.button !== 0) {
        return;
      }

      setClipDrag(null);
      if (!activeDrag) {
        return;
      }

      const movedEnough =
        activeDrag.hasMoved ||
        Math.abs(event.clientX - activeDrag.startClientX) > DRAG_THRESHOLD_PX;
      if (!movedEnough) {
        return;
      }

      await runAction(async () => {
        const nextSnapshot = await moveClip(activeDrag.clipId, activeDrag.previewSeconds);
        setSnapshot(nextSnapshot);
        const clip = findClip(song, activeDrag.clipId);
        setStatus(`Clip movido: ${clip?.trackName ?? activeDrag.clipId}`);
      });
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [clipDrag, snapEnabled, song, zoomLevel]);

  useEffect(() => {
    if (!playheadDrag || !song || !rulerTrackRef.current) {
      return;
    }

    const effectSong = song;
    const effectPixelsPerSecond = zoomLevel * BASE_PIXELS_PER_SECOND;

    const onMouseMove = (event: MouseEvent) => {
      const effectCameraX = getCameraX({
        durationSeconds: effectSong.durationSeconds,
        pixelsPerSecond: effectPixelsPerSecond,
      });
      const rawSeconds = rulerPointerToSeconds(
        event,
        rulerTrackRef.current as HTMLElement,
        effectSong.durationSeconds,
        effectCameraX,
        effectPixelsPerSecond,
      );
      const nextSeconds =
        snapEnabled
          ? snapToTimelineGrid(
              rawSeconds,
              effectSong.bpm,
              effectSong.timeSignature,
              zoomLevel,
              effectPixelsPerSecond,
            )
          : rawSeconds;
      setPlayheadDrag((current) =>
        current
          ? {
              ...current,
              currentSeconds: nextSeconds,
            }
          : current,
      );
    };

    const onMouseUp = async (event: MouseEvent) => {
      if (event.button !== 0) {
        return;
      }

      const activeDrag = playheadDrag;
      setPlayheadDrag(null);
      if (!activeDrag) {
        return;
      }

      await runAction(async () => {
        await performSeek(activeDrag.currentSeconds);
      });
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [playheadDrag, runAction, snapEnabled, song, zoomLevel]);

  useEffect(() => {
    if (!trackDrag || !song) {
      return;
    }

    const effectSong = song;

    const onMouseMove = (event: MouseEvent) => {
      const exceededThreshold =
        Math.abs(event.clientX - trackDrag.startClientX) > DRAG_THRESHOLD_PX ||
        Math.abs(event.clientY - trackDrag.startClientY) > DRAG_THRESHOLD_PX;
      const isDraggingNow = trackDrag.isDragging || exceededThreshold;

      setTrackDrag((current) =>
        current
          ? {
              ...current,
              currentClientY: event.clientY,
              isDragging: current.isDragging || exceededThreshold,
            }
          : current,
      );

      if (!isDraggingNow) {
        return;
      }

      setDraggingTrackId(trackDrag.trackId);
      setTrackDropState(
        resolveTrackDropState(effectSong, trackDrag.trackId, event.clientX, event.clientY),
      );
    };

    const onMouseUp = (event: MouseEvent) => {
      if (event.button !== 0) {
        return;
      }

      const movedEnough =
        Math.abs(event.clientX - trackDrag.startClientX) > DRAG_THRESHOLD_PX ||
        Math.abs(event.clientY - trackDrag.startClientY) > DRAG_THRESHOLD_PX;
      const shouldTreatAsDrag = trackDrag.isDragging || movedEnough;
      const dropState = shouldTreatAsDrag
        ? resolveTrackDropState(effectSong, trackDrag.trackId, event.clientX, event.clientY)
        : null;

      setTrackDrag(null);
      setDraggingTrackId(null);
      setTrackDropState(null);
      suppressTrackClickRef.current = shouldTreatAsDrag;

      if (!dropState) {
        return;
      }

      void handleTrackDrop(trackDrag.trackId, dropState);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [song, trackDrag]);

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
    if (snapshot) {
      applyTransportVisualAnchor(snapshot);
      return;
    }

    playbackVisualAnchorRef.current = {
      anchorPositionSeconds: 0,
      anchorReceivedAtMs: performance.now(),
      durationSeconds: songDurationSecondsRef.current,
      running: false,
    };
    setDisplayPositionSeconds(0);
    syncLivePosition(0);
  }

  async function performSeek(positionSeconds: number) {
    previewSeek(positionSeconds);

    try {
      const nextSnapshot = await seekTransport(positionSeconds);
      setSnapshot(nextSnapshot);
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
  const positionSeconds = playheadDrag?.currentSeconds ?? displayPositionSeconds;
  const musicalPositionLabel =
    snapshot?.musicalPosition?.display ??
    (song ? formatMusicalPosition(positionSeconds, song.bpm, song.timeSignature) : "1.1.00");
  const tempoSourceLabel =
    song?.tempoMetadata.source === "auto_import"
      ? `Detectado en importacion${song.tempoMetadata.confidence != null ? ` (${Math.round(song.tempoMetadata.confidence * 100)}%)` : ""}`
      : "Manual";
  const isProjectEmpty = !song || song.tracks.length === 0;
  const isProjectPending = Boolean(snapshot && snapshot.projectRevision > 0 && !song);
  const shouldShowEmptyState = !isProjectPending && isProjectEmpty;
  const shouldShowSessionActions = !shouldShowEmptyState;
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
  const previewClipSeconds = clipDrag
    ? { [clipDrag.clipId]: clipDrag.previewSeconds }
    : {};
  const playheadColor = playheadDrag ? "#ffe2ab" : "#57f1db";

  async function scheduleMarkerJumpWithGlobalMode(markerId: string, markerName: string) {
    const trigger =
      globalJumpMode === "after_bars" ? "after_bars" : globalJumpMode;
    const bars = Math.max(1, Math.floor(globalJumpBars));
    const nextSnapshot = await scheduleMarkerJump(
      markerId,
      trigger,
      trigger === "after_bars" ? bars : undefined,
    );
    setSnapshot(nextSnapshot);

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

    if (snapshot?.pendingMarkerJump?.targetMarkerId === section.id) {
      const nextSnapshot = await cancelMarkerJump();
      setSnapshot(nextSnapshot);
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
    syncLivePosition(playheadDrag?.currentSeconds ?? displayPositionSecondsRef.current);
  }, [
    displayPositionSeconds,
    pixelsPerSecond,
    playheadDrag?.currentSeconds,
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
            setSnapshot(nextSnapshot);
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
      setSnapshot(nextSnapshot);
      setStatus(
        dropState.mode === "inside-folder"
          ? `Track movido dentro de ${targetTrack.name}.`
          : dropState.mode === "before"
            ? `Track reordenado encima de ${targetTrack.name}.`
            : `Track reordenado debajo de ${targetTrack.name}.`,
      );
    });
  }

  async function commitTrackVolume(trackId: string) {
    const track = findTrack(songRef.current, trackId);
    const draftVolume = volumeDraftsRef.current[trackId];
    if (!track || draftVolume === undefined) {
      return;
    }

    const nextVolume = clamp(draftVolume, 0, 1);
    if (Math.abs(nextVolume - track.volume) < 0.0001) {
      setVolumeDrafts((current) => {
        const next = { ...current };
        delete next[trackId];
        volumeDraftsRef.current = next;
        return next;
      });
      return;
    }

    await runAction(async () => {
      const nextSnapshot = await updateTrack({
        trackId,
        volume: nextVolume,
      });
      setSnapshot(nextSnapshot);
    });

    setVolumeDrafts((current) => {
      const next = { ...current };
      delete next[trackId];
      volumeDraftsRef.current = next;
      return next;
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
      setSnapshot(nextSnapshot);
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
            setSnapshot(nextSnapshot);
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
            setSnapshot(nextSnapshot);
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
            setSnapshot(nextSnapshot);
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
            setSnapshot(nextSnapshot);
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
    (event: ReactMouseEvent<HTMLButtonElement>, trackId: string) => {
      if (event.button !== 0) {
        return;
      }

      event.stopPropagation();
      setContextMenu(null);
      setTrackDrag({
        trackId,
        pointerId: 1,
        startClientX: event.clientX,
        startClientY: event.clientY,
        currentClientY: event.clientY,
        isDragging: false,
      });
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

    void runAction(async () => {
      const nextSnapshot = await updateTrack({
        trackId,
        muted: !track.muted,
      });
      setSnapshot(nextSnapshot);
    });
  }, [runAction]);

  const handleTrackHeaderSoloToggle = useCallback((trackId: string) => {
    const track = findTrack(songRef.current, trackId);
    if (!track) {
      return;
    }

    void runAction(async () => {
      const nextSnapshot = await updateTrack({
        trackId,
        solo: !track.solo,
      });
      setSnapshot(nextSnapshot);
    });
  }, [runAction]);

  const handleTrackHeaderVolumeChange = useCallback((trackId: string, nextVolume: number) => {
    setVolumeDrafts((current) => {
      const next = {
        ...current,
        [trackId]: nextVolume,
      };
      volumeDraftsRef.current = next;
      return next;
    });
  }, []);

  const handleTrackHeaderVolumeCommit = useCallback((trackId: string) => {
    void commitTrackVolume(trackId);
  }, []);

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
            setSnapshot(nextSnapshot);
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
            setSnapshot(nextSnapshot);
            setStatus(`Clip duplicado: ${clip.trackName}`);
          });
        },
      },
      {
        label: "Borrar",
        onSelect: async () => {
          await runAction(async () => {
            const nextSnapshot = await deleteClip(clip.id);
            setSnapshot(nextSnapshot);
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
      setClipDrag({
        clipId: hitClip.id,
        pointerId: 1,
        originSeconds: hitClip.timelineStartSeconds,
        previewSeconds: hitClip.timelineStartSeconds,
        startClientX: event.clientX,
        hasMoved: false,
      });
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
    setTimelinePan(activePan);

    const onMouseMove = (windowEvent: MouseEvent) => {
      const deltaX = activePan.startClientX - windowEvent.clientX;
      updateCameraX(activePan.originCameraX + deltaX);
    };

    const onMouseUp = (windowEvent: MouseEvent) => {
      if (windowEvent.button !== 0) {
        return;
      }

      setTimelinePan(null);
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
            setSnapshot(nextSnapshot);
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
            setSnapshot(nextSnapshot);
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
            setSnapshot(nextSnapshot);
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
          setSnapshot(nextSnapshot);
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

        setSnapshot(nextSnapshot);
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
    void runAction(async () => setSnapshot((await openProject()) ?? snapshot), { busy: true });
  }

  function handleSaveProjectClick() {
    void runAction(
      async () => {
        const nextSnapshot = await saveProject();
        setSnapshot(nextSnapshot);
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

        setSnapshot(nextSnapshot);
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
        <div className="lt-brand">
          <span className="lt-brand-title">LIBRETRACKS</span>
        </div>

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
                  setSnapshot(nextSnapshot);
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
                  setSnapshot(nextSnapshot);
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
                  setSnapshot(nextSnapshot);
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
                  setSnapshot(nextSnapshot);
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
              <strong ref={transportReadoutValueRef}>{formatClock(positionSeconds)}</strong>
            </div>
            <span className={`transport-pill is-${snapshot?.playbackState ?? "empty"}`}>
              {snapshot?.playbackState ?? "empty"}
            </span>
          </div>
        </div>

        {shouldShowSessionActions ? (
        <div className="lt-session-actions">
          <button type="button" onClick={handleOpenProjectClick}>
            <span className="material-symbols-outlined" aria-hidden="true">folder_open</span>
            <span className="lt-button-label">Abrir</span>
          </button>
          <button
            type="button"
            onClick={handleSaveProjectClick}
          >
            <span className="material-symbols-outlined" aria-hidden="true">save</span>
            <span className="lt-button-label">Guardar</span>
          </button>
          <button
            type="button"
            onClick={handleSaveProjectAsClick}
          >
            <span className="material-symbols-outlined" aria-hidden="true">save_as</span>
            <span className="lt-button-label">Guardar como</span>
          </button>
          <button type="button" onClick={handleImportWavsClick}>
            <span className="material-symbols-outlined" aria-hidden="true">audio_file</span>
            <span className="lt-button-label">Importar WAVs</span>
          </button>
        </div>
        ) : null}
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
              {snapshot?.pendingMarkerJump ? (
                <span>
                  Armado: {snapshot.pendingMarkerJump.targetMarkerName} | {snapshot.pendingMarkerJump.trigger}
                </span>
              ) : null}
              <button
                type="button"
                className="lt-icon-button"
                aria-label="Cancelar salto"
                title="Cancelar salto"
                disabled={!snapshot?.pendingMarkerJump}
                onClick={() =>
                  void runAction(async () => {
                    const nextSnapshot = await cancelMarkerJump();
                    setSnapshot(nextSnapshot);
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
                  pendingMarkerJump={snapshot?.pendingMarkerJump ?? null}
                  playheadSecondsRef={displayPositionSecondsRef}
                  previewPlayheadSeconds={playheadDrag?.currentSeconds ?? null}
                  playheadColor={playheadColor}
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
                  className={`lt-playhead is-handle ${playheadDrag ? "is-dragging" : ""}`}
                  onMouseDown={(event) => {
                    if (!song || event.button !== 0) {
                      return;
                    }

                    event.preventDefault();
                    event.stopPropagation();
                    setContextMenu(null);
                    setPlayheadDrag({
                      pointerId: 1,
                      currentSeconds: displayPositionSecondsRef.current,
                    });
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
                previewClipSeconds={previewClipSeconds}
                playheadSecondsRef={displayPositionSecondsRef}
                previewPlayheadSeconds={playheadDrag?.currentSeconds ?? null}
                playheadColor={playheadColor}
              />
            ) : null}

            {song?.tracks && visibleTracks.map((track) => {
                const trackClips = clipsByTrack[track.id] ?? [];
                const isTrackSelected = selectedTrackId === track.id;
                const childCount = trackChildrenCount(song, track.id);
                const isDropTarget = trackDropState?.targetTrackId === track.id;
                const dropMode = isDropTarget ? trackDropState?.mode : null;
                const trackDensityClass =
                  trackHeight <= 76 ? "is-compact" : trackHeight <= 88 ? "is-condensed" : "";

                return (
                <div
                  key={track.id}
                  className={`lt-track-row ${isDropTarget ? `is-drop-target is-drop-${dropMode}` : ""}`}
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
                    clipCount={trackClips.length}
                    trackHeight={trackHeight}
                    trackPan={track.pan}
                    trackMuted={track.muted}
                    trackSolo={track.solo}
                    volumeValue={volumeDrafts[track.id] ?? track.volume}
                    isCollapsed={collapsedFolders.has(track.id)}
                    isSelected={isTrackSelected}
                    isDropTarget={isDropTarget}
                    dropMode={dropMode}
                    isDragging={draggingTrackId === track.id}
                    densityClass={trackDensityClass}
                    onSelectTrack={handleTrackHeaderSelect}
                    onOpenContextMenu={handleTrackHeaderContextMenu}
                    onStartTrackDrag={handleTrackHeaderDragStart}
                    onToggleFolder={handleTrackHeaderFolderToggle}
                    onToggleMute={handleTrackHeaderMuteToggle}
                    onToggleSolo={handleTrackHeaderSoloToggle}
                    onVolumeChange={handleTrackHeaderVolumeChange}
                    onCommitVolume={handleTrackHeaderVolumeCommit}
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
