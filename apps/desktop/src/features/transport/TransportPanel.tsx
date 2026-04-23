import {
  Profiler,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  assignSectionMarkerDigit,
  cancelMarkerJump,
  createSectionMarker,
  createClipsBatch,
  createSong,
  createTrack,
  deleteClip,
  deleteSectionMarker,
  deleteTrack,
  duplicateClip,
  deleteLibraryAsset,
  getLibraryAssets,
  getLibraryWaveformSummaries,
  getSongView,
  getTransportSnapshot,
  getWaveformSummaries,
  importLibraryAssetsFromDialog,
  isTauriApp,
  listenToLibraryImportProgress,
  listenToAudioMeters,
  listenToTransportLifecycle,
  listenToWaveformReady,
  moveClip,
  moveClipLive,
  moveTrack,
  openProject,
  pauseTransport,
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
  type LibraryAssetSummary,
  type LibraryImportProgressEvent,
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
import { LibrarySidebarPanel } from "./LibrarySidebarPanel";
import { PlayheadOverlay } from "./PlayheadOverlay";
import { snapToTimelineGrid, useTimelineGrid } from "./useTimelineGrid";
import {
  BASE_PIXELS_PER_SECOND,
  clampCameraX,
  clientXToTimelineSeconds,
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
const INSTANT_WAVEFORM_BUCKET_COUNT = 96;

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
  clickSeekSeconds: number;
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
  previewSeconds: number;
  hasMoved: boolean;
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

type SidebarTab = "markers" | "library" | "routing" | "settings";

const LIBRARY_ASSET_DRAG_MIME = "application/libretracks-library-assets";
const LIBRARY_DRAG_EDGE_BUFFER_PX = 50;
const LIBRARY_DRAG_MAX_SCROLL_SPEED_PX = 22;

type LibraryAssetDragPayload = {
  file_path: string;
  durationSeconds: number;
};

type LibraryDropLayout = "horizontal" | "vertical";

type LibraryClipPreviewState = {
  trackId: string | null;
  filePath: string;
  label: string;
  timelineStartSeconds: number;
  durationSeconds: number;
  rowOffset: number;
};

type LibraryDragHoverState = {
  clientX: number;
  clientY: number;
  ctrlKey: boolean;
  metaKey: boolean;
  payload: LibraryAssetDragPayload[];
  targetTrackId: string | null;
};

type LibraryDragAutoScrollState = {
  frameId: number | null;
  horizontalVelocity: number;
  verticalVelocity: number;
};

type OptimisticClipOperation = {
  id: string;
  clearAfterProjectRevision: number | null;
  clips: ClipSummary[];
};

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

function libraryAssetFileName(filePath: string) {
  return filePath.split("/").at(-1) ?? filePath;
}

function humanizeLibraryTrackName(filePath: string) {
  return libraryAssetFileName(filePath)
    .replace(/\.[^.]+$/, "")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ") || "Audio";
}

function readLibraryAssetDragPayload(dataTransfer: DataTransfer | null): LibraryAssetDragPayload[] | null {
  if (!dataTransfer) {
    return null;
  }

  const payload = dataTransfer.getData(LIBRARY_ASSET_DRAG_MIME).trim();
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as Partial<LibraryAssetDragPayload> | Array<Partial<LibraryAssetDragPayload>>;
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const normalizedPayload = items.flatMap((item) => {
      if (
        typeof item.file_path !== "string" ||
        !item.file_path ||
        typeof item.durationSeconds !== "number" ||
        !Number.isFinite(item.durationSeconds)
      ) {
        return [];
      }

      return [{
        file_path: item.file_path,
        durationSeconds: Math.max(0.05, item.durationSeconds),
      }];
    });

    if (!normalizedPayload.length) {
      return null;
    }

    return normalizedPayload;
  } catch {
    return null;
  }
}

function hasLibraryAssetDragType(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) {
    return false;
  }

  const dragTypes = Array.from(dataTransfer.types ?? []);
  return dragTypes.includes(LIBRARY_ASSET_DRAG_MIME) || dragTypes.includes("text/plain");
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

function hashWaveformPreviewSeed(value: string) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function buildInstantWaveformPreview(
  waveformKey: string,
  durationSeconds: number,
): WaveformSummaryDto {
  const bucketCount = Math.max(32, Math.round(INSTANT_WAVEFORM_BUCKET_COUNT));
  const minPeaks: number[] = [];
  const maxPeaks: number[] = [];
  let state = hashWaveformPreviewSeed(`${waveformKey}:${durationSeconds.toFixed(3)}`) || 1;
  const cadence = 3 + (state % 5);
  const accentStride = 5 + (state % 7);

  for (let index = 0; index < bucketCount; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const normalizedIndex = index / Math.max(1, bucketCount - 1);
    const envelope = 0.2 + Math.sin(normalizedIndex * Math.PI) * 0.2;
    const phrase = 0.16 + Math.abs(Math.sin(normalizedIndex * Math.PI * cadence)) * 0.26;
    const accent = index % accentStride === 0 ? 0.12 : 0;
    const jitter = ((state >>> 8) & 0xffff) / 0xffff;
    const maxPeak = clamp(envelope + phrase + accent + jitter * 0.16, 0.12, 0.92);
    const symmetry = 0.68 + (((state >>> 24) & 0xff) / 0xff) * 0.24;
    maxPeaks.push(maxPeak);
    minPeaks.push(-maxPeak * symmetry);
  }

  return {
    waveformKey,
    version: 0,
    durationSeconds,
    bucketCount,
    minPeaks,
    maxPeaks,
    isPreview: true,
  };
}

function keyboardDigit(eventCode: string) {
  const match = eventCode.match(/^(?:Digit|Numpad)(\d)$/);
  if (match) {
    return Number(match[1]);
  }

  return null;
}

function isTextEntryTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable || target.tagName === "TEXTAREA") {
    return true;
  }

  if (target.tagName !== "INPUT") {
    return false;
  }

  const textEntryTypes = new Set([
    "",
    "email",
    "password",
    "search",
    "tel",
    "text",
    "url",
  ]);

  return textEntryTypes.has((target as HTMLInputElement).type.toLowerCase());
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

