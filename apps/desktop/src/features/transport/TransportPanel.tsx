import {
  Profiler,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  assignSectionMarkerDigit,
  cancelSectionJump,
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
  scheduleSectionJump,
  seekTransport,
  splitClip,
  stopTransport,
  updateSectionMarker,
  updateSongTempo,
  updateTrack,
  type ClipSummary,
  type SectionSummary,
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

const HEADER_WIDTH = 260;
const DEFAULT_TIMELINE_VIEWPORT_WIDTH = 1100;
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

type RulerDragState = {
  pointerId: number;
  startSeconds: number;
  currentSeconds: number;
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

type TimeSelection = {
  startSeconds: number;
  endSeconds: number;
} | null;

type PendingRulerPress = {
  startClientX: number;
  startSeconds: number;
} | null;

type GlobalJumpMode = "immediate" | "after_bars" | "section_end";

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

function normalizeSelection(selection: TimeSelection) {
  if (!selection) {
    return null;
  }

  return {
    startSeconds: Math.min(selection.startSeconds, selection.endSeconds),
    endSeconds: Math.max(selection.startSeconds, selection.endSeconds),
  };
}

function keyboardDigit(eventCode: string) {
  if (eventCode.startsWith("Digit")) {
    const value = Number(eventCode.slice("Digit".length));
    return Number.isInteger(value) && value >= 0 && value <= 9 ? value : null;
  }

  if (eventCode.startsWith("Numpad")) {
    const value = Number(eventCode.slice("Numpad".length));
    return Number.isInteger(value) && value >= 0 && value <= 9 ? value : null;
  }

  return null;
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

  return song.derivedSections.find((section) => section.id === sectionId) ?? null;
}

function findSectionMarker(song: SongView | null, markerId: string | null) {
  if (!song || !markerId) {
    return null;
  }

  return song.sectionMarkers.find((marker) => marker.id === markerId) ?? null;
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
          ".lt-section-tag, .lt-track-header, .lt-inline-menu, .lt-context-menu, button, input, select, textarea, label",
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
  const [rulerDrag, setRulerDrag] = useState<RulerDragState>(null);
  const [playheadDrag, setPlayheadDrag] = useState<PlayheadDragState>(null);
  const [timeSelection, setTimeSelection] = useState<TimeSelection>(null);
  const [displayPositionSeconds, setDisplayPositionSeconds] = useState(0);
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(DEFAULT_TIMELINE_VIEWPORT_WIDTH);
  const [cameraX, setCameraX] = useState(0);
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
  const pendingRulerPressRef = useRef<PendingRulerPress>(null);
  const renderMetricTimeoutRef = useRef<number | null>(null);
  const pendingRenderMetricRef = useRef(0);
  const transportReadoutValueRef = useRef<HTMLElement | null>(null);
  const songDurationSecondsRef = useRef(0);
  const transportAnchorMetaRef = useRef<TransportAnchorMeta | null>(null);

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

    if (!isRunning) {
      displayPositionSecondsRef.current = nextSnapshot.positionSeconds;
      setDisplayPositionSeconds(nextSnapshot.positionSeconds);
    }
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
  }, []);

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
        void runAction(
          async () => {
            const nextSnapshot = await saveProject();
            setSnapshot(nextSnapshot);
            setStatus("Proyecto guardado.");
          },
          { busy: true },
        );
        return;
      }

      const keyDigit = keyboardDigit(event.code);
      if (keyDigit !== null) {
        event.preventDefault();

        const marker = song?.sectionMarkers.find((candidate) => candidate.digit === keyDigit) ?? null;
        if (!marker) {
          setStatus(`No hay marca asignada al digito ${keyDigit}.`);
          return;
        }

        void runAction(async () => {
          const pendingJump = snapshot?.pendingSectionJump;
          if (
            pendingJump &&
            pendingJump.targetMarkerId === marker.id &&
            pendingJump.targetDigit === keyDigit
          ) {
            const nextSnapshot = await cancelSectionJump();
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

        if (snapshot?.pendingSectionJump) {
          void runAction(async () => {
            const nextSnapshot = await cancelSectionJump();
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
    snapshot?.pendingSectionJump,
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
    if (!song || !rulerTrackRef.current) {
      return;
    }

    const effectPixelsPerSecond = zoomLevel * BASE_PIXELS_PER_SECOND;
    const effectLaneViewportWidth = Math.max(320, timelineViewportWidth - HEADER_WIDTH);
    const effectCameraX = clampCameraX(
      cameraX,
      song.durationSeconds,
      effectPixelsPerSecond,
      effectLaneViewportWidth,
    );

    const onMouseMove = (event: MouseEvent) => {
      const rawSeconds = rulerPointerToSeconds(
        event,
        rulerTrackRef.current as HTMLElement,
        song.durationSeconds,
        effectCameraX,
        effectPixelsPerSecond,
      );
      const nextSeconds =
        snapEnabled
          ? snapToTimelineGrid(rawSeconds, song.bpm, song.timeSignature, zoomLevel, effectPixelsPerSecond)
          : rawSeconds;
      const pendingPress = pendingRulerPressRef.current;
      if (pendingPress && !rulerDrag) {
        const movedEnough = Math.abs(event.clientX - pendingPress.startClientX) > DRAG_THRESHOLD_PX;
        if (!movedEnough) {
          return;
        }

        setRulerDrag({
          pointerId: 1,
          startSeconds: pendingPress.startSeconds,
          currentSeconds: nextSeconds,
        });
        return;
      }

      if (!rulerDrag && !pendingPress) {
        return;
      }
      setRulerDrag((current) => (current ? { ...current, currentSeconds: nextSeconds } : current));
    };

    const onMouseUp = async (event: MouseEvent) => {
      if (event.button !== 0) {
        return;
      }

      const pendingPress = pendingRulerPressRef.current;
      pendingRulerPressRef.current = null;
      const activeDrag = rulerDrag;
      setRulerDrag(null);
      const rawPointerSeconds = rulerPointerToSeconds(
        event,
        rulerTrackRef.current as HTMLElement,
        song.durationSeconds,
        effectCameraX,
        effectPixelsPerSecond,
      );
      const pointerSeconds =
        snapEnabled
          ? snapToTimelineGrid(
              rawPointerSeconds,
              song.bpm,
              song.timeSignature,
              zoomLevel,
              effectPixelsPerSecond,
            )
          : rawPointerSeconds;

      if (!activeDrag) {
        if (!pendingPress) {
          return;
        }

        const movedEnough = Math.abs(event.clientX - pendingPress.startClientX) > DRAG_THRESHOLD_PX;
        if (movedEnough) {
          const normalized = normalizeSelection({
            startSeconds: pendingPress.startSeconds,
            endSeconds: pointerSeconds,
          });

          if (normalized && normalized.endSeconds - normalized.startSeconds >= 0.15) {
            setTimeSelection(normalized);
            setStatus(
              `Seleccion temporal: ${formatClock(normalized.startSeconds)} -> ${formatClock(normalized.endSeconds)}`,
            );
            return;
          }
        }

        previewSeek(pointerSeconds);

        await runAction(async () => {
          const nextSnapshot = await seekTransport(pointerSeconds);
          setSnapshot(nextSnapshot);
          setStatus(`Cursor movido a ${formatClock(nextSnapshot.positionSeconds)}`);
        });
        setTimeSelection(null);
        return;
      }

      const normalized = normalizeSelection({
        startSeconds: activeDrag.startSeconds,
        endSeconds: activeDrag.currentSeconds,
      });

      if (!normalized || normalized.endSeconds - normalized.startSeconds < 0.15) {
        previewSeek(activeDrag.currentSeconds);

        await runAction(async () => {
          const nextSnapshot = await seekTransport(activeDrag.currentSeconds);
          setSnapshot(nextSnapshot);
          setStatus(`Cursor movido a ${formatClock(nextSnapshot.positionSeconds)}`);
        });
        setTimeSelection(null);
        return;
      }

      setTimeSelection(normalized);
      setStatus(
        `Rango temporal listo: ${formatClock(normalized.startSeconds)} -> ${formatClock(normalized.endSeconds)}`,
      );
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [cameraX, rulerDrag, snapEnabled, song, timelineViewportWidth, zoomLevel]);

  useEffect(() => {
    if (!playheadDrag || !song || !rulerTrackRef.current) {
      return;
    }

    const effectSong = song;
    const effectPixelsPerSecond = zoomLevel * BASE_PIXELS_PER_SECOND;
    const effectLaneViewportWidth = Math.max(320, timelineViewportWidth - HEADER_WIDTH);
    const effectCameraX = clampCameraX(
      cameraX,
      effectSong.durationSeconds,
      effectPixelsPerSecond,
      effectLaneViewportWidth,
    );

    const onMouseMove = (event: MouseEvent) => {
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

      previewSeek(activeDrag.currentSeconds);

      await runAction(async () => {
        const nextSnapshot = await seekTransport(activeDrag.currentSeconds);
        setSnapshot(nextSnapshot);
        setStatus(`Cursor movido a ${formatClock(nextSnapshot.positionSeconds)}`);
      });
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [cameraX, playheadDrag, snapEnabled, song, timelineViewportWidth, zoomLevel]);

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

  async function runAction(work: () => Promise<void>, options?: { busy?: boolean }) {
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
  }

  function syncLivePosition(positionSeconds: number) {
    const durationSeconds = song?.durationSeconds ?? 0;
    const clampedPosition = clamp(positionSeconds, 0, durationSeconds || Number.MAX_SAFE_INTEGER);
    const playheadOffset = secondsToScreenX(
      clampedPosition,
      clampedTimelineCameraX,
      pixelsPerSecond,
    );

    displayPositionSecondsRef.current = clampedPosition;
    panelRef.current?.style.setProperty("--lt-playhead-left", `${playheadOffset}px`);

    if (transportReadoutValueRef.current) {
      transportReadoutValueRef.current.textContent = formatClock(clampedPosition);
    }
  }

  function previewSeek(positionSeconds: number) {
    const durationSeconds = song?.durationSeconds ?? 0;
    const clampedPosition = clamp(positionSeconds, 0, durationSeconds || Number.MAX_SAFE_INTEGER);

    playbackVisualAnchorRef.current = {
      anchorPositionSeconds: clampedPosition,
      anchorReceivedAtMs: performance.now(),
      durationSeconds,
      running: snapshot?.playbackState === "playing" && Boolean(snapshot?.transportClock?.running),
    };
    setDisplayPositionSeconds(clampedPosition);
    syncLivePosition(clampedPosition);
  }

  const laneViewportWidth = Math.max(320, timelineViewportWidth - HEADER_WIDTH);
  const fitAllZoomLevel = song?.durationSeconds
    ? clamp(
        laneViewportWidth / (Math.max(song.durationSeconds, 1) * BASE_PIXELS_PER_SECOND),
        ZOOM_MIN,
        ZOOM_MAX,
      )
    : ZOOM_MIN;
  const effectiveZoomMin = song ? fitAllZoomLevel : ZOOM_MIN;
  const pixelsPerSecond = zoomLevel * BASE_PIXELS_PER_SECOND;
  const maxTimelineCameraX = getMaxCameraX(song?.durationSeconds ?? 0, pixelsPerSecond, laneViewportWidth);
  const clampedTimelineCameraX = clamp(cameraX, 0, maxTimelineCameraX);
  const visibleDurationSeconds = laneViewportWidth / Math.max(1, pixelsPerSecond);
  const viewportStartSeconds = clampedTimelineCameraX / Math.max(1, pixelsPerSecond);
  const viewportEndSeconds = viewportStartSeconds + visibleDurationSeconds;
  const positionSeconds = playheadDrag?.currentSeconds ?? displayPositionSeconds;
  const musicalPositionLabel =
    snapshot?.musicalPosition?.display ??
    (song ? formatMusicalPosition(positionSeconds, song.bpm, song.timeSignature) : "1.1.00");
  const tempoSourceLabel =
    song?.tempoMetadata.source === "auto_import"
      ? `Detectado en importacion${song.tempoMetadata.confidence != null ? ` (${Math.round(song.tempoMetadata.confidence * 100)}%)` : ""}`
      : "Manual";
  const timelineRowWidth = HEADER_WIDTH + laneViewportWidth;
  const visibleTracks = song ? buildVisibleTracks(song, collapsedFolders) : [];
  const selectedTrack = selectedTrackId ? tracksById[selectedTrackId] ?? null : null;
  const selectedClip = findClip(song, selectedClipId);
  const selectedSection = findSection(song, selectedSectionId);
  const currentSelection = normalizeSelection(
    rulerDrag
      ? {
          startSeconds: rulerDrag.startSeconds,
          endSeconds: rulerDrag.currentSeconds,
        }
      : timeSelection,
  );
  const currentSelectionLeft = currentSelection
    ? secondsToScreenX(currentSelection.startSeconds, clampedTimelineCameraX, pixelsPerSecond)
    : 0;
  const currentSelectionWidth = currentSelection
    ? (currentSelection.endSeconds - currentSelection.startSeconds) * pixelsPerSecond
    : 0;
  const draggedPlayheadOffset =
    playheadDrag && song
      ? secondsToScreenX(playheadDrag.currentSeconds, clampedTimelineCameraX, pixelsPerSecond)
      : null;
  const timelineGrid = useTimelineGrid({
    durationSeconds: song?.durationSeconds ?? 0,
    bpm: song?.bpm ?? 120,
    timeSignature: song?.timeSignature ?? "4/4",
    zoomLevel,
    pixelsPerSecond,
    viewportStartSeconds,
    viewportEndSeconds,
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
    const nextSnapshot = await scheduleSectionJump(
      markerId,
      trigger,
      trigger === "after_bars" ? bars : undefined,
    );
    setSnapshot(nextSnapshot);
    setStatus(
      trigger === "immediate"
        ? `Salto inmediato a ${markerName}.`
        : trigger === "section_end"
          ? `Salto armado al final de seccion hacia ${markerName}.`
          : `Salto armado en ${bars} compases hacia ${markerName}.`,
    );
  }

  useEffect(() => {
    setZoomLevel((current) => (current < effectiveZoomMin ? effectiveZoomMin : current));
  }, [effectiveZoomMin]);

  useEffect(() => {
    if (cameraX !== clampedTimelineCameraX) {
      setCameraX(clampedTimelineCameraX);
    }
  }, [cameraX, clampedTimelineCameraX]);

  useEffect(() => {
    const shell = timelineShellRef.current;
    if (!shell) {
      return;
    }

    shell.scrollLeft = clampedTimelineCameraX;
  }, [clampedTimelineCameraX]);

  useEffect(() => {
    const horizontalScrollbar = horizontalScrollbarRef.current;
    if (!horizontalScrollbar) {
      return;
    }

    horizontalScrollbar.scrollLeft = clampedTimelineCameraX;
  }, [clampedTimelineCameraX]);

  useEffect(() => {
    syncLivePosition(playheadDrag?.currentSeconds ?? displayPositionSecondsRef.current);
  }, [
    clampedTimelineCameraX,
    displayPositionSeconds,
    pixelsPerSecond,
    playheadDrag?.currentSeconds,
    song?.durationSeconds,
  ]);

  function clearSelections(message: string) {
    setSelectedTrackId(null);
    setSelectedClipId(null);
    setSelectedSectionId(null);
    setTimeSelection(null);
    setContextMenu(null);
    setStatus(message);
  }

  function applyZoom(nextZoomLevel: number, anchorViewportX = laneViewportWidth / 2) {
    const clampedZoom = clamp(nextZoomLevel, effectiveZoomMin, ZOOM_MAX);
    const nextPixelsPerSecond = clampedZoom * BASE_PIXELS_PER_SECOND;
    const durationSeconds = song?.durationSeconds ?? 0;
    const nextCameraX = zoomCameraAtViewportX({
      durationSeconds,
      viewportWidth: laneViewportWidth,
      viewportX: clamp(anchorViewportX, 0, laneViewportWidth),
      currentCameraX: clampedTimelineCameraX,
      previousPixelsPerSecond: pixelsPerSecond,
      nextPixelsPerSecond,
    });

    setZoomLevel(clampedZoom);
    setCameraX(nextCameraX);
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
    const track = findTrack(song, trackId);
    const draftVolume = volumeDrafts[trackId];
    if (!track || draftVolume === undefined) {
      return;
    }

    const nextVolume = clamp(draftVolume, 0, 1);
    if (Math.abs(nextVolume - track.volume) < 0.0001) {
      setVolumeDrafts((current) => {
        const next = { ...current };
        delete next[trackId];
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
    if (!song) {
      return [];
    }

    const previousFolder = findPreviousFolderTrack(song, track.id);
    const parentTrack = findTrack(song, track.parentTrackId ?? null);
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
          const clipCount = song.clips.filter((clip) => clip.trackId === track.id).length;
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
      clampedTimelineCameraX,
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
    const panOriginCameraX = timelineShellRef.current?.scrollLeft ?? clampedTimelineCameraX;
    const activePan: NonNullable<TimelinePanState> = {
      pointerId: 1,
      startClientX: event.clientX,
      originCameraX: panOriginCameraX,
    };
    setTimelinePan(activePan);

    const onMouseMove = (windowEvent: MouseEvent) => {
      const deltaX = activePan.startClientX - windowEvent.clientX;
      setCameraX(
        clampCameraX(
          activePan.originCameraX + deltaX,
          song?.durationSeconds ?? 0,
          pixelsPerSecond,
          laneViewportWidth,
        ),
      );
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
      clampedTimelineCameraX,
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

  function sectionContextMenu(section: SectionSummary) {
    const marker = findSectionMarker(song, section.id);
    const canEditMarker = Boolean(marker);

    return [
      {
        label: "Renombrar",
        disabled: !canEditMarker,
        onSelect: async () => {
          if (!marker) {
            return;
          }
          const nextName = window.prompt("Nuevo nombre de la seccion", section.name)?.trim();
          if (!nextName) {
            return;
          }
          await runAction(async () => {
            const nextSnapshot = await updateSectionMarker(section.id, nextName, marker.startSeconds);
            setSnapshot(nextSnapshot);
            setStatus(`Seccion renombrada: ${nextName}`);
          });
        },
      },
      {
        label: "Borrar",
        disabled: !canEditMarker,
        onSelect: async () => {
          if (!marker) {
            return;
          }
          await runAction(async () => {
            const nextSnapshot = await deleteSectionMarker(section.id);
            setSnapshot(nextSnapshot);
            setSelectedSectionId(null);
            setStatus(`Seccion eliminada: ${section.name}`);
          });
        },
      },
      {
        label: marker?.digit == null ? "Asignar digito" : `Cambiar digito (${marker.digit})`,
        disabled: !canEditMarker,
        onSelect: async () => {
          if (!marker) {
            return;
          }
          const value = window.prompt("Digito 0-9 (vacio para liberar)", marker.digit?.toString() ?? "");
          if (value === null) {
            return;
          }
          const trimmed = value.trim();
          const nextDigit = trimmed === "" ? null : Number(trimmed);
          if (nextDigit !== null && (!Number.isInteger(nextDigit) || nextDigit < 0 || nextDigit > 9)) {
            setStatus("Digito invalido. Usa un valor entre 0 y 9.");
            return;
          }

          await runAction(async () => {
            const nextSnapshot = await assignSectionMarkerDigit(section.id, nextDigit);
            setSnapshot(nextSnapshot);
            setStatus(
              nextDigit === null
                ? `Digito liberado para ${section.name}.`
                : `Digito ${nextDigit} asignado a ${section.name}.`,
            );
          });
        },
      },
      {
        label: "Ir ahora",
        disabled: !canEditMarker,
        onSelect: async () => {
          if (!marker) {
            return;
          }
          await runAction(async () => {
            const nextSnapshot = await scheduleSectionJump(section.id, "immediate");
            setSnapshot(nextSnapshot);
            setStatus(`Cursor enviado a ${section.name}`);
          });
        },
      },
      {
        label: "Disparar con modo global",
        disabled: !canEditMarker,
        onSelect: async () => {
          if (!marker) {
            return;
          }
          await runAction(async () => {
            await scheduleMarkerJumpWithGlobalMode(marker.id, section.name);
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
            <button type="button" aria-label="Anterior">
              <span className="material-symbols-outlined">skip_previous</span>
            </button>
            <button
              type="button"
              aria-label="Detener"
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
            <button type="button" aria-label="Siguiente">
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
              <strong>{musicalPositionLabel}</strong>
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

        <div className="lt-session-actions">
          <button
            type="button"
            onClick={() => void runAction(async () => setSnapshot(await createSong()), { busy: true })}
          >
            Crear cancion
          </button>
          <button
            type="button"
            onClick={() =>
              void runAction(async () => setSnapshot((await openProject()) ?? snapshot), { busy: true })
            }
          >
            Abrir
          </button>
          <button
            type="button"
            onClick={() => void runAction(async () => setSnapshot(await saveProject()), { busy: true })}
          >
            Guardar
          </button>
          <button
            type="button"
            onClick={() => setIsImportModalOpen(true)}
          >
            Importar WAVs
          </button>
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
      <section className="lt-main-stage">
        <div className="lt-timeline-topline">
          <div className="lt-timeline-stats">
            <span>{song?.tracks.length ?? 0} tracks</span>
            <span>{song?.clips.length ?? 0} clips</span>
            <span>{song?.sectionMarkers.length ?? 0} marcas</span>
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
                  clampedTimelineCameraX,
                  pixelsPerSecond,
                );
                setSelectedSectionId(null);
                setContextMenu(null);
                pendingRulerPressRef.current = {
                  startClientX: event.clientX,
                  startSeconds,
                };
              }}
            >
              <div className="lt-ruler-content" style={{ width: laneViewportWidth }}>
                <TimelineRulerCanvas
                  width={laneViewportWidth}
                  height={RULER_HEIGHT}
                  cameraX={clampedTimelineCameraX}
                  pixelsPerSecond={pixelsPerSecond}
                  timelineGrid={timelineGrid}
                  selection={currentSelection}
                  playheadSecondsRef={displayPositionSecondsRef}
                  previewPlayheadSeconds={playheadDrag?.currentSeconds ?? null}
                  playheadColor={playheadColor}
                >
                  {timelineHeaderMarkers.map((marker) => {
                    const markerLeft = secondsToScreenX(
                      marker.seconds,
                      clampedTimelineCameraX,
                      pixelsPerSecond,
                    );

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

                  {song?.derivedSections.map((section) => {
                    const sectionLeft = secondsToScreenX(
                      section.startSeconds,
                      clampedTimelineCameraX,
                      pixelsPerSecond,
                    );
                    const sectionWidth = (section.endSeconds - section.startSeconds) * pixelsPerSecond;

                    if (sectionLeft + sectionWidth < 0 || sectionLeft > laneViewportWidth) {
                      return null;
                    }

                    return (
                      <button
                        key={section.id}
                        type="button"
                        className={`lt-section-tag ${selectedSectionId === section.id ? "is-selected" : ""}`}
                        style={{ left: sectionLeft, width: sectionWidth }}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedSectionId(section.id);
                          setSelectedClipId(null);
                          setSelectedTrackId(null);
                          setStatus(`Seccion seleccionada: ${section.name}`);
                        }}
                        onContextMenu={(event) => {
                          event.stopPropagation();
                          setSelectedSectionId(section.id);
                          openMenu(event, section.name, sectionContextMenu(section));
                        }}
                      >
                        {section.name}
                      </button>
                    );
                  })}
                </TimelineRulerCanvas>

                {currentSelection ? (
                  <div
                    className="lt-time-selection"
                    style={{ left: currentSelectionLeft, width: currentSelectionWidth }}
                  />
                ) : null}

                <div
                  className={`lt-playhead is-handle ${playheadDrag ? "is-dragging" : ""}`}
                  style={draggedPlayheadOffset === null ? undefined : { left: draggedPlayheadOffset }}
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
                cameraX={clampedTimelineCameraX}
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
                    <div
                      className={`lt-track-header ${trackDensityClass} ${isTrackSelected ? "is-selected" : ""} ${track.solo ? "is-solo" : ""} ${track.kind === "folder" ? "is-folder" : ""} ${isDropTarget ? "is-drop-target" : ""} ${draggingTrackId === track.id ? "is-dragging" : ""}`}
                      style={{ height: trackHeight, paddingLeft: 16 + track.depth * 22 }}
                      role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (suppressTrackClickRef.current) {
                        suppressTrackClickRef.current = false;
                        return;
                      }

                      setSelectedTrackId(track.id);
                      setSelectedClipId(null);
                      setSelectedSectionId(null);
                      setStatus(`Track seleccionado: ${track.name}`);
                    }}
                    onContextMenu={(event) => {
                      setSelectedTrackId(track.id);
                      openMenu(event, track.name, trackContextMenu(track));
                    }}
                  >
                    <div className="lt-track-header-main">
                      <div className="lt-track-title-row">
                        <button
                          type="button"
                          className="lt-track-drag-handle"
                          aria-label={`Mover ${track.name}`}
                          onMouseDown={(event) => {
                            if (event.button !== 0) {
                              return;
                            }

                            event.stopPropagation();
                            setContextMenu(null);
                            setTrackDrag({
                              trackId: track.id,
                              pointerId: 1,
                              startClientX: event.clientX,
                              startClientY: event.clientY,
                              currentClientY: event.clientY,
                              isDragging: false,
                            });
                          }}
                        >
                          ::
                        </button>
                        {track.kind === "folder" ? (
                          <button
                            type="button"
                            className="lt-folder-toggle"
                            aria-label={collapsedFolders.has(track.id) ? `Expandir ${track.name}` : `Colapsar ${track.name}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              setCollapsedFolders((current) => {
                                const next = new Set(current);
                                if (next.has(track.id)) {
                                  next.delete(track.id);
                                } else {
                                  next.add(track.id);
                                }
                                return next;
                              });
                            }}
                          >
                            {collapsedFolders.has(track.id) ? "+" : "-"}
                          </button>
                        ) : null}
                        <strong>{track.name}</strong>
                      </div>
                      <span className="lt-track-meta">
                        {track.kind === "folder"
                          ? `${childCount} hijos`
                          : `${trackClips.length} clips | pan ${track.pan.toFixed(2)}`}
                      </span>
                      {isDropTarget ? (
                        <span className="lt-track-drop-hint">
                          {dropMode === "inside-folder"
                            ? "Soltar para meter en folder"
                            : dropMode === "before"
                              ? "Soltar para subir antes de este track"
                              : "Soltar para bajar despues de este track"}
                        </span>
                      ) : null}
                    </div>

                    <div className="lt-track-control-row">
                      <div className="lt-track-toggle-group">
                        <button
                          type="button"
                          className={track.muted ? "is-active" : ""}
                          onClick={(event) => {
                            event.stopPropagation();
                            void runAction(async () => {
                              const nextSnapshot = await updateTrack({
                                trackId: track.id,
                                muted: !track.muted,
                              });
                              setSnapshot(nextSnapshot);
                            });
                          }}
                        >
                          M
                        </button>
                        <button
                          type="button"
                          className={track.solo ? "is-active" : ""}
                          onClick={(event) => {
                            event.stopPropagation();
                            void runAction(async () => {
                              const nextSnapshot = await updateTrack({
                                trackId: track.id,
                                solo: !track.solo,
                              });
                              setSnapshot(nextSnapshot);
                            });
                          }}
                        >
                          S
                        </button>
                      </div>
                      <label className="lt-track-volume">
                        <span>Vol</span>
                        <input
                          aria-label={`Volumen de ${track.name}`}
                          type="range"
                          min={0}
                          max={1}
                          step={0.01}
                          value={volumeDrafts[track.id] ?? track.volume}
                          style={{
                            background: `linear-gradient(to right, ${track.solo ? "#ffe2ab" : "#3cddc7"} ${((volumeDrafts[track.id] ?? track.volume) * 100).toFixed(2)}%, #0e0e0e ${((volumeDrafts[track.id] ?? track.volume) * 100).toFixed(2)}%)`,
                          }}
                          onChange={(event) => {
                            setVolumeDrafts((current) => ({
                              ...current,
                              [track.id]: Number(event.target.value),
                            }));
                          }}
                          onMouseUp={() => {
                            void commitTrackVolume(track.id);
                          }}
                          onTouchEnd={() => {
                            void commitTrackVolume(track.id);
                          }}
                          onKeyUp={(event) => {
                            if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") {
                              void commitTrackVolume(track.id);
                            }
                          }}
                          onBlur={() => {
                            void commitTrackVolume(track.id);
                          }}
                        />
                      </label>
                    </div>
                  </div>

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
              onScroll={(event) => setCameraX(event.currentTarget.scrollLeft)}
            >
              <div
                className="lt-horizontal-scrollbar-content"
                style={{ width: laneViewportWidth + maxTimelineCameraX }}
              />
            </div>
            </div>
          </div>

        {currentSelection ? (
            <div className="lt-inline-menu">
              <span>
                Seleccion: {formatClock(currentSelection.startSeconds)} {"->"} {formatClock(currentSelection.endSeconds)}
              </span>
            <button
              type="button"
              onClick={() =>
                void runAction(async () => {
                  const nextSnapshot = await createSectionMarker(currentSelection.startSeconds);
                  setSnapshot(nextSnapshot);
                  setTimeSelection(null);
                  setStatus("Marca creada desde la seleccion temporal.");
                })
              }
            >
              Crear marca
            </button>
            <button type="button" onClick={() => clearSelections("Seleccion temporal cancelada.")}>
              Cancelar seleccion
            </button>
          </div>
        ) : null}
      </section>

      <footer className="lt-bottom-strip">
        <div className="lt-bottom-status">
          <strong>Estado</strong>
          <p>{status}</p>
        </div>
        <div className="lt-bottom-controls">
          <button type="button" className={snapEnabled ? "is-active" : ""} onClick={() => setSnapEnabled((current) => !current)}>
            Snap to Grid ({timelineGrid.subdivisionPerBeat}/1)
          </button>
          <label className="lt-zoom-control">
            <span>Modo salto</span>
            <select
              aria-label="Modo global de salto"
              value={globalJumpMode}
              onChange={(event) => setGlobalJumpMode(event.target.value as GlobalJumpMode)}
            >
              <option value="immediate">Immediate</option>
              <option value="after_bars">After X bars</option>
              <option value="section_end">At section end</option>
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
          {snapshot?.pendingSectionJump ? (
            <span>
              Armado: {snapshot.pendingSectionJump.targetMarkerName} | {snapshot.pendingSectionJump.trigger}
            </span>
          ) : null}
          <button
            type="button"
            disabled={!snapshot?.pendingSectionJump}
            onClick={() =>
              void runAction(async () => {
                const nextSnapshot = await cancelSectionJump();
                setSnapshot(nextSnapshot);
                setStatus("Salto cancelado.");
              })
            }
          >
            Cancelar salto
          </button>
        </div>
      </footer>

      {selectedClip ? (
        <div className="lt-inspector-strip">
          <strong>Clip</strong>
          <span>{selectedClip.trackName}</span>
          <span>
            {formatClock(selectedClip.timelineStartSeconds)} | {selectedClip.durationSeconds.toFixed(2)}s
          </span>
        </div>
      ) : null}

      {selectedTrack ? (
        <div className="lt-inspector-strip">
          <strong>Track</strong>
          <span>{selectedTrack.name}</span>
          <span>{selectedTrack.kind === "folder" ? "folder" : "audio"}</span>
        </div>
      ) : null}

      {selectedSection ? (
        <div className="lt-inspector-strip">
          <strong>Seccion</strong>
          <span>{selectedSection.name}</span>
          <span>
            {formatClock(selectedSection.startSeconds)} {"->"} {formatClock(selectedSection.endSeconds)}
          </span>
        </div>
      ) : null}

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
        </div>
      </div>
      </div>
    </Profiler>
  );
}
