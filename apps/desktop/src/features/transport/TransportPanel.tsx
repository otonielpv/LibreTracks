import { Profiler, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  cancelSectionJump,
  createSection,
  createSong,
  createTrack,
  deleteClip,
  deleteSection,
  deleteTrack,
  duplicateClip,
  getSongView,
  getTransportSnapshot,
  getWaveformSummaries,
  isTauriApp,
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
  updateSection,
  updateSongTempo,
  updateTrack,
  type ClipSummary,
  type SectionSummary,
  type SongView,
  type TrackKind,
  type TrackSummary,
  type TransportSnapshot,
  type WaveformSummaryDto,
  reportUiRenderMetric,
} from "./desktopApi";

const HEADER_WIDTH = 260;
const DEFAULT_TIMELINE_VIEWPORT_WIDTH = 1100;
const TRACK_HEIGHT = 94;
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 48;
const ZOOM_STEP = 0.25;
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

type TimeSelection = {
  startSeconds: number;
  endSeconds: number;
} | null;

type PendingRulerPress = {
  startClientX: number;
  startSeconds: number;
} | null;

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

function formatMusicalPosition(seconds: number, bpm: number, timeSignature: string) {
  const [numeratorRaw] = timeSignature.split("/");
  const beatsPerBar = Math.max(1, Number(numeratorRaw) || 4);
  const beatDurationSeconds = bpm > 0 ? 60 / bpm : 0.5;
  const totalBeats = Math.max(0, seconds) / beatDurationSeconds;
  const barNumber = Math.floor(totalBeats / beatsPerBar) + 1;
  const beatInBar = (Math.floor(totalBeats) % beatsPerBar) + 1;
  const subBeat = Math.floor((totalBeats % 1) * 100);
  return `${barNumber}.${beatInBar}.${String(subBeat).padStart(2, "0")}`;
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

function buildRulerMarks(durationSeconds: number, zoomLevel: number) {
  const stepSeconds =
    zoomLevel >= 24 ? 1 : zoomLevel >= 12 ? 2 : zoomLevel >= 6 ? 4 : zoomLevel >= 3 ? 8 : 16;
  const marks: number[] = [];

  for (let current = 0; current <= durationSeconds; current += stepSeconds) {
    marks.push(current);
  }

  if (marks.at(-1) !== durationSeconds) {
    marks.push(durationSeconds);
  }

  return marks;
}

function cropWaveform(clip: ClipSummary, waveform: WaveformSummaryDto | undefined) {
  const peaks = waveform?.maxPeaks ?? [];
  const minPeaks = waveform?.minPeaks?.length ? waveform.minPeaks : peaks.map((peak) => -peak);
  if (!peaks.length || clip.sourceDurationSeconds <= 0) {
    return {
      min: [],
      max: [],
    };
  }

  const startRatio = clamp(clip.sourceStartSeconds / clip.sourceDurationSeconds, 0, 1);
  const endRatio = clamp(
    (clip.sourceStartSeconds + clip.durationSeconds) / clip.sourceDurationSeconds,
    0,
    1,
  );
  const startIndex = Math.floor(startRatio * peaks.length);
  const endIndex = Math.max(startIndex + 1, Math.ceil(endRatio * peaks.length));

  return {
    min: minPeaks.slice(startIndex, endIndex),
    max: peaks.slice(startIndex, endIndex),
  };
}

function buildWaveformPath(clip: ClipSummary, waveform: WaveformSummaryDto | undefined) {
  const { min, max } = cropWaveform(clip, waveform);
  if (!max.length || !min.length) {
    return "";
  }

  const topPoints = max.map((peak, index) => {
    const x = (index / Math.max(1, max.length - 1)) * 100;
    const y = 50 - peak * 42;
    return `${x},${y}`;
  });
  const bottomPoints = min
    .map((peak, index) => {
      const x = (index / Math.max(1, min.length - 1)) * 100;
      const y = 50 - peak * 42;
      return `${x},${y}`;
    })
    .reverse();

  return `M ${topPoints.join(" L ")} L ${bottomPoints.join(" L ")} Z`;
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

  return song.sections.find((section) => section.id === sectionId) ?? null;
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
          ".lt-clip, .lt-section-tag, .lt-track-header, .lt-inline-menu, .lt-context-menu, button, input, select, textarea, label",
        ),
      )
    : false;
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
  pixelsPerSecond: number,
) {
  const bounds = element.getBoundingClientRect();
  const x = clamp(event.clientX - bounds.left, 0, bounds.width);
  const visibleDuration = bounds.width / pixelsPerSecond;
  const totalDuration = Math.max(durationSeconds, visibleDuration);
  const seconds = (x / bounds.width) * totalDuration;
  return clamp(seconds, 0, durationSeconds);
}

