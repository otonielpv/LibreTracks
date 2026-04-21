import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  cancelSectionJump,
  createSection,
  createSong,
  createTrack,
  deleteClip,
  deleteSection,
  deleteTrack,
  duplicateClip,
  getTransportSnapshot,
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
  updateTrack,
  type ClipSummary,
  type SectionSummary,
  type SongSummary,
  type TrackKind,
  type TrackSummary,
  type TransportSnapshot,
} from "./desktopApi";

const HEADER_WIDTH = 260;
const DEFAULT_TIMELINE_VIEWPORT_WIDTH = 1100;
const TRACK_HEIGHT = 94;
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 48;
const ZOOM_STEP = 0.25;

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

function cropWaveform(clip: ClipSummary) {
  const peaks = clip.waveformMaxPeaks;
  const minPeaks = clip.waveformMinPeaks.length ? clip.waveformMinPeaks : peaks.map((peak) => -peak);
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

function buildWaveformPath(clip: ClipSummary) {
  const { min, max } = cropWaveform(clip);
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

function buildVisibleTracks(song: SongSummary, collapsedFolders: Set<string>) {
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

function findPreviousFolderTrack(song: SongSummary, trackId: string) {
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

function findTrack(song: SongSummary | null, trackId: string | null) {
  if (!song || !trackId) {
    return null;
  }

  return song.tracks.find((track) => track.id === trackId) ?? null;
}

function findClip(song: SongSummary | null, clipId: string | null) {
  if (!song || !clipId) {
    return null;
  }

  return song.clips.find((clip) => clip.id === clipId) ?? null;
}

function findSection(song: SongSummary | null, sectionId: string | null) {
  if (!song || !sectionId) {
    return null;
  }

  return song.sections.find((section) => section.id === sectionId) ?? null;
}

function trackChildrenCount(song: SongSummary, trackId: string) {
  return song.tracks.filter((track) => track.parentTrackId === trackId).length;
}

function isTrackDescendant(song: SongSummary, candidateTrackId: string | null, trackId: string) {
  let cursor = candidateTrackId;

  while (cursor) {
    if (cursor === trackId) {
      return true;
    }

    cursor = findTrack(song, cursor)?.parentTrackId ?? null;
  }

  return false;
}

function isInteractiveTrackControl(target: EventTarget | null) {
  return target instanceof HTMLElement
    ? Boolean(target.closest("button, input, select, textarea, label"))
    : false;
}

function resolveTrackDropState(
  song: SongSummary,
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
  const [status, setStatus] = useState("Cargando sesion...");
  const [isBusy, setIsBusy] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(7);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [clipDrag, setClipDrag] = useState<ClipDragState>(null);
  const [rulerDrag, setRulerDrag] = useState<RulerDragState>(null);
  const [timeSelection, setTimeSelection] = useState<TimeSelection>(null);
  const [isTimelinePanning, setIsTimelinePanning] = useState(false);
  const [displayPositionSeconds, setDisplayPositionSeconds] = useState(0);
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(DEFAULT_TIMELINE_VIEWPORT_WIDTH);
  const [trackDrag, setTrackDrag] = useState<TrackDragState>(null);
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
  const pendingZoomAnchorRef = useRef<{ seconds: number; viewOffsetX: number } | null>(null);
  const suppressTrackClickRef = useRef(false);

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
    const songDurationSeconds = snapshot?.song?.durationSeconds ?? 0;
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
      setDisplayPositionSeconds(snapshot?.positionSeconds ?? 0);
    }
  }, [
    snapshot?.playbackState,
    snapshot?.positionSeconds,
    snapshot?.song?.durationSeconds,
    snapshot?.transportClock?.anchorPositionSeconds,
    snapshot?.transportClock?.running,
  ]);

  useEffect(() => {
    if (snapshot?.playbackState !== "playing") {
      return;
    }

    let animationFrameId = 0;

    const tick = () => {
      const anchor = playbackVisualAnchorRef.current;
      const elapsedSeconds = anchor.running
        ? (performance.now() - anchor.anchorReceivedAtMs) / 1000
        : 0;
      const nextPositionSeconds = Math.min(
        anchor.durationSeconds || Number.MAX_SAFE_INTEGER,
        anchor.anchorPositionSeconds + elapsedSeconds,
      );

      setDisplayPositionSeconds(nextPositionSeconds);
      animationFrameId = window.requestAnimationFrame(tick);
    };

    animationFrameId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [snapshot?.playbackState]);

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    window.addEventListener("click", closeMenu);
    window.addEventListener("blur", closeMenu);

    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("blur", closeMenu);
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
    if (!clipDrag || !snapshot?.song || !laneAreaRef.current) {
      return;
    }

    const effectSong = snapshot.song;

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
        const clip = findClip(nextSnapshot.song ?? null, activeDrag.clipId);
        setStatus(`Clip movido: ${clip?.trackName ?? activeDrag.clipId}`);
      });
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [clipDrag, snapEnabled, snapshot?.song, zoomLevel]);

  useEffect(() => {
    if (!rulerDrag || !snapshot?.song || !rulerTrackRef.current) {
      return;
    }

    const onMouseMove = (event: MouseEvent) => {
      const nextSeconds = rulerPointerToSeconds(
        event,
        rulerTrackRef.current as HTMLElement,
        snapshot.song?.durationSeconds ?? 0,
        zoomLevel * 18,
      );
      setRulerDrag((current) => (current ? { ...current, currentSeconds: nextSeconds } : current));
    };

    const onMouseUp = async (event: MouseEvent) => {
      if (event.button !== 0) {
        return;
      }

      const activeDrag = rulerDrag;
      setRulerDrag(null);
      if (!activeDrag) {
        return;
      }

      const normalized = normalizeSelection({
        startSeconds: activeDrag.startSeconds,
        endSeconds: activeDrag.currentSeconds,
      });

      if (!normalized || normalized.endSeconds - normalized.startSeconds < 0.15) {
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
  }, [rulerDrag, snapshot?.song, zoomLevel]);

  useEffect(() => {
    if (!trackDrag || !snapshot?.song) {
      return;
    }

    const effectSong = snapshot.song;

    const onMouseMove = (event: MouseEvent) => {
      const exceededThreshold =
        Math.abs(event.clientX - trackDrag.startClientX) > 5 ||
        Math.abs(event.clientY - trackDrag.startClientY) > 5;
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
        Math.abs(event.clientX - trackDrag.startClientX) > 5 ||
        Math.abs(event.clientY - trackDrag.startClientY) > 5;
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
  }, [snapshot?.song, trackDrag]);

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

  const song = snapshot?.song ?? null;
  const laneViewportWidth = Math.max(320, timelineViewportWidth - HEADER_WIDTH);
  const fitAllZoomLevel = song?.durationSeconds
    ? clamp(laneViewportWidth / (Math.max(song.durationSeconds, 1) * 18), ZOOM_MIN, ZOOM_MAX)
    : ZOOM_MIN;
  const effectiveZoomMin = song ? fitAllZoomLevel : ZOOM_MIN;
  const positionSeconds = displayPositionSeconds;
  const pixelsPerSecond = zoomLevel * 18;
  const timelineWidth = Math.max((song?.durationSeconds ?? 0) * pixelsPerSecond, laneViewportWidth);
  const timelineRowWidth = HEADER_WIDTH + timelineWidth;
  const visibleTracks = song ? buildVisibleTracks(song, collapsedFolders) : [];
  const selectedTrack = findTrack(song, selectedTrackId);
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
  const playheadOffset = (positionSeconds / Math.max(1, song?.durationSeconds ?? 1)) * timelineWidth;
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

  function clearSelections(message: string) {
    setSelectedTrackId(null);
    setSelectedClipId(null);
    setSelectedSectionId(null);
    setTimeSelection(null);
    setContextMenu(null);
    setStatus(message);
  }

  function beginTimelinePan(event: ReactMouseEvent) {
    if (!timelineShellRef.current || event.button !== 1) {
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

  function applyZoom(nextZoomLevel: number, anchorClientX?: number) {
    const shell = timelineShellRef.current;
    const clampedZoom = clamp(nextZoomLevel, effectiveZoomMin, ZOOM_MAX);

    if (!shell) {
      setZoomLevel(clampedZoom);
      return;
    }

    const bounds = shell.getBoundingClientRect();
    const viewOffsetX =
      anchorClientX !== undefined ? anchorClientX - bounds.left : bounds.width / 2;
    const laneOffsetX = clamp(viewOffsetX - HEADER_WIDTH, 0, Math.max(0, bounds.width - HEADER_WIDTH));
    const anchorSeconds = (shell.scrollLeft + laneOffsetX) / Math.max(pixelsPerSecond, 0.0001);

    pendingZoomAnchorRef.current = {
      seconds: anchorSeconds,
      viewOffsetX,
    };
    setZoomLevel(clampedZoom);
  }

  async function handleTrackDrop(trackId: string, dropState: NonNullable<TrackDropState>) {
    const targetTrack = findTrack(song, dropState.targetTrackId);
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
    const canSplit =
      displayPositionSeconds > clip.timelineStartSeconds &&
      displayPositionSeconds < clip.timelineStartSeconds + clip.durationSeconds;

    return [
      {
        label: "Cortar en cursor",
        disabled: !canSplit,
        onSelect: async () => {
          await runAction(async () => {
            const nextSnapshot = await splitClip(clip.id, displayPositionSeconds);
            setSnapshot(nextSnapshot);
            setStatus(`Clip cortado en ${formatClock(displayPositionSeconds)}`);
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

  return (
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
            <strong>{formatClock(positionSeconds)}</strong>
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
              applyZoom(
                zoomLevel + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP),
                event.clientX,
              );
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

                const startSeconds = rulerPointerToSeconds(
                  event,
                  rulerTrackRef.current,
                  song.durationSeconds,
                  pixelsPerSecond,
                );
                setSelectedSectionId(null);
                setContextMenu(null);
                setRulerDrag({
                  pointerId: 1,
                  startSeconds,
                  currentSeconds: startSeconds,
                });
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
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedSectionId(section.id);
                      setSelectedClipId(null);
                      setSelectedTrackId(null);
                      setStatus(`Seccion seleccionada: ${section.name}`);
                    }}
                    onContextMenu={(event) => {
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

                <div className="lt-playhead" style={{ left: playheadOffset }} />
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
              const trackClips = song.clips.filter((clip) => clip.trackId === track.id);
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
                    onMouseDown={(event) => {
                      if (event.button !== 0 || isInteractiveTrackControl(event.target)) {
                        return;
                      }

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
                          value={track.volume}
                          onChange={(event) => {
                            void runAction(async () => {
                              const nextSnapshot = await updateTrack({
                                trackId: track.id,
                                volume: Number(event.target.value),
                              });
                              setSnapshot(nextSnapshot);
                            });
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
                              <path d={buildWaveformPath(clip)} />
                              <line x1="0" y1="50" x2="100" y2="50" />
                            </svg>
                          </button>
                        );
                      })}

                      <div className="lt-playhead" style={{ left: playheadOffset }} />
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
  );
}

function snapToBeat(seconds: number, bpm: number) {
  if (bpm <= 0) {
    return seconds;
  }

  const beatSeconds = 60 / bpm;
  return Math.round(seconds / beatSeconds) * beatSeconds;
}