function isSameClipPlacement(left: ClipSummary, right: ClipSummary) {
  return (
    left.trackId === right.trackId &&
    left.filePath === right.filePath &&
    Math.abs(left.timelineStartSeconds - right.timelineStartSeconds) < 0.0001 &&
    Math.abs(left.sourceStartSeconds - right.sourceStartSeconds) < 0.0001 &&
    Math.abs(left.durationSeconds - right.durationSeconds) < 0.0001
  );
}

function mergeOptimisticClipsByTrack(
  clipsByTrack: Record<string, ClipSummary[]>,
  operations: OptimisticClipOperation[],
) {
  if (!operations.length) {
    return clipsByTrack;
  }

  const nextClipsByTrack: Record<string, ClipSummary[]> = Object.fromEntries(
    Object.entries(clipsByTrack).map(([trackId, clips]) => [trackId, [...clips]]),
  );

  for (const operation of operations) {
    for (const clip of operation.clips) {
      const currentTrackClips = nextClipsByTrack[clip.trackId] ?? [];
      if (currentTrackClips.some((currentClip) => isSameClipPlacement(currentClip, clip))) {
        continue;
      }

      nextClipsByTrack[clip.trackId] = [...currentTrackClips, clip].sort(
        (left, right) => left.timelineStartSeconds - right.timelineStartSeconds,
      );
    }
  }

  return nextClipsByTrack;
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
  scrollContainerElement: HTMLElement | null,
  durationSeconds: number,
  pixelsPerSecond: number,
) {
  return clamp(
    clientXToTimelineSeconds(
      event.clientX,
      element,
      scrollContainerElement,
      pixelsPerSecond,
    ),
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
  const [activeSidebarTab, setActiveSidebarTab] = useState<SidebarTab | null>(null);
  const [libraryAssets, setLibraryAssets] = useState<LibraryAssetSummary[]>([]);
  const [libraryClipPreview, setLibraryClipPreview] = useState<LibraryClipPreviewState[]>([]);
  const [optimisticClipOperations, setOptimisticClipOperations] = useState<OptimisticClipOperation[]>([]);
  const [isLibraryLoading, setIsLibraryLoading] = useState(false);
  const [isImportingLibrary, setIsImportingLibrary] = useState(false);
  const [libraryImportProgress, setLibraryImportProgress] = useState<LibraryImportProgressEvent | null>(null);
  const [deletingLibraryFilePath, setDeletingLibraryFilePath] = useState<string | null>(null);
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(DEFAULT_TIMELINE_VIEWPORT_WIDTH);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const menuBarRef = useRef<HTMLDivElement | null>(null);
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
  const libraryDragHoverRef = useRef<LibraryDragHoverState | null>(null);
  const activeLibraryDragPayloadRef = useRef<LibraryAssetDragPayload[] | null>(null);
  const libraryDragAutoScrollRef = useRef<LibraryDragAutoScrollState>({
    frameId: null,
    horizontalVelocity: 0,
    verticalVelocity: 0,
  });
  const playbackState = useTransportStore((state) => state.playback?.playbackState ?? "empty");
  const playbackProjectRevision = useTransportStore((state) => state.playback?.projectRevision ?? 0);
  const playbackSongDir = useTransportStore((state) => state.playback?.songDir ?? null);
  const projectIdentityRef = useRef<string | null>(null);
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

  const completeOptimisticClipOperation = useCallback((operationId: string, projectRevision: number) => {
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
  }, []);

  const discardOptimisticClipOperation = useCallback((operationId: string) => {
    setOptimisticClipOperations((current) => current.filter((operation) => operation.id !== operationId));
  }, []);

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
    if (!isTauriApp) {
      return () => {};
    }

    let active = true;
    let unlisten: (() => void) | undefined;

    void listenToWaveformReady((event) => {
      if (!active) {
        return;
      }

      if (playbackSongDir && event.songDir !== playbackSongDir.replace(/\\/g, "/")) {
        return;
      }

      setWaveformCache((current) => ({
        ...current,
        [event.waveformKey]: event.summary,
      }));
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
  }, [playbackSongDir]);

  useEffect(() => {
    if (!isTauriApp) {
      return () => {};
    }

    let active = true;
    let unlisten: (() => void) | undefined;

    void listenToLibraryImportProgress((event) => {
      if (!active) {
        return;
      }

      setLibraryImportProgress(event);
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
    const nextProjectIdentity = playbackSongDir ? `${playbackSongDir}::${song?.id ?? "pending"}` : null;
    const previousProjectIdentity = projectIdentityRef.current;

    if (previousProjectIdentity !== null && previousProjectIdentity !== nextProjectIdentity) {
      setWaveformCache({});
      setLibraryAssets([]);
      setLibraryClipPreview([]);
      setOptimisticClipOperations([]);
      clearActiveLibraryDragPayload();
    }

    projectIdentityRef.current = nextProjectIdentity;
  }, [playbackSongDir, song?.id]);

  useEffect(() => {
    let active = true;

    async function loadLibraryAssets() {
      if (!playbackSongDir) {
        setLibraryAssets([]);
        setLibraryClipPreview([]);
        return;
      }

      setLibraryAssets([]);
      setLibraryClipPreview([]);
      setIsLibraryLoading(true);
      try {
        const assets = await getLibraryAssets();
        if (!active) {
          return;
        }

        setLibraryAssets(assets);
      } catch (error) {
        if (active) {
          setStatus(`Error: ${String(error)}`);
        }
      } finally {
        if (active) {
          setIsLibraryLoading(false);
        }
      }
    }

    void loadLibraryAssets();

    return () => {
      active = false;
    };
  }, [playbackSongDir, song?.id]);

  useEffect(() => {
    let active = true;

    async function warmLibraryWaveforms() {
      if (!playbackSongDir || !libraryAssets.length) {
        return;
      }

      const missingWaveformKeys = libraryAssets
        .map((asset) => asset.filePath)
        .filter((waveformKey, index, keys) => keys.indexOf(waveformKey) === index)
        .filter((waveformKey) => {
          const summary = waveformCache[waveformKey];
          return !summary || summary.isPreview;
        });

      if (!missingWaveformKeys.length) {
        return;
      }

      const summaries = await getLibraryWaveformSummaries(missingWaveformKeys);
      if (!active || !summaries.length) {
        return;
      }

      setWaveformCache((current) => ({
        ...current,
        ...Object.fromEntries(summaries.map((summary) => [summary.waveformKey, summary])),
      }));
    }

    void warmLibraryWaveforms();

    return () => {
      active = false;
    };
  }, [libraryAssets, playbackSongDir, waveformCache]);

  useEffect(() => {
    if (!song) {
      setWaveformCache({});
    }
    // Mantenemos la caché viva entre revisiones del mismo proyecto.
    // Solo se limpia si cerramos la canción (!song) o cambiamos de proyecto.
  }, [song?.id]);

  useEffect(() => {
    if (!song) {
      setOptimisticClipOperations([]);
      return;
    }

    setOptimisticClipOperations((current) =>
      current.filter((operation) => {
        if (operation.clearAfterProjectRevision === null) {
          return true;
        }

        return operation.clearAfterProjectRevision > song.projectRevision;
      }),
    );
  }, [song?.id, song?.projectRevision]);

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
        .filter((waveformKey) => {
          const summary = waveformCache[waveformKey];
          return !summary || summary.isPreview;
        });

      if (!missingWaveformKeys.length) {
        return;
      }

      const summaries = await getWaveformSummaries(missingWaveformKeys);
      if (!active) {
        return;
      }
      if (!summaries.length) {
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
      if (event.code === "Space") {
        if (isTextEntryTarget(event.target)) {
          return;
        }

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

      const target = event.target as HTMLElement | null;
      const isTypingTarget =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable;

      if (isTypingTarget) {
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
        if (!clipDrag.hasMoved && exceededThreshold) {
          restoreConfirmedTransportVisual();
        }
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
          void runAction(async () => {
            await performSeek(activeClipDrag.clickSeekSeconds);
          });
        }
      } else {
        clipPreviewSecondsRef.current = {};
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

    displayPositionSecondsRef.current = clampedPosition;

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

  function normalizeTimelineSeekSeconds(positionSeconds: number, durationSeconds = song?.durationSeconds ?? 0) {
    const clampedPosition = clamp(positionSeconds, 0, Math.max(0, durationSeconds));

    return snapEnabled
      ? clamp(
          snapToTimelineGrid(
            clampedPosition,
            song?.bpm ?? 120,
            song?.timeSignature ?? "4/4",
            zoomLevel,
            pixelsPerSecond,
          ),
          0,
          Math.max(0, durationSeconds),
        )
      : clampedPosition;
  }

  function getTimelineScrollContainer() {
    return timelineShellRef.current ?? horizontalScrollbarRef.current;
  }

  function snappedRulerSeconds(event: MouseEvent | ReactMouseEvent, durationSeconds: number) {
    return normalizeTimelineSeekSeconds(
      rulerPointerToSeconds(
        event,
        rulerTrackRef.current as HTMLElement,
        getTimelineScrollContainer(),
        durationSeconds,
        pixelsPerSecond,
      ),
      durationSeconds,
    );
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
  const renderedClipsByTrack = useMemo(
    () => mergeOptimisticClipsByTrack(clipsByTrack, optimisticClipOperations),
    [clipsByTrack, optimisticClipOperations],
  );
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
  const shouldShowEmptyState = !isProjectPending && !song;
  const timelineRowWidth = HEADER_WIDTH + laneViewportWidth;
  const visibleTracks = song ? buildVisibleTracks(song, collapsedFolders) : [];
  const shouldShowEmptyArrangementHint = Boolean(song && visibleTracks.length === 0);
  const previewTrackDensityClass =
    trackHeight <= 76 ? "is-compact" : trackHeight <= 88 ? "is-condensed" : "";
  const libraryPreviewRows = useMemo(() => {
    const rows = new Map<number, LibraryClipPreviewState[]>();

    for (const preview of libraryClipPreview) {
      if (preview.trackId !== null) {
        continue;
      }

      const currentRow = rows.get(preview.rowOffset);
      if (currentRow) {
        currentRow.push(preview);
        continue;
      }

      rows.set(preview.rowOffset, [preview]);
    }

    return [...rows.entries()]
      .sort(([leftOffset], [rightOffset]) => leftOffset - rightOffset)
      .map(([rowOffset, previews]) => ({
        rowOffset,
        previews,
        title:
          previews.length === 1
            ? humanizeLibraryTrackName(previews[0].filePath)
            : "New track",
        meta:
          previews.length === 1
            ? "Drop to create track"
            : `${previews.length} clips on new track`,
      }));
  }, [libraryClipPreview]);
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

  function globalTrackListContextMenu() {
    return [
      {
        label: "Add audio track",
        onSelect: () => handleCreateTrack("audio", null, null),
      },
      {
        label: "Add folder track",
        onSelect: () => handleCreateTrack("folder", null, null),
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
      const clickSeekSeconds = normalizeTimelineSeekSeconds(
        rulerPointerToSeconds(
          event,
          event.currentTarget,
          getTimelineScrollContainer(),
          songRef.current?.durationSeconds ?? 0,
          pixelsPerSecond,
        ),
        songRef.current?.durationSeconds ?? 0,
      );
      previewSeek(clickSeekSeconds);
      setSelectedClipId(hitClip.id);
      setSelectedTrackId(track.id);
      setSelectedSectionId(null);
      setContextMenu(null);
      clipDragRef.current = {
        clipId: hitClip.id,
        pointerId: 1,
        originSeconds: hitClip.timelineStartSeconds,
        previewSeconds: hitClip.timelineStartSeconds,
        clickSeekSeconds,
        startClientX: event.clientX,
        hasMoved: false,
      };
      clipPreviewSecondsRef.current = { [hitClip.id]: hitClip.timelineStartSeconds };
      return;
    }

    event.preventDefault();
    setContextMenu(null);
    const previewSeconds = normalizeTimelineSeekSeconds(
      rulerPointerToSeconds(
        event,
        event.currentTarget,
        getTimelineScrollContainer(),
        songRef.current?.durationSeconds ?? 0,
        pixelsPerSecond,
      ),
      songRef.current?.durationSeconds ?? 0,
    );
    previewSeek(previewSeconds);

    const activePan: NonNullable<TimelinePanState> = {
      pointerId: 1,
      startClientX: event.clientX,
      originCameraX: getCameraX(),
      previewSeconds,
      hasMoved: false,
    };
    timelinePanRef.current = activePan;

    const onMouseMove = (windowEvent: MouseEvent) => {
      const deltaX = activePan.startClientX - windowEvent.clientX;
      const exceededThreshold = Math.abs(deltaX) > DRAG_THRESHOLD_PX;
      if (!activePan.hasMoved && !exceededThreshold) {
        return;
      }

      if (!activePan.hasMoved) {
        activePan.hasMoved = true;
        restoreConfirmedTransportVisual();
      }

      updateCameraX(activePan.originCameraX + deltaX);
    };

    const onMouseUp = (windowEvent: MouseEvent) => {
      if (windowEvent.button !== 0) {
        return;
      }

      timelinePanRef.current = null;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);

      if (!activePan.hasMoved) {
        void runAction(async () => {
          await performSeek(activePan.previewSeconds);
        });
      }
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

  function handleTrackListContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    if (!songRef.current) {
      return;
    }

    const target = event.target as HTMLElement | null;
    if (target?.closest(".lt-track-row")) {
      return;
    }

    setSelectedClipId(null);
    setSelectedTrackId(null);
    setSelectedSectionId(null);
    openMenu(event, "Tracks", globalTrackListContextMenu());
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

  function handleCreateSongClick() {
    void runAction(
      async () => {
        const nextSnapshot = await createSong();
        if (!nextSnapshot) {
          return;
        }

        applyPlaybackSnapshot(nextSnapshot);
        setActiveSidebarTab(null);
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
    void runAction(
      async () => {
        const nextSnapshot = (await openProject()) ?? snapshotRef.current;
        applyPlaybackSnapshot(nextSnapshot);
        setActiveSidebarTab(null);
      },
      { busy: true },
    );
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

  function handleSidebarTabToggle(tab: SidebarTab) {
    setActiveSidebarTab((currentTab) => (currentTab === tab ? null : tab));
  }

  async function handleImportLibraryAssetsClick() {
    if (!playbackSongDir) {
      setStatus("Crea o abre una sesion antes de importar audio a la libreria.");
      return;
    }

    setIsImportingLibrary(true);
    setLibraryImportProgress(null);
    await runAction(async () => {
      const assets = await importLibraryAssetsFromDialog();
      if (!assets) {
        setLibraryImportProgress(null);
        return;
      }

      setLibraryAssets(assets);
      setStatus(`Libreria actualizada con ${assets.length} assets.`);
    });
    setIsImportingLibrary(false);
    setLibraryImportProgress(null);
  }

  async function handleDeleteLibraryAsset(filePath: string, fileName: string) {
    if (!window.confirm(`Delete ${fileName} from this song library?`)) {
      return;
    }

    setDeletingLibraryFilePath(filePath);
    try {
      await runAction(async () => {
        const assets = await deleteLibraryAsset(filePath);
        setLibraryAssets(assets);
        setLibraryClipPreview((current) => current.filter((preview) => preview.filePath !== filePath));
        setStatus(`Asset eliminado: ${fileName}`);
      });
    } finally {
      setDeletingLibraryFilePath((current) => (current === filePath ? null : current));
    }
  }

  function resolveDraggedLibraryAsset(filePath: string, durationSeconds: number): LibraryAssetSummary {
    return (
      libraryAssets.find((asset) => asset.filePath === filePath) ?? {
        fileName: libraryAssetFileName(filePath),
        filePath,
        durationSeconds,
        detectedBpm: null,
      }
    );
  }

  function resolveLibraryDragPayload(dataTransfer: DataTransfer | null) {
    const payload = readLibraryAssetDragPayload(dataTransfer);
    if (payload?.length) {
      activeLibraryDragPayloadRef.current = payload;
      return payload;
    }

    if (activeLibraryDragPayloadRef.current?.length) {
      return activeLibraryDragPayloadRef.current;
    }

    if (hasLibraryAssetDragType(dataTransfer)) {
      return activeLibraryDragPayloadRef.current;
    }

    return null;
  }

  function resolveLibraryDropLayout(
    payload: LibraryAssetDragPayload[],
    targetTrackId: string | null,
    ctrlKey: boolean,
    metaKey: boolean,
  ) {
    if (payload.length <= 1) {
      return "horizontal";
    }

    if (!targetTrackId) {
      return "vertical";
    }

    return ctrlKey || metaKey ? "vertical" : "horizontal";
  }

  function resolveLibraryPreviewTrackId(targetTrackId: string | null, layout: LibraryDropLayout, index: number) {
    if (layout === "horizontal" || !targetTrackId) {
      return targetTrackId;
    }

    const baseIndex = visibleTracks.findIndex((track) => track.id === targetTrackId);
    if (baseIndex < 0) {
      return index === 0 ? targetTrackId : null;
    }

    return visibleTracks[baseIndex + index]?.id ?? null;
  }

  function buildLibraryClipPreview(args: {
    payload: LibraryAssetDragPayload[];
    targetTrackId: string | null;
    timelineStartSeconds: number;
    layout: LibraryDropLayout;
  }) {
    let accumulatedDurationSeconds = 0;

    return args.payload.map((item, index) => {
      const asset = resolveDraggedLibraryAsset(item.file_path, item.durationSeconds);
      const timelineStartSeconds =
        args.layout === "horizontal"
          ? args.timelineStartSeconds + accumulatedDurationSeconds
          : args.timelineStartSeconds;

      accumulatedDurationSeconds += asset.durationSeconds;

      return {
        trackId: resolveLibraryPreviewTrackId(args.targetTrackId, args.layout, index),
        filePath: asset.filePath,
        label: asset.fileName,
        timelineStartSeconds,
        durationSeconds: asset.durationSeconds,
        rowOffset: args.layout === "vertical" ? index : 0,
      } satisfies LibraryClipPreviewState;
    });
  }

  function getLibraryDragViewportBounds(element: HTMLElement) {
    if (element.classList.contains("lt-track-lane")) {
      return element.getBoundingClientRect();
    }

    return rulerTrackRef.current?.getBoundingClientRect() ?? element.getBoundingClientRect();
  }

  function resolveLibraryDropSeconds(
    event: ReactDragEvent<HTMLElement>,
    element: HTMLElement,
  ) {
    const bounds = getLibraryDragViewportBounds(element);
    const viewportX = clamp(event.clientX - bounds.left, 0, bounds.width);
    const rawSeconds = screenXToSeconds(viewportX, getCameraX(), pixelsPerSecond);

    return snapEnabled
      ? snapToTimelineGrid(rawSeconds, song?.bpm ?? 120, song?.timeSignature ?? "4/4", zoomLevel, pixelsPerSecond)
      : rawSeconds;
  }

  function resolveLibraryGhostLeft(timelineStartSeconds: number) {
    return secondsToScreenX(timelineStartSeconds, getCameraX(), pixelsPerSecond);
  }

  function updateLibraryClipPreview(hoverState: LibraryDragHoverState, element: HTMLElement) {
    const layout = resolveLibraryDropLayout(
      hoverState.payload,
      hoverState.targetTrackId,
      hoverState.ctrlKey,
      hoverState.metaKey,
    );
    const timelineStartSeconds = resolveLibraryDropSeconds(
      {
        clientX: hoverState.clientX,
        currentTarget: element,
      } as ReactDragEvent<HTMLElement>,
      element,
    );

    setLibraryClipPreview(
      buildLibraryClipPreview({
        payload: hoverState.payload,
        targetTrackId: hoverState.targetTrackId,
        timelineStartSeconds,
        layout,
      }),
    );
  }

  function stopLibraryDragAutoScroll() {
    const autoScrollState = libraryDragAutoScrollRef.current;
    autoScrollState.horizontalVelocity = 0;
    autoScrollState.verticalVelocity = 0;

    if (autoScrollState.frameId !== null) {
      window.cancelAnimationFrame(autoScrollState.frameId);
      autoScrollState.frameId = null;
    }
  }

  function clearLibraryDragPreview() {
    libraryDragHoverRef.current = null;
    stopLibraryDragAutoScroll();
    setLibraryClipPreview([]);
  }

  function clearActiveLibraryDragPayload() {
    activeLibraryDragPayloadRef.current = null;
  }

  function resolveLibraryAutoScrollVelocity(distancePx: number) {
    if (distancePx >= LIBRARY_DRAG_EDGE_BUFFER_PX) {
      return 0;
    }

    const intensity = (LIBRARY_DRAG_EDGE_BUFFER_PX - Math.max(0, distancePx)) / LIBRARY_DRAG_EDGE_BUFFER_PX;
    return Math.max(1, Math.round(intensity * intensity * LIBRARY_DRAG_MAX_SCROLL_SPEED_PX));
  }

  function tickLibraryDragAutoScroll() {
    const autoScrollState = libraryDragAutoScrollRef.current;
    const laneArea = laneAreaRef.current;
    const hoverState = libraryDragHoverRef.current;

    if (!hoverState || (!autoScrollState.horizontalVelocity && !autoScrollState.verticalVelocity)) {
      autoScrollState.frameId = null;
      return;
    }

    if (autoScrollState.horizontalVelocity) {
      updateCameraX(cameraXRef.current + autoScrollState.horizontalVelocity);
    }

    if (laneArea && autoScrollState.verticalVelocity) {
      laneArea.scrollTop += autoScrollState.verticalVelocity;
    }

    const hoverElement =
      hoverState.targetTrackId != null
        ? (laneArea?.querySelector(`[data-track-id="${hoverState.targetTrackId}"] .lt-track-lane`) as HTMLDivElement | null)
        : laneArea;
    if (hoverElement) {
      updateLibraryClipPreview(hoverState, hoverElement);
    }

    autoScrollState.frameId = window.requestAnimationFrame(tickLibraryDragAutoScroll);
  }

  function updateLibraryDragAutoScroll(event: ReactDragEvent<HTMLElement>) {
    const autoScrollState = libraryDragAutoScrollRef.current;
    const horizontalBounds = rulerTrackRef.current?.getBoundingClientRect() ?? timelineShellRef.current?.getBoundingClientRect();
    const verticalBounds = laneAreaRef.current?.getBoundingClientRect();

    let horizontalVelocity = 0;
    if (horizontalBounds) {
      const distanceToLeft = event.clientX - horizontalBounds.left;
      const distanceToRight = horizontalBounds.right - event.clientX;

      if (distanceToLeft < LIBRARY_DRAG_EDGE_BUFFER_PX) {
        horizontalVelocity = -resolveLibraryAutoScrollVelocity(distanceToLeft);
      } else if (distanceToRight < LIBRARY_DRAG_EDGE_BUFFER_PX) {
        horizontalVelocity = resolveLibraryAutoScrollVelocity(distanceToRight);
      }
    }

    let verticalVelocity = 0;
    if (verticalBounds) {
      const distanceToTop = event.clientY - verticalBounds.top;
      const distanceToBottom = verticalBounds.bottom - event.clientY;

      if (distanceToTop < LIBRARY_DRAG_EDGE_BUFFER_PX) {
        verticalVelocity = -resolveLibraryAutoScrollVelocity(distanceToTop);
      } else if (distanceToBottom < LIBRARY_DRAG_EDGE_BUFFER_PX) {
        verticalVelocity = resolveLibraryAutoScrollVelocity(distanceToBottom);
      }
    }

    autoScrollState.horizontalVelocity = horizontalVelocity;
    autoScrollState.verticalVelocity = verticalVelocity;

    if (!horizontalVelocity && !verticalVelocity) {
      stopLibraryDragAutoScroll();
      return;
    }

    if (autoScrollState.frameId === null) {
      autoScrollState.frameId = window.requestAnimationFrame(tickLibraryDragAutoScroll);
    }
  }

  function beginLibraryDragHover(
    event: ReactDragEvent<HTMLDivElement>,
    payload: LibraryAssetDragPayload[],
    targetTrackId: string | null,
  ) {
    libraryDragHoverRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      payload,
      targetTrackId,
    };
    updateLibraryClipPreview(libraryDragHoverRef.current, event.currentTarget);
    updateLibraryDragAutoScroll(event);
  }

  async function maybePromptForInitialTempo(asset: LibraryAssetSummary) {
    const currentSong = songRef.current;
    if (
      !currentSong ||
      currentSong.clips.length > 0 ||
      asset.detectedBpm == null ||
      !Number.isFinite(asset.detectedBpm) ||
      Math.abs(asset.detectedBpm - currentSong.bpm) < 0.01
    ) {
      return;
    }

    const shouldUpdateTempo = window.confirm(
      `Detected BPM: ${asset.detectedBpm.toFixed(1)}. Do you want to adjust the project tempo?`,
    );
    if (!shouldUpdateTempo) {
      return;
    }

    const nextSnapshot = await updateSongTempo(asset.detectedBpm);
    applyPlaybackSnapshot(nextSnapshot);
    setTempoDraft(String(asset.detectedBpm));
  }

  async function createLibraryTrackForAsset(asset: LibraryAssetSummary) {
    const snapshot = await createTrack({
      name: humanizeLibraryTrackName(asset.filePath),
      kind: "audio",
    });

    const nextSong = await getSongView();
    return {
      snapshot,
      trackId: nextSong?.tracks.at(-1)?.id ?? null,
    };
  }

  async function commitLibraryClipPlacements(args: {
    placements: Array<{
      asset: LibraryAssetSummary;
      trackId: string;
      timelineStartSeconds: number;
    }>;
    pendingTrackSnapshot?: TransportSnapshot | null;
  }) {
    if (!args.placements.length) {
      if (args.pendingTrackSnapshot) {
        applyPlaybackSnapshot(args.pendingTrackSnapshot);
      }
      return;
    }

    if (args.pendingTrackSnapshot) {
      applyPlaybackSnapshot(args.pendingTrackSnapshot);
    }

    setWaveformCache((current) => {
      const nextCache = { ...current };

      for (const placement of args.placements) {
        const waveformKey = placement.asset.filePath;
        if (nextCache[waveformKey] && !nextCache[waveformKey].isPreview) {
          continue;
        }

        nextCache[waveformKey] = buildInstantWaveformPreview(
          waveformKey,
          placement.asset.durationSeconds,
        );
      }

      return nextCache;
    });

    const optimisticOperationId = startOptimisticClipOperation(
      args.placements.map((placement, index) => ({
        id: `optimistic-clip-${Date.now()}-${index}`,
        trackId: placement.trackId,
        trackName:
          tracksByIdRef.current[placement.trackId]?.name ?? humanizeLibraryTrackName(placement.asset.filePath),
        filePath: placement.asset.filePath,
        waveformKey: placement.asset.filePath,
        timelineStartSeconds: Math.max(0, placement.timelineStartSeconds),
        sourceStartSeconds: 0,
        sourceDurationSeconds: placement.asset.durationSeconds,
        durationSeconds: placement.asset.durationSeconds,
        gain: 1,
      })),
    );

    try {
      const clipSnapshot = await createClipsBatch(
        args.placements.map((placement) => ({
          trackId: placement.trackId,
          filePath: placement.asset.filePath,
          timelineStartSeconds: placement.timelineStartSeconds,
        })),
      );
      completeOptimisticClipOperation(optimisticOperationId, clipSnapshot.projectRevision);
      applyPlaybackSnapshot(clipSnapshot);
    } catch (error) {
      discardOptimisticClipOperation(optimisticOperationId);
      throw error;
    }
  }

  async function placeLibraryAssetsOnTimeline(args: {
    payload: LibraryAssetDragPayload[];
    timelineStartSeconds: number;
    targetTrackId: string | null;
    layout: LibraryDropLayout;
  }) {
    const assets = args.payload.map((item) => resolveDraggedLibraryAsset(item.file_path, item.durationSeconds));
    if (!assets.length) {
      return;
    }

    await maybePromptForInitialTempo(assets[0]);

    if (args.layout === "horizontal") {
      let targetTrackId = args.targetTrackId;
      let pendingTrackSnapshot: TransportSnapshot | null = null;
      if (!targetTrackId) {
        const createdTrack = await createLibraryTrackForAsset(assets[0]);
        targetTrackId = createdTrack.trackId;
        pendingTrackSnapshot = createdTrack.snapshot;
      }

      if (!targetTrackId) {
        if (pendingTrackSnapshot) {
          applyPlaybackSnapshot(pendingTrackSnapshot);
        }
        return;
      }

      let clipStartSeconds = args.timelineStartSeconds;
      const placements = assets.map((asset) => {
        const nextPlacement = {
          asset,
          trackId: targetTrackId as string,
          timelineStartSeconds: clipStartSeconds,
        };
        clipStartSeconds += asset.durationSeconds;
        return nextPlacement;
      });

      await commitLibraryClipPlacements({
        placements,
        pendingTrackSnapshot,
      });

      setSelectedTrackId(targetTrackId);
    } else {
      let selectedTrackId: string | null = args.targetTrackId;
      let pendingTrackSnapshot: TransportSnapshot | null = null;
      const placements: Array<{
        asset: LibraryAssetSummary;
        trackId: string;
        timelineStartSeconds: number;
      }> = [];

      for (const [index, asset] of assets.entries()) {
        const createdTrack =
          index === 0 && args.targetTrackId ? null : await createLibraryTrackForAsset(asset);
        const targetTrackId = createdTrack?.trackId ?? args.targetTrackId;
        if (!targetTrackId) {
          if (createdTrack?.snapshot) {
            applyPlaybackSnapshot(createdTrack.snapshot);
          }
          continue;
        }

        if (createdTrack?.snapshot) {
          pendingTrackSnapshot = createdTrack.snapshot;
        }

        placements.push({
          asset,
          trackId: targetTrackId,
          timelineStartSeconds: args.timelineStartSeconds,
        });
        selectedTrackId = targetTrackId;
      }

      await commitLibraryClipPlacements({
        placements,
        pendingTrackSnapshot,
      });

      if (selectedTrackId) {
        setSelectedTrackId(selectedTrackId);
      }
    }

    setSelectedSectionId(null);
    setStatus(
      assets.length === 1
        ? `Clip agregado: ${assets[0].fileName}`
        : `${assets.length} clips agregados desde la biblioteca.`,
    );
  }

  function handleTrackListLibraryDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }

    clearLibraryDragPreview();
  }

  function handleTrackLaneLibraryDragOver(
    event: ReactDragEvent<HTMLDivElement>,
    track: TrackSummary,
  ) {
    const payload = resolveLibraryDragPayload(event.dataTransfer);
    if (!payload || track.kind === "folder") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    beginLibraryDragHover(event, payload, track.id);
  }

  function handleTrackLaneLibraryDrop(
    event: ReactDragEvent<HTMLDivElement>,
    track: TrackSummary,
  ) {
    const payload = resolveLibraryDragPayload(event.dataTransfer);
    if (!payload || track.kind === "folder") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    clearLibraryDragPreview();
    clearActiveLibraryDragPayload();

    void runAction(async () => {
      await placeLibraryAssetsOnTimeline({
        payload,
        timelineStartSeconds: resolveLibraryDropSeconds(event, event.currentTarget),
        targetTrackId: track.id,
        layout: resolveLibraryDropLayout(payload, track.id, event.ctrlKey, event.metaKey),
      });
    });
  }

  function handleTrackListLibraryDragOver(event: ReactDragEvent<HTMLDivElement>) {
    const payload = resolveLibraryDragPayload(event.dataTransfer);
    if (!payload) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";

    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest(".lt-track-lane")) {
      updateLibraryDragAutoScroll(event);
      return;
    }

    beginLibraryDragHover(event, payload, null);
  }

  function handleTrackListLibraryDrop(event: ReactDragEvent<HTMLDivElement>) {
    const payload = resolveLibraryDragPayload(event.dataTransfer);
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (!payload || target?.closest(".lt-track-lane")) {
      return;
    }

    event.preventDefault();
    clearLibraryDragPreview();
    clearActiveLibraryDragPayload();

    void runAction(async () => {
      await placeLibraryAssetsOnTimeline({
        payload,
        timelineStartSeconds: resolveLibraryDropSeconds(event, event.currentTarget),
        targetTrackId: null,
        layout: resolveLibraryDropLayout(payload, null, event.ctrlKey, event.metaKey),
      });
    });
  }

  function handleLibraryPreviewLaneDragOver(event: ReactDragEvent<HTMLDivElement>) {
    const payload = resolveLibraryDragPayload(event.dataTransfer);
    if (!payload) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    beginLibraryDragHover(event, payload, null);
  }

  function handleLibraryPreviewLaneDrop(event: ReactDragEvent<HTMLDivElement>) {
    const payload = resolveLibraryDragPayload(event.dataTransfer);
    if (!payload) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    clearLibraryDragPreview();
    clearActiveLibraryDragPayload();

    void runAction(async () => {
      await placeLibraryAssetsOnTimeline({
        payload,
        timelineStartSeconds: resolveLibraryDropSeconds(event, event.currentTarget),
        targetTrackId: null,
        layout: resolveLibraryDropLayout(payload, null, event.ctrlKey, event.metaKey),
      });
    });
  }

  function handleEmptyArrangementLibraryDragOver(event: ReactDragEvent<HTMLDivElement>) {
    const payload = resolveLibraryDragPayload(event.dataTransfer);
    if (!payload) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    beginLibraryDragHover(event, payload, null);
  }

  function handleEmptyArrangementLibraryDrop(event: ReactDragEvent<HTMLDivElement>) {
    const payload = resolveLibraryDragPayload(event.dataTransfer);
    if (!payload) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    clearLibraryDragPreview();
    clearActiveLibraryDragPayload();

    void runAction(async () => {
      await placeLibraryAssetsOnTimeline({
        payload,
        timelineStartSeconds: resolveLibraryDropSeconds(event, event.currentTarget),
        targetTrackId: null,
        layout: resolveLibraryDropLayout(payload, null, event.ctrlKey, event.metaKey),
      });
    });
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
          <button
            type="button"
            className={activeSidebarTab === "markers" ? "is-active" : ""}
            aria-label="Markers"
            onClick={() => handleSidebarTabToggle("markers")}
          >
            <span className="material-symbols-outlined">sell</span>
            Markers
          </button>
          <button
            type="button"
            className={activeSidebarTab === "library" ? "is-active" : ""}
            aria-label="Library"
            onClick={() => handleSidebarTabToggle("library")}
          >
            <span className="material-symbols-outlined">library_music</span>
            Library
          </button>
          <button
            type="button"
            className={activeSidebarTab === "routing" ? "is-active" : ""}
            aria-label="Routing"
            onClick={() => handleSidebarTabToggle("routing")}
          >
            <span className="material-symbols-outlined">settings_input_component</span>
            Routing
          </button>
          <button
            type="button"
            className={activeSidebarTab === "settings" ? "is-active" : ""}
            aria-label="Settings"
            onClick={() => handleSidebarTabToggle("settings")}
          >
            <span className="material-symbols-outlined">settings</span>
            Settings
          </button>
        </aside>

        <div className="lt-workspace">
      <div className="lt-workspace-body">
      {activeSidebarTab === "library" ? (
        <LibrarySidebarPanel
          assets={libraryAssets}
          isLoading={isLibraryLoading}
          isImporting={isImportingLibrary}
          importProgress={libraryImportProgress}
          deletingFilePath={deletingLibraryFilePath}
          canImport={Boolean(playbackSongDir)}
          onDragAssetsStart={(payload) => {
            activeLibraryDragPayloadRef.current = payload;
          }}
          onDragAssetsEnd={() => {
            clearLibraryDragPreview();
            clearActiveLibraryDragPayload();
          }}
          onImport={() => {
            void handleImportLibraryAssetsClick();
          }}
          onDelete={(filePath, fileName) => {
            void handleDeleteLibraryAsset(filePath, fileName);
          }}
        />
      ) : null}
      {shouldShowEmptyState ? (
        <div className="lt-empty-state">
          <div className="lt-empty-state-card">
            <span className="lt-empty-state-eyebrow">LibreTracks DAW</span>
            <h1>Create or open a song</h1>
            <p>
              Start a new project or open an existing one. Import WAV assets later from the Library
              panel and drag them onto the timeline only when you want to arrange them.
            </p>
            <div className="lt-empty-state-actions">
              <button type="button" className="is-primary" onClick={handleCreateSongClick}>Create</button>
              <button type="button" onClick={handleOpenProjectClick}>Open</button>
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
                const startSeconds = snappedRulerSeconds(event, song.durationSeconds);
                setSelectedSectionId(null);
                setSelectedClipId(null);
                setSelectedTrackId(null);
                setContextMenu(null);
                void runAction(async () => {
                  await performSeek(startSeconds);
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

                <PlayheadOverlay
                  className="lt-playhead is-handle"
                  durationSeconds={song?.durationSeconds ?? 0}
                  pixelsPerSecond={pixelsPerSecond}
                  cameraXRef={cameraXRef}
                  dragStateRef={playheadDragRef}
                  positionSecondsRef={displayPositionSecondsRef}
                  normalizePositionSeconds={(positionSeconds) =>
                    normalizeTimelineSeekSeconds(positionSeconds, song?.durationSeconds ?? 0)}
                  positionBoundsRef={rulerTrackRef}
                  scrollContainerRef={timelineShellRef}
                  onPreviewPositionChange={syncLivePosition}
                  onSeekCommit={(positionSeconds) => {
                    setContextMenu(null);
                    void runAction(async () => {
                      await performSeek(positionSeconds);
                    });
                  }}
                />
              </div>
            </div>
          </div>

          <div
            className={`lt-track-list ${libraryClipPreview.length ? "is-library-drag-over" : ""}`}
            ref={laneAreaRef}
            style={{ width: timelineRowWidth }}
            onContextMenu={handleTrackListContextMenu}
            onDragOver={handleTrackListLibraryDragOver}
            onDrop={handleTrackListLibraryDrop}
            onDragLeave={handleTrackListLibraryDragLeave}
          >
            {song ? (
              <TimelineTrackCanvas
                width={laneViewportWidth}
                height={visibleTracks.length * trackHeight}
                trackHeight={trackHeight}
                song={song}
                visibleTracks={visibleTracks}
                clipsByTrack={renderedClipsByTrack}
                waveformCache={waveformCache}
                cameraXRef={cameraXRef}
                pixelsPerSecond={pixelsPerSecond}
                timelineGrid={timelineGrid}
                selectedClipId={selectedClipId}
                clipPreviewSecondsRef={clipPreviewSecondsRef}
              />
            ) : null}

            <div className="lt-track-playhead-layer" aria-hidden="true">
              <PlayheadOverlay
                className="lt-track-playhead"
                durationSeconds={song?.durationSeconds ?? 0}
                pixelsPerSecond={pixelsPerSecond}
                cameraXRef={cameraXRef}
                dragStateRef={playheadDragRef}
                positionSecondsRef={displayPositionSecondsRef}
              />
            </div>

            {shouldShowEmptyArrangementHint ? (
              <div
                className="lt-empty-arrangement-dropzone"
                aria-label="Empty arrangement dropzone"
                onDragOver={handleEmptyArrangementLibraryDragOver}
                onDrop={handleEmptyArrangementLibraryDrop}
              >
                <strong>Drop audio from the Library to create the first track</strong>
                <p>
                  LibreTracks will create an audio track automatically and place the clip at the snapped
                  timeline position.
                </p>
                {libraryClipPreview
                  .filter((preview) => preview.trackId === null)
                  .map((preview) => (
                    <div
                      key={`${preview.filePath}-${preview.rowOffset}-${preview.timelineStartSeconds}`}
                      className="lt-library-clip-ghost is-floating"
                      style={{
                        left: HEADER_WIDTH + resolveLibraryGhostLeft(preview.timelineStartSeconds),
                        top: 16 + preview.rowOffset * 72,
                        bottom: "auto",
                        height: 56,
                        width: Math.max(preview.durationSeconds * pixelsPerSecond, 36),
                      }}
                    >
                      <span>{preview.label}</span>
                    </div>
                  ))}
              </div>
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
                    onDragOver={(event) => handleTrackLaneLibraryDragOver(event, track)}
                    onDrop={(event) => handleTrackLaneLibraryDrop(event, track)}
                  >
                    {libraryClipPreview
                      .filter((preview) => preview.trackId === track.id)
                      .map((preview) => (
                        <div
                          key={`${preview.filePath}-${preview.rowOffset}-${preview.timelineStartSeconds}`}
                          className="lt-library-clip-ghost"
                          style={{
                            left: resolveLibraryGhostLeft(preview.timelineStartSeconds),
                            width: Math.max(preview.durationSeconds * pixelsPerSecond, 36),
                          }}
                        >
                          <span>{preview.label}</span>
                        </div>
                      ))}
                  </div>
                </div>
              );
            })}

            {!shouldShowEmptyArrangementHint
              ? libraryPreviewRows.map((previewRow) => (
                  <div
                    key={`library-preview-row-${previewRow.rowOffset}`}
                    className="lt-track-row is-library-preview"
                    style={{
                      width: timelineRowWidth,
                      gridTemplateColumns: `${HEADER_WIDTH}px ${laneViewportWidth}px`,
                    }}
                  >
                    <div
                      className={`lt-track-header ${previewTrackDensityClass} is-library-preview`}
                      style={{ height: trackHeight, paddingLeft: 16 }}
                      aria-hidden="true"
                    >
                      <div className="lt-track-header-body">
                        <div className="lt-track-header-content">
                          <div className="lt-track-header-summary">
                            <div className="lt-track-header-main">
                              <div className="lt-track-title-row">
                                <strong>{previewRow.title}</strong>
                              </div>
                              <span className="lt-track-meta">{previewRow.meta}</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div
                      className="lt-track-lane is-library-preview"
                      style={{ height: trackHeight }}
                      aria-label={`Preview lane ${previewRow.title}`}
                      onDragOver={handleLibraryPreviewLaneDragOver}
                      onDrop={handleLibraryPreviewLaneDrop}
                    >
                      {previewRow.previews.map((preview) => (
                        <div
                          key={`${preview.filePath}-${preview.rowOffset}-${preview.timelineStartSeconds}`}
                          className="lt-library-clip-ghost"
                          style={{
                            left: resolveLibraryGhostLeft(preview.timelineStartSeconds),
                            width: Math.max(preview.durationSeconds * pixelsPerSecond, 36),
                          }}
                        >
                          <span>{preview.label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
              : null}
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
  </div>

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

        <div className="lt-status-overlay" aria-live="polite">
          <span>{status}</span>
        </div>
        </div>
      </div>
      </div>
    </Profiler>
  );
}