export function TransportPanel() {
  const [snapshot, setSnapshot] = useState<TransportSnapshot | null>(null);
  const [song, setSong] = useState<SongView | null>(null);
  const [waveformCache, setWaveformCache] = useState<Record<string, WaveformSummaryDto>>({});
  const [clipsByTrack, setClipsByTrack] = useState<Record<string, ClipSummary[]>>({});
  const [tracksById, setTracksById] = useState<Record<string, TrackSummary>>({});
  const [clipWaveformPaths, setClipWaveformPaths] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("Cargando sesion...");
  const [isBusy, setIsBusy] = useState(false);
  const [tempoDraft, setTempoDraft] = useState("120");
  const [zoomLevel, setZoomLevel] = useState(7);
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
  const [isTimelinePanning, setIsTimelinePanning] = useState(false);
  const [displayPositionSeconds, setDisplayPositionSeconds] = useState(0);
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(DEFAULT_TIMELINE_VIEWPORT_WIDTH);
  const [trackDrag, setTrackDrag] = useState<TrackDragState>(null);
  const [volumeDrafts, setVolumeDrafts] = useState<Record<string, number>>({});
  const [draggingTrackId, setDraggingTrackId] = useState<string | null>(null);
  const [trackDropState, setTrackDropState] = useState<TrackDropState>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const laneAreaRef = useRef<HTMLDivElement | null>(null);
  const rulerTrackRef = useRef<HTMLDivElement | null>(null);
  const timelineShellRef = useRef<HTMLDivElement | null>(null);
  const playbackVisualAnchorRef = useRef({
    anchorPositionSeconds: 0,
    anchorReceivedAtMs: 0,
    durationSeconds: 0,
    running: false,
  });
  const displayPositionSecondsRef = useRef(0);
  const pendingZoomAnchorRef = useRef<{ seconds: number; viewOffsetX: number } | null>(null);
  const suppressTrackClickRef = useRef(false);
  const pendingRulerPressRef = useRef<PendingRulerPress>(null);
  const renderMetricTimeoutRef = useRef<number | null>(null);
  const pendingRenderMetricRef = useRef(0);
  const transportReadoutValueRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let active = true;

    async function loadSnapshot() {
      const nextSnapshot = await getTransportSnapshot();
      if (!active) {
        return;
      }

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

    const interval = window.setInterval(async () => {
      const nextSnapshot = await getTransportSnapshot();
      if (!active) {
        return;
      }
      setSnapshot(nextSnapshot);
    }, 300);

    return () => {
      active = false;
      window.clearInterval(interval);
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
      setClipWaveformPaths({});
      return;
    }

    const nextTracksById = Object.fromEntries(song.tracks.map((track) => [track.id, track]));
    const nextClipsByTrack = Object.fromEntries(song.tracks.map((track) => [track.id, [] as ClipSummary[]]));
    const nextClipWaveformPaths: Record<string, string> = {};

    for (const clip of song.clips) {
      nextClipsByTrack[clip.trackId] ??= [];
      nextClipsByTrack[clip.trackId].push(clip);
      nextClipWaveformPaths[clip.id] = buildWaveformPath(clip, waveformCache[clip.waveformKey]);
    }

    setTracksById(nextTracksById);
    setClipsByTrack(nextClipsByTrack);
    setClipWaveformPaths(nextClipWaveformPaths);
  }, [song, waveformCache]);

  useEffect(() => {
    const songDurationSeconds = song?.durationSeconds ?? 0;
    const anchorPositionSeconds =
      snapshot?.playbackState === "playing" && snapshot.transportClock?.running
        ? snapshot.transportClock.anchorPositionSeconds
        : snapshot?.positionSeconds ?? 0;

    playbackVisualAnchorRef.current = {
      anchorPositionSeconds,
      anchorReceivedAtMs: performance.now(),
      durationSeconds: songDurationSeconds,
      running: snapshot?.playbackState === "playing" && Boolean(snapshot.transportClock?.running),
    };

    if (snapshot?.playbackState !== "playing") {
      displayPositionSecondsRef.current = snapshot?.positionSeconds ?? 0;
      setDisplayPositionSeconds(snapshot?.positionSeconds ?? 0);
    }
  }, [
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

      syncLivePosition(nextPositionSeconds);
      animationFrameId = window.requestAnimationFrame(tick);
    };

    animationFrameId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [playheadDrag, snapshot?.playbackState]);

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

      if (event.key === "Escape") {
        event.preventDefault();
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
  }, [selectedClipId, snapshot?.playbackState]);

  useEffect(() => {
    if (!clipDrag || !song || !laneAreaRef.current) {
      return;
    }

    const effectSong = song;

    const onMouseMove = (event: MouseEvent) => {
      const deltaSeconds = (event.clientX - clipDrag.startClientX) / (zoomLevel * 18);
      const nextSeconds = snapEnabled
        ? snapToBeat(clipDrag.originSeconds + deltaSeconds, effectSong.bpm)
        : clipDrag.originSeconds + deltaSeconds;

      setClipDrag((current) =>
        current
          ? {
              ...current,
              previewSeconds: clamp(nextSeconds, 0, effectSong.durationSeconds),
            }
          : current,
      );
    };

    const onMouseUp = async (event: MouseEvent) => {
      if (event.button !== 0) {
        return;
      }

      const activeDrag = clipDrag;
      setClipDrag(null);
      if (!activeDrag) {
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

    const onMouseMove = (event: MouseEvent) => {
      const nextSeconds = rulerPointerToSeconds(
        event,
        rulerTrackRef.current as HTMLElement,
        song.durationSeconds,
        zoomLevel * 18,
      );
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
      const pointerSeconds = rulerPointerToSeconds(
        event,
        rulerTrackRef.current as HTMLElement,
        song.durationSeconds,
        zoomLevel * 18,
      );

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
  }, [rulerDrag, song, zoomLevel]);

  useEffect(() => {
    if (!playheadDrag || !song || !rulerTrackRef.current) {
      return;
    }

    const effectSong = song;

    const onMouseMove = (event: MouseEvent) => {
      const nextSeconds = rulerPointerToSeconds(
        event,
        rulerTrackRef.current as HTMLElement,
        effectSong.durationSeconds,
        zoomLevel * 18,
      );
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
  }, [playheadDrag, song, zoomLevel]);

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
    const durationForOffset = Math.max(1, durationSeconds);
    const playheadOffset = (clampedPosition / durationForOffset) * timelineWidth;

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
    ? clamp(laneViewportWidth / (Math.max(song.durationSeconds, 1) * 18), ZOOM_MIN, ZOOM_MAX)
    : ZOOM_MIN;
  const effectiveZoomMin = song ? fitAllZoomLevel : ZOOM_MIN;
  const positionSeconds = playheadDrag?.currentSeconds ?? displayPositionSeconds;
  const musicalPositionLabel = song
    ? formatMusicalPosition(positionSeconds, song.bpm, song.timeSignature)
    : "1.1.00";
  const pixelsPerSecond = zoomLevel * 18;
  const timelineWidth = Math.max((song?.durationSeconds ?? 0) * pixelsPerSecond, laneViewportWidth);
  const timelineRowWidth = HEADER_WIDTH + timelineWidth;
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
    ? (currentSelection.startSeconds / Math.max(1, song?.durationSeconds ?? 1)) * timelineWidth
    : 0;
  const currentSelectionWidth = currentSelection
    ? ((currentSelection.endSeconds - currentSelection.startSeconds) /
        Math.max(1, song?.durationSeconds ?? 1)) *
      timelineWidth
    : 0;
  const draggedPlayheadOffset =
    playheadDrag && song
      ? (playheadDrag.currentSeconds / Math.max(1, song.durationSeconds)) * timelineWidth
      : null;
  const rulerMarks = buildRulerMarks(song?.durationSeconds ?? 0, zoomLevel);

  useEffect(() => {
    setZoomLevel((current) => (current < effectiveZoomMin ? effectiveZoomMin : current));
  }, [effectiveZoomMin]);

  useEffect(() => {
    if (!pendingZoomAnchorRef.current || !timelineShellRef.current) {
      return;
    }

    const pendingAnchor = pendingZoomAnchorRef.current;
    pendingZoomAnchorRef.current = null;

    const shell = timelineShellRef.current;
    const laneOffsetX = clamp(
      pendingAnchor.viewOffsetX - HEADER_WIDTH,
      0,
      Math.max(0, shell.clientWidth - HEADER_WIDTH),
    );
    const nextScrollLeft = pendingAnchor.seconds * pixelsPerSecond - laneOffsetX;
    shell.scrollLeft = clamp(nextScrollLeft, 0, Math.max(0, timelineRowWidth - shell.clientWidth));
  }, [pixelsPerSecond, timelineRowWidth]);

  useEffect(() => {
    syncLivePosition(playheadDrag?.currentSeconds ?? displayPositionSecondsRef.current);
  }, [playheadDrag?.currentSeconds, timelineWidth, song?.durationSeconds, displayPositionSeconds]);

  function clearSelections(message: string) {
    setSelectedTrackId(null);
    setSelectedClipId(null);
    setSelectedSectionId(null);
    setTimeSelection(null);
    setContextMenu(null);
    setStatus(message);
  }

  function beginTimelinePan(event: ReactMouseEvent) {
    if (!timelineShellRef.current) {
      return;
    }

    const canPanWithPrimaryButton =
      event.button === 0 &&
      !isInteractiveTimelineTarget(event.target) &&
      !(event.target instanceof HTMLElement && event.target.closest(".lt-ruler-track"));

    if (event.button !== 1 && !canPanWithPrimaryButton) {
      return;
    }

    event.preventDefault();
    const shell = timelineShellRef.current;
    const startX = event.clientX;
    const startScrollLeft = shell.scrollLeft;
    setIsTimelinePanning(true);

    const onMove = (moveEvent: MouseEvent) => {
      shell.scrollLeft = startScrollLeft - (moveEvent.clientX - startX);
    };

    const onUp = () => {
      setIsTimelinePanning(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function applyZoom(nextZoomLevel: number) {
    const shell = timelineShellRef.current;
    const clampedZoom = clamp(nextZoomLevel, effectiveZoomMin, ZOOM_MAX);

    if (!shell) {
      setZoomLevel(clampedZoom);
      return;
    }

    const laneCenterOffsetX = Math.max(0, (shell.clientWidth - HEADER_WIDTH) / 2);

    pendingZoomAnchorRef.current = {
      seconds: displayPositionSecondsRef.current,
      viewOffsetX: HEADER_WIDTH + laneCenterOffsetX,
    };
    setZoomLevel(clampedZoom);
  }

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

  function sectionContextMenu(section: SectionSummary) {
    return [
      {
        label: "Renombrar",
        onSelect: async () => {
          const nextName = window.prompt("Nuevo nombre de la seccion", section.name)?.trim();
          if (!nextName) {
            return;
          }
          await runAction(async () => {
            const nextSnapshot = await updateSection(
              section.id,
              nextName,
              section.startSeconds,
              section.endSeconds,
            );
            setSnapshot(nextSnapshot);
            setStatus(`Seccion renombrada: ${nextName}`);
          });
        },
      },
      {
        label: "Borrar",
        onSelect: async () => {
          await runAction(async () => {
            const nextSnapshot = await deleteSection(section.id);
            setSnapshot(nextSnapshot);
            setSelectedSectionId(null);
            setStatus(`Seccion eliminada: ${section.name}`);
          });
        },
      },
      {
        label: "Ir ahora",
        onSelect: async () => {
          await runAction(async () => {
            const nextSnapshot = await scheduleSectionJump(section.id, "immediate");
            setSnapshot(nextSnapshot);
            setStatus(`Cursor enviado a ${section.name}`);
          });
        },
      },
      {
        label: "Programar salto al final",
        onSelect: async () => {
          await runAction(async () => {
            const nextSnapshot = await scheduleSectionJump(section.id, "section_end");
            setSnapshot(nextSnapshot);
            setStatus(`Salto armado hacia ${section.name}`);
          });
        },
      },
      {
        label: "Programar salto en compases",
        onSelect: async () => {
          const bars = Number(window.prompt("Compases para el salto", "4") ?? "4");
          await runAction(async () => {
            const nextSnapshot = await scheduleSectionJump(section.id, "after_bars", bars);
            setSnapshot(nextSnapshot);
            setStatus(`Salto en compases armado hacia ${section.name}`);
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
          <span className="lt-kicker">LibreTracks Desktop</span>
          <h1>Timeline DAW</h1>
          <p>{song ? `${song.title} | ${song.bpm} BPM | ${song.timeSignature}` : "Sesion vacia"}</p>
        </div>

        <div className="lt-transport">
          <label className="lt-zoom-control">
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
          </label>
          <div className="lt-transport-buttons">
            <button
              type="button"
              onClick={() =>
                void runAction(async () => {
                  const nextSnapshot = await playTransport();
                  setSnapshot(nextSnapshot);
                  setStatus("Reproduccion iniciada.");
                })
              }
            >
              Play
            </button>
            <button
              type="button"
              onClick={() =>
                void runAction(async () => {
                  const nextSnapshot = await pauseTransport();
                  setSnapshot(nextSnapshot);
                  setStatus("Reproduccion pausada.");
                })
              }
            >
              Pause
            </button>
            <button
              type="button"
              onClick={() =>
                void runAction(async () => {
                  const nextSnapshot = await stopTransport();
                  setSnapshot(nextSnapshot);
                  setStatus("Reproduccion detenida.");
                })
              }
            >
              Stop
            </button>
          </div>
          <div className="lt-transport-readout">
            <strong ref={transportReadoutValueRef}>{formatClock(positionSeconds)}</strong>
            <small>{musicalPositionLabel}</small>
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
            onClick={() =>
              void runAction(async () => setSnapshot((await pickAndImportSong()) ?? snapshot), {
                busy: true,
              })
            }
          >
            Importar WAVs
          </button>
        </div>
      </header>

      <section className="lt-main-stage">
        <div className="lt-timeline-topline">
          <div>
            <strong>Vista principal</strong>
            <p>El timeline manda; el resto vive en menus contextuales e interacciones directas.</p>
          </div>
          <div className="lt-timeline-stats">
            <span>{song?.tracks.length ?? 0} tracks</span>
            <span>{song?.clips.length ?? 0} clips</span>
            <span>{song?.sections.length ?? 0} secciones</span>
          </div>
        </div>

        <div
          className={`lt-timeline-shell ${isTimelinePanning ? "is-panning" : ""}`}
          ref={timelineShellRef}
          onMouseDown={beginTimelinePan}
          onWheel={(event) => {
            if (event.ctrlKey || event.metaKey) {
              event.preventDefault();
              applyZoom(zoomLevel + (event.deltaY < 0 ? ZOOM_WHEEL_STEP : -ZOOM_WHEEL_STEP));
              return;
            }

            if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
              event.currentTarget.scrollLeft += event.deltaY;
            }
          }}
        >
          <div
            className="lt-ruler-row"
            style={{ width: timelineRowWidth, gridTemplateColumns: `${HEADER_WIDTH}px ${timelineWidth}px` }}
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
              <div className="lt-ruler-content" style={{ width: timelineWidth }}>
                {rulerMarks.map((mark) => (
                  <div
                    key={mark}
                    className="lt-ruler-mark"
                    style={{ left: `${(mark / Math.max(1, song?.durationSeconds ?? 1)) * timelineWidth}px` }}
                  >
                    <span>{formatCompactTime(mark)}</span>
                  </div>
                ))}

                {song?.sections.map((section) => (
                  <button
                    key={section.id}
                    type="button"
                    className={`lt-section-tag ${selectedSectionId === section.id ? "is-selected" : ""}`}
                    style={{
                      left: `${(section.startSeconds / Math.max(1, song.durationSeconds)) * timelineWidth}px`,
                      width: `${((section.endSeconds - section.startSeconds) /
                        Math.max(1, song.durationSeconds)) * timelineWidth}px`,
                    }}
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
                ))}

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

          <div className="lt-track-list" ref={laneAreaRef}>
            {song && visibleTracks.length === 0 ? (
              <div className="lt-empty-state">
                <strong>No hay tracks cargados</strong>
                <p>Crea un proyecto o importa WAVs para empezar a editar la sesion.</p>
              </div>
            ) : null}

            {song?.tracks && visibleTracks.map((track) => {
              const trackClips = clipsByTrack[track.id] ?? [];
              const isTrackSelected = selectedTrackId === track.id;
              const childCount = trackChildrenCount(song, track.id);
              const isDropTarget = trackDropState?.targetTrackId === track.id;
              const dropMode = isDropTarget ? trackDropState?.mode : null;

              return (
                <div
                  key={track.id}
                  className={`lt-track-row ${isDropTarget ? `is-drop-target is-drop-${dropMode}` : ""}`}
                  data-track-id={track.id}
                  style={{ width: timelineRowWidth, gridTemplateColumns: `${HEADER_WIDTH}px ${timelineWidth}px` }}
                >
                  <div
                    className={`lt-track-header ${isTrackSelected ? "is-selected" : ""} ${track.kind === "folder" ? "is-folder" : ""} ${isDropTarget ? "is-drop-target" : ""} ${draggingTrackId === track.id ? "is-dragging" : ""}`}
                    style={{ paddingLeft: 16 + track.depth * 22 }}
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

                  <div className={`lt-track-lane ${track.kind === "folder" ? "is-folder" : ""}`}>
                    <div className="lt-track-lane-grid" style={{ width: timelineWidth }}>
                      {rulerMarks.map((mark) => (
                        <div
                          key={`${track.id}-${mark}`}
                          className="lt-lane-grid-line"
                          style={{
                            left: `${(mark / Math.max(1, song.durationSeconds)) * timelineWidth}px`,
                          }}
                        />
                      ))}

                      {track.kind === "folder" ? (
                        <div className="lt-folder-lane-fill">
                          <span>{childCount ? `${childCount} tracks dentro del folder` : "Folder track"}</span>
                        </div>
                      ) : null}

                      {trackClips.map((clip) => {
                        const previewStart =
                          clipDrag?.clipId === clip.id ? clipDrag.previewSeconds : clip.timelineStartSeconds;
                        const left = (previewStart / Math.max(1, song.durationSeconds)) * timelineWidth;
                        const width =
                          (clip.durationSeconds / Math.max(1, song.durationSeconds)) * timelineWidth;

                        return (
                          <button
                            key={clip.id}
                            type="button"
                            className={`lt-clip ${selectedClipId === clip.id ? "is-selected" : ""}`}
                            aria-label={`Clip ${clip.trackName}`}
                            style={{ left, width: Math.max(width, 28) }}
                            onMouseDown={(event) => {
                              if (event.button !== 0) {
                                return;
                              }

                              setSelectedClipId(clip.id);
                              setSelectedTrackId(track.id);
                              setSelectedSectionId(null);
                              setContextMenu(null);
                              setClipDrag({
                                clipId: clip.id,
                                pointerId: 1,
                                originSeconds: clip.timelineStartSeconds,
                                previewSeconds: clip.timelineStartSeconds,
                                startClientX: event.clientX,
                              });
                            }}
                            onContextMenu={(event) => {
                              setSelectedClipId(clip.id);
                              openMenu(event, clip.trackName, clipContextMenu(clip));
                            }}
                          >
                            <span className="lt-clip-name">{clip.trackName}</span>
                            <svg
                              className="lt-waveform"
                              viewBox="0 0 100 100"
                              preserveAspectRatio="none"
                              aria-hidden="true"
                            >
                              <path d={clipWaveformPaths[clip.id] ?? ""} />
                              <line x1="0" y1="50" x2="100" y2="50" />
                            </svg>
                          </button>
                        );
                      })}

                      <div
                        className="lt-playhead"
                        style={draggedPlayheadOffset === null ? undefined : { left: draggedPlayheadOffset }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
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
                  const nextSnapshot = await createSection(
                    currentSelection.startSeconds,
                    currentSelection.endSeconds,
                  );
                  setSnapshot(nextSnapshot);
                  setTimeSelection(null);
                  setStatus("Seccion creada desde la seleccion temporal.");
                })
              }
            >
              Crear seccion
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
          <label className="lt-zoom-control">
            <span>Zoom</span>
            <input
              aria-label="Zoom horizontal del timeline"
              type="range"
              min={effectiveZoomMin}
              max={ZOOM_MAX}
              step={ZOOM_STEP}
              value={zoomLevel}
              onChange={(event) => applyZoom(Number(event.target.value))}
            />
            <strong>{zoomLevel.toFixed(1)}x</strong>
          </label>
          <button type="button" className={snapEnabled ? "is-active" : ""} onClick={() => setSnapEnabled((current) => !current)}>
            Snap beat
          </button>
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
      </div>
    </Profiler>
  );
}

function snapToBeat(seconds: number, bpm: number) {
  if (bpm <= 0) {
    return seconds;
  }

  const beatSeconds = 60 / bpm;
  return Math.round(seconds / beatSeconds) * beatSeconds;
}
