import {
  Profiler,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  DEFAULT_APP_SETTINGS,
  assignSectionMarkerDigit,
  cancelMarkerJump,
  createSectionMarker,
  createSongRegion,
  createClipsBatch,
  createLibraryFolder,
  createSong,
  createTrack,
  deleteLibraryFolder,
  buildWaveformLodsFromPeaks,
  deleteClip,
  deleteSongRegion,
  deleteSongTempoMarker,
  deleteSectionMarker,
  deleteTrack,
  duplicateClip,
  deleteLibraryAsset,
  getLibraryAssets,
  getLibraryFolders,
  getAudioOutputDevices,
  getMidiInputs,
  getRemoteServerInfo,
  getSettings,
  buildSongTempoRegions,
  getPrimarySongRegion,
  getSongBaseBpm,
  getSongBaseTimeSignature,
  getSongTempoRegionAtPosition,
  getSongRegionAtPosition,
  getLibraryWaveformSummaries,
  getSongView,
  getTransportSnapshot,
  getWaveformSummaries,
  importLibraryAssetsFromDialog,
  isTauriApp,
  listenToLibraryImportProgress,
  listenToAudioMeters,
  listenToMidiRawMessage,
  listenToSettingsUpdated,
  listenToTransportLifecycle,
  listenToWaveformReady,
  moveClip,
  moveClipLive,
  moveLibraryAsset,
  moveTrack,
  openProject,
  pauseTransport,
  playTransport,
  redoAction,
  renameLibraryFolder,
  saveProject,
  saveProjectAs,
  saveSettings,
  scheduleMarkerJump,
  scheduleRegionJump,
  seekTransport,
  splitClip,
  stopTransport,
  toggleVamp,
  undoAction,
  updateAudioSettings,
  updateSectionMarker,
  updateSongRegion,
  upsertSongTempoMarker,
  updateSongTempo,
  updateTrack,
  updateTrackMixLive,
  normalizeAppSettings,
  type AppSettings,
  type ClipSummary,
  type MidiBinding,
  type JumpTriggerLabel,
  type LibraryAssetSummary,
  type LibraryImportProgressEvent,
  type RemoteServerInfo,
  type SectionMarkerSummary,
  type SongRegionSummary,
  type SongView,
  type TempoMarkerSummary,
  type TrackKind,
  type TransportLifecycleEvent,
  type TrackSummary,
  type TransportSnapshot,
  type WaveformSummaryDto,
  reportUiRenderMetric,
} from "./desktopApi";
import { getSystemLanguage } from "../../shared/i18n";
import { LibrarySidebarPanel } from "./LibrarySidebarPanel";
import { RemoteAccessCard } from "./RemoteAccessCard";
import { TimelineCanvasPane } from "./TimelineCanvasPane";
import { TimelineToolbar } from "./TimelineToolbar";
import { TimelineTopbar } from "./TimelineTopbar";
import { TrackHeadersPane } from "./TrackHeadersPane";
import { snapToTimelineGrid, useTimelineGrid } from "./useTimelineGrid";
import {
  BASE_PIXELS_PER_SECOND,
  clampCameraX,
  clientXToTimelineSeconds,
  getCumulativeMusicalPosition,
  getTimelineWorkspaceEndSeconds,
  getZoomLevelDelta,
  getMaxCameraX,
  screenXToSeconds,
  secondsToScreenX,
  TIMELINE_ZOOM_MULTIPLIER,
  zoomCameraAtViewportX,
} from "./timelineMath";
import {
  meterDictionaryFromLevels,
  useTransportStore,
  type OptimisticMixState,
} from "./store";
import {
  TIMELINE_DEFAULT_TRACK_HEIGHT,
  useTimelineUIStore,
} from "./uiStore";

const HEADER_WIDTH = 260;
const DEFAULT_TIMELINE_VIEWPORT_WIDTH = 1100;
const TIMELINE_FIT_RIGHT_GUTTER_PX = 140;
const TRACK_HEIGHT_MIN = 68;
const TRACK_HEIGHT_MAX = 148;
const TRACK_HEIGHT_STEP = 8;
const RULER_HEIGHT = 64;
const ZOOM_MIN = 0.0625;
const ZOOM_MAX = 64;
const DRAG_THRESHOLD_PX = 6;
const LIVE_TRACK_MIX_MIN_INTERVAL_MS = 16;
const INSTANT_WAVEFORM_BUCKET_COUNT = 96;
const SCROLL_COMMIT_DEBOUNCE_MS = 100;
const LIVE_ZOOM_COMMIT_DEBOUNCE_MS = 150;

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

type TimelineRangeSelection = {
  startSeconds: number;
  endSeconds: number;
};

type LiveClipMoveState = {
  inFlight: boolean;
  queuedSeconds: number | null;
};

type LiveTrackMixRequestState = {
  inFlight: boolean;
  queuedKeys: Set<keyof OptimisticMixState>;
  lastSentAt: number;
};

type SidebarTab = "library";

type MidiLearnCommand = {
  key: string;
  labelKey: string;
};

type MidiLearnFeedback = {
  key: string;
  binding: MidiBinding;
};

const LIBRARY_ASSET_DRAG_MIME = "application/libretracks-library-assets";
const LIBRARY_DRAG_EDGE_BUFFER_PX = 50;
const LIBRARY_DRAG_MAX_SCROLL_SPEED_PX = 22;
const MIDI_NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];
const MIDI_LEARN_COMMANDS: MidiLearnCommand[] = [
  { key: "action:create_song", labelKey: "transport.settingsModal.midiLearnCreateSong" },
  { key: "action:open_project", labelKey: "transport.settingsModal.midiLearnOpenProject" },
  { key: "action:save_project", labelKey: "transport.settingsModal.midiLearnSaveProject" },
  { key: "action:save_project_as", labelKey: "transport.settingsModal.midiLearnSaveProjectAs" },
  { key: "action:undo", labelKey: "transport.settingsModal.midiLearnUndo" },
  { key: "action:redo", labelKey: "transport.settingsModal.midiLearnRedo" },
  { key: "action:play", labelKey: "timelineTopbar.play" },
  { key: "action:pause", labelKey: "timelineTopbar.pause" },
  { key: "action:stop", labelKey: "timelineTopbar.stop" },
  { key: "action:next_song", labelKey: "timelineTopbar.next" },
  { key: "action:toggle_metronome", labelKey: "timelineTopbar.metronome" },
  { key: "action:toggle_vamp", labelKey: "timelineToolbar.vampButton" },
  { key: "action:toggle_split_stereo", labelKey: "transport.settingsModal.midiLearnToggleSplitStereo" },
  { key: "action:cancel_jump", labelKey: "timelineToolbar.cancelJump" },
  { key: "action:create_marker", labelKey: "transport.settingsModal.midiLearnCreateMarker" },
  { key: "action:set_global_jump_mode_immediate", labelKey: "transport.settingsModal.midiLearnGlobalJumpModeImmediate" },
  { key: "action:set_global_jump_mode_after_bars", labelKey: "transport.settingsModal.midiLearnGlobalJumpModeAfterBars" },
  { key: "action:set_global_jump_mode_next_marker", labelKey: "transport.settingsModal.midiLearnGlobalJumpModeNextMarker" },
  { key: "action:increase_global_jump_bars", labelKey: "transport.settingsModal.midiLearnBarsIncrease" },
  { key: "action:decrease_global_jump_bars", labelKey: "transport.settingsModal.midiLearnBarsDecrease" },
  { key: "param:tempo", labelKey: "transport.settingsModal.midiLearnTempo" },
  { key: "param:global_jump_mode", labelKey: "transport.settingsModal.midiLearnGlobalJumpMode" },
  { key: "param:metronome_volume", labelKey: "transport.settingsModal.metronomeVolume" },
  { key: "param:global_jump_bars", labelKey: "transport.settingsModal.globalJumpBars" },
  { key: "action:set_song_jump_trigger_immediate", labelKey: "transport.settingsModal.midiLearnSongJumpTriggerImmediate" },
  { key: "action:set_song_jump_trigger_after_bars", labelKey: "transport.settingsModal.midiLearnSongJumpTriggerAfterBars" },
  { key: "action:set_song_jump_trigger_region_end", labelKey: "transport.settingsModal.midiLearnSongJumpTriggerRegionEnd" },
  { key: "action:increase_song_jump_bars", labelKey: "transport.settingsModal.midiLearnBarsIncrease" },
  { key: "action:decrease_song_jump_bars", labelKey: "transport.settingsModal.midiLearnBarsDecrease" },
  { key: "param:song_jump_trigger", labelKey: "transport.settingsModal.midiLearnSongJumpTrigger" },
  { key: "param:song_jump_bars", labelKey: "transport.settingsModal.songJumpBars" },
  { key: "action:set_song_transition_instant", labelKey: "transport.settingsModal.midiLearnSongTransitionInstant" },
  { key: "action:set_song_transition_fade_out", labelKey: "transport.settingsModal.midiLearnSongTransitionFadeOut" },
  { key: "param:song_transition_mode", labelKey: "transport.settingsModal.midiLearnSongTransitionMode" },
  { key: "action:set_vamp_mode_section", labelKey: "transport.settingsModal.midiLearnVampModeSection" },
  { key: "action:set_vamp_mode_bars", labelKey: "transport.settingsModal.midiLearnVampModeBars" },
  { key: "param:vamp_mode", labelKey: "transport.settingsModal.midiLearnVampMode" },
  { key: "action:increase_vamp_bars", labelKey: "transport.settingsModal.midiLearnBarsIncrease" },
  { key: "action:decrease_vamp_bars", labelKey: "transport.settingsModal.midiLearnBarsDecrease" },
  { key: "param:vamp_bars", labelKey: "transport.settingsModal.vampBars" },
  { key: "param:jump_bars", labelKey: "transport.settingsModal.jumpBars" },
];

function formatMidiBinding(binding: MidiBinding) {
  const channel = (binding.status & 0x0f) + 1;
  const statusType = binding.status & 0xf0;

  if (binding.isCc || statusType === 0xb0) {
    return `CC ${binding.data1} (Ch ${channel})`;
  }

  if (statusType === 0x90 || statusType === 0x80) {
    const noteIndex = binding.data1 % 12;
    const octave = Math.floor(binding.data1 / 12) - 1;
    const noteName = MIDI_NOTE_NAMES[noteIndex] ?? `Note ${binding.data1}`;
    const noteLabel = `${noteName}${octave}`;
    const prefix = statusType === 0x80 ? "Note Off" : "Note On";
    return `${prefix} ${binding.data1} (${noteLabel}) (Ch ${channel})`;
  }

  return `Status 0x${binding.status.toString(16).toUpperCase().padStart(2, "0")} / Data1 ${binding.data1} (Ch ${channel})`;
}

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

const PLAYBACK_SNAPSHOT_REANCHOR_TOLERANCE_SECONDS = 0.08;

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

function formatMusicalPosition(seconds: number, song: SongView | null | undefined) {
  return getCumulativeMusicalPosition(
    seconds,
    buildSongTempoRegions(song),
    getSongBaseBpm(song),
    getSongBaseTimeSignature(song),
  ).display;
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
    version: 3,
    durationSeconds,
    sampleRate: 48_000,
    lods: buildWaveformLodsFromPeaks(minPeaks, maxPeaks, durationSeconds, 48_000),
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

function resolveRegionShortcut(regions: SongRegionSummary[], digit: number) {
  return [...regions]
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
          ".lt-ruler-track, .lt-ruler-content, .lt-ruler-canvas, .lt-ruler-canvas-overlay, .lt-track-list, .lt-track-list-dropzone, .lt-track-lane-row, .lt-track-header-row, .lt-track-lane, .lt-track-canvas-layer, .lt-track-canvas-background, .lt-track-canvas, .lt-track-canvas-overlay",
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
  const hoveredRow = document.elementFromPoint(clientX, clientY)?.closest(".lt-track-lane-row, .lt-track-header-row") as
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

function rulerClientXToSeconds(
  clientX: number,
  element: HTMLElement,
  cameraX: number,
  durationSeconds: number,
  pixelsPerSecond: number,
) {
  const bounds = element.getBoundingClientRect();
  const viewportX = clamp(clientX - bounds.left, 0, bounds.width);
  return clamp(screenXToSeconds(viewportX, cameraX, pixelsPerSecond), 0, Math.max(0, durationSeconds));
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

export function TransportPanelContent() {
  const { t, i18n } = useTranslation();
  const [song, setSong] = useState<SongView | null>(null);
  const [waveformCache, setWaveformCache] = useState<Record<string, WaveformSummaryDto>>({});
  const [clipsByTrack, setClipsByTrack] = useState<Record<string, ClipSummary[]>>({});
  const [tracksById, setTracksById] = useState<Record<string, TrackSummary>>({});
  const [status, setStatus] = useState(() => t("transport.status.loadingSession"));
  const [isBusy, setIsBusy] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isRemoteModalOpen, setIsRemoteModalOpen] = useState(false);
  const [isSettingsLoading, setIsSettingsLoading] = useState(true);
  const [isSettingsSaving, setIsSettingsSaving] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [midiLearnFeedback, setMidiLearnFeedback] = useState<MidiLearnFeedback | null>(null);
  const [metronomeVolumeDraft, setMetronomeVolumeDraft] = useState(DEFAULT_APP_SETTINGS.metronomeVolume);
  const [audioOutputDevices, setAudioOutputDevices] = useState<string[]>([]);
  const [defaultAudioOutputDevice, setDefaultAudioOutputDevice] = useState<string | null>(null);
  const [midiInputDevices, setMidiInputDevices] = useState<string[]>([]);
  const [remoteServerInfo, setRemoteServerInfo] = useState<RemoteServerInfo | null>(null);
  const [tempoDraft, setTempoDraft] = useState("120");
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [openTopMenu, setOpenTopMenu] = useState<"file" | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [activeSidebarTab, setActiveSidebarTab] = useState<SidebarTab | null>(null);
  const [libraryAssets, setLibraryAssets] = useState<LibraryAssetSummary[]>([]);
  const [libraryFolders, setLibraryFolders] = useState<string[]>([]);
  const [libraryClipPreview, setLibraryClipPreview] = useState<LibraryClipPreviewState[]>([]);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  const [selectedTimelineRange, setSelectedTimelineRange] = useState<TimelineRangeSelection | null>(null);
  const [optimisticClipOperations, setOptimisticClipOperations] = useState<OptimisticClipOperation[]>([]);
  const [isLibraryLoading, setIsLibraryLoading] = useState(false);
  const [isImportingLibrary, setIsImportingLibrary] = useState(false);
  const [libraryImportProgress, setLibraryImportProgress] = useState<LibraryImportProgressEvent | null>(null);
  const [deletingLibraryFilePath, setDeletingLibraryFilePath] = useState<string | null>(null);
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(DEFAULT_TIMELINE_VIEWPORT_WIDTH);
  const appSettingsRef = useRef(appSettings);
  const metronomeLiveRequestIdRef = useRef(0);
  const syncSettingsLanguage = useCallback(async (settings: AppSettings) => {
    await i18n.changeLanguage(settings.locale || getSystemLanguage());
  }, [i18n]);
  const formatErrorStatus = useCallback((error: unknown) => {
    return t("transport.status.error", { message: String(error) });
  }, [t]);
  const translateJumpTrigger = useCallback((trigger: JumpTriggerLabel) => {
    if (trigger === "immediate") {
      return t("transport.jumpMode.immediate");
    }

    if (trigger === "next_marker") {
      return t("transport.jumpMode.nextMarker");
    }

    if (trigger === "region_end") {
      return t("transport.jumpMode.regionEnd");
    }

    const bars = Number(trigger.split(":")[1]) || 1;
    return t("transport.jumpMode.afterBars", { count: bars });
  }, [t]);
  const translateLanguageName = useCallback((language: "en" | "es") => {
    return i18n.t(
      language === "es"
        ? "transport.settingsModal.languageSpanish"
        : "transport.settingsModal.languageEnglish",
    );
  }, [i18n]);
  const cameraX = useTimelineUIStore((state) => state.cameraX);
  const zoomLevel = useTimelineUIStore((state) => state.zoomLevel);
  const trackHeight = useTimelineUIStore((state) => state.trackHeight);
  const snapEnabled = useTimelineUIStore((state) => state.snapEnabled);
  const midiLearnMode = useTimelineUIStore((state) => state.midiLearnMode);
  const midiLearnCommandRows = useMemo(
    () =>
      MIDI_LEARN_COMMANDS.map((command) => ({
        ...command,
        label: t(command.labelKey),
        binding: appSettings.midiMappings[command.key] ?? null,
      })),
    [appSettings.midiMappings, t],
  );
  const midiLearnFeedbackCommand = useMemo(
    () => midiLearnCommandRows.find((command) => command.key === midiLearnFeedback?.key) ?? null,
    [midiLearnCommandRows, midiLearnFeedback],
  );
  const activeMidiLearnCommand = useMemo(
    () => midiLearnCommandRows.find((command) => command.key === midiLearnMode) ?? null,
    [midiLearnCommandRows, midiLearnMode],
  );

  useEffect(() => {
    setMetronomeVolumeDraft(appSettings.metronomeVolume);
  }, [appSettings.metronomeVolume]);

  useEffect(() => {
    appSettingsRef.current = appSettings;
  }, [appSettings]);

  useEffect(() => {
    if (!isTauriApp) {
      return;
    }

    void getRemoteServerInfo()
      .then((info) => {
        setRemoteServerInfo(info);
      })
      .catch(() => {
        setRemoteServerInfo(null);
      });
  }, []);
  const selectedTrackIds = useTimelineUIStore((state) => state.selectedTrackIds);
  const selectedClipId = useTimelineUIStore((state) => state.selectedClipId);
  const selectedSectionId = useTimelineUIStore((state) => state.selectedSectionId);
  const setCameraX = useTimelineUIStore((state) => state.setCameraX);
  const setZoomLevel = useTimelineUIStore((state) => state.setZoomLevel);
  const setTrackHeight = useTimelineUIStore((state) => state.setTrackHeight);
  const setSnapEnabled = useTimelineUIStore((state) => state.setSnapEnabled);
  const toggleSnapEnabled = useTimelineUIStore((state) => state.toggleSnapEnabled);
  const setSelectedClipId = useTimelineUIStore((state) => state.setSelectedClipId);
  const setSelectedSectionId = useTimelineUIStore((state) => state.setSelectedSectionId);
  const clearSelection = useTimelineUIStore((state) => state.clearSelection);
  const selectTrack = useTimelineUIStore((state) => state.selectTrack);
  const selectClip = useTimelineUIStore((state) => state.selectClip);
  const selectSection = useTimelineUIStore((state) => state.selectSection);
  const setMidiLearnMode = useTimelineUIStore((state) => state.setMidiLearnMode);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const menuBarRef = useRef<HTMLDivElement | null>(null);
  const laneAreaRef = useRef<HTMLDivElement | null>(null);
  const rulerTrackRef = useRef<HTMLDivElement | null>(null);
  const timelineShellRef = useRef<HTMLDivElement | null>(null);
  const timelineScrollViewportRef = useRef<HTMLDivElement | null>(null);
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
  const transportReadoutTempoRef = useRef<HTMLElement | null>(null);
  const transportReadoutValueRef = useRef<HTMLElement | null>(null);
  const transportReadoutBarRef = useRef<HTMLElement | null>(null);
  const songDurationSecondsRef = useRef(0);
  const timelineDurationSecondsRef = useRef(0);
  const transportAnchorMetaRef = useRef<TransportAnchorMeta | null>(null);
  const viewportFitStateRef = useRef<{
    projectIdentity: string | null;
    hadClips: boolean;
  }>({
    projectIdentity: null,
    hadClips: false,
  });
  const cameraXRef = useRef(cameraX);
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
  const draggedTrackRowsRef = useRef<HTMLDivElement[]>([]);
  const draggedTrackHeadersRef = useRef<HTMLElement[]>([]);
  const droppedTrackRowRef = useRef<HTMLDivElement | null>(null);
  const libraryDragHoverRef = useRef<LibraryDragHoverState | null>(null);
  const activeLibraryDragPayloadRef = useRef<LibraryAssetDragPayload[] | null>(null);
  const libraryDragAutoScrollRef = useRef<LibraryDragAutoScrollState>({
    frameId: null,
    horizontalVelocity: 0,
    verticalVelocity: 0,
  });
  const scrollDebounceTimerRef = useRef<number | null>(null);
  const zoomDebounceTimerRef = useRef<number | null>(null);
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
      setStatus(formatErrorStatus(error));
    } finally {
      if (options?.busy) {
        setIsBusy(false);
      }
    }
  }, [formatErrorStatus]);

  const loadLibraryState = useCallback(async () => {
    if (!playbackSongDir) {
      return {
        assets: [] as LibraryAssetSummary[],
        folders: [] as string[],
      };
    }

    const [assets, folders] = await Promise.all([getLibraryAssets(), getLibraryFolders()]);
    return { assets, folders };
  }, [playbackSongDir]);

  const refreshSongView = useCallback(async () => {
    const nextSong = await getSongView();
    setSong(nextSong);
    return nextSong;
  }, []);

  const refreshAudioSettings = useCallback(async () => {
    const [nextSettings, nextAudioDevices, nextMidiInputs] = await Promise.all([
      getSettings(),
      getAudioOutputDevices(),
      getMidiInputs(),
    ]);
    const normalizedSettings = normalizeAppSettings(nextSettings);
    setAppSettings(normalizedSettings);
    await syncSettingsLanguage(normalizedSettings);
    setAudioOutputDevices(nextAudioDevices.devices);
    setDefaultAudioOutputDevice(nextAudioDevices.defaultDevice ?? null);
    setMidiInputDevices(nextMidiInputs);
    return normalizedSettings;
  }, [syncSettingsLanguage]);

  useEffect(() => {
    if (!isTauriApp) {
      return;
    }

    let unlisten: (() => void) | null = null;
    void listenToSettingsUpdated((nextSettings) => {
      const normalizedSettings = normalizeAppSettings(nextSettings);
      appSettingsRef.current = normalizedSettings;
      setAppSettings(normalizedSettings);
      setMetronomeVolumeDraft(normalizedSettings.metronomeVolume);
      void syncSettingsLanguage(normalizedSettings);
    }).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      unlisten?.();
    };
  }, [syncSettingsLanguage]);

  useEffect(() => {
    if (!isTauriApp) {
      return;
    }

    let unlisten: (() => void) | null = null;
    void listenToMidiRawMessage((message) => {
      const learnMode = useTimelineUIStore.getState().midiLearnMode;
      if (!learnMode) {
        return;
      }

      if (learnMode === "") {
        return;
      }

      const nextBinding = {
        status: message.status,
        data1: message.data1,
        isCc: (message.status & 0xF0) === 0xB0,
      };
      const nextSettings = normalizeAppSettings({
        ...appSettingsRef.current,
        midiMappings: {
          ...appSettingsRef.current.midiMappings,
          [learnMode]: nextBinding,
        },
      });
      const previousSettings = appSettingsRef.current;
      const learnedCommandLabel =
        midiLearnCommandRows.find((command) => command.key === learnMode)?.label ?? learnMode;

      appSettingsRef.current = nextSettings;
      setAppSettings(nextSettings);
      setMidiLearnMode(null);

      void runAction(async () => {
        try {
          const liveSettings = normalizeAppSettings(await updateAudioSettings(nextSettings));
          const savedSettings = normalizeAppSettings(await saveSettings(liveSettings));
          appSettingsRef.current = savedSettings;
          setAppSettings(savedSettings);
          setMidiLearnFeedback({ key: learnMode, binding: nextBinding });
          setStatus(
            t("transport.status.midiBindingLearned", {
              key: learnedCommandLabel,
              binding: formatMidiBinding(nextBinding),
            }),
          );
        } catch (error) {
          appSettingsRef.current = previousSettings;
          setAppSettings(previousSettings);
          setMidiLearnMode(learnMode);
          throw error;
        }
      });
    }).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      unlisten?.();
    };
  }, [midiLearnCommandRows, runAction, setMidiLearnMode, t]);

  const persistAudioSettings = useCallback(
    (
      nextSettings: AppSettings,
      successMessage: string | ((savedSettings: AppSettings) => string),
    ) => {
      const previousSettings = appSettingsRef.current;
      const normalizedSettings = normalizeAppSettings(nextSettings);
      setAppSettings(normalizedSettings);
      setIsSettingsSaving(true);

      void runAction(async () => {
      try {
          const liveSettings = normalizeAppSettings(await updateAudioSettings(normalizedSettings));
          const savedSettings = normalizeAppSettings(await saveSettings(liveSettings));
          setAppSettings(savedSettings);
          await syncSettingsLanguage(savedSettings);
          setStatus(typeof successMessage === "function" ? successMessage(savedSettings) : successMessage);
        } catch (error) {
          appSettingsRef.current = previousSettings;
          setAppSettings(previousSettings);
          throw error;
        } finally {
          setIsSettingsSaving(false);
        }
      });
    },
    [appSettings, runAction, syncSettingsLanguage],
  );

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
        setStatus(formatErrorStatus(error));
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
        setStatus(formatErrorStatus(error));
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
    draggedTrackRowsRef.current.forEach((row) => {
      row.style.transform = "";
      row.style.zIndex = "";
      row.style.pointerEvents = "";
    });

    draggedTrackHeadersRef.current.forEach((header) => {
      header.classList.remove("is-dragging");
    });

    const dropTargets = timelineShellRef.current?.querySelectorAll(".is-drop-target");
    dropTargets?.forEach((element) => {
      element.classList.remove(
        "is-drop-target",
        "is-drop-before",
        "is-drop-after",
        "is-drop-inside-folder",
      );
    });

    draggedTrackRowsRef.current = [];
    draggedTrackHeadersRef.current = [];
    draggedTrackRowRef.current = null;
    droppedTrackRowRef.current = null;
    trackDropStateRef.current = null;
  }, []);

  const applyTrackDragVisuals = useCallback((dragState: NonNullable<TrackDragState>, dropState: TrackDropState) => {
    const deltaY = dragState.currentClientY - dragState.startClientY;

    if (draggedTrackRowRef.current !== dragState.rowElement) {
      clearTrackDragVisuals();
      draggedTrackRowRef.current = dragState.rowElement;

      const dragTrackIds =
        selectedTrackIds.includes(dragState.trackId) && selectedTrackIds.length > 1
          ? selectedTrackIds
          : [dragState.trackId];
      const draggedRows: HTMLDivElement[] = [];
      const draggedHeaders: HTMLElement[] = [];

      dragTrackIds.forEach((trackId) => {
        const matchingRows = timelineShellRef.current?.querySelectorAll(
          `.lt-track-header-row[data-track-id="${trackId}"], .lt-track-lane-row[data-track-id="${trackId}"]`,
        );

        matchingRows?.forEach((element) => {
          if (!(element instanceof HTMLDivElement) || draggedRows.includes(element)) {
            return;
          }

          draggedRows.push(element);

          const header = element.querySelector(".lt-track-header");
          if (header instanceof HTMLElement) {
            draggedHeaders.push(header);
          }
        });
      });

      draggedTrackRowsRef.current = draggedRows;
      draggedTrackHeadersRef.current = draggedHeaders;
    }

    draggedTrackRowsRef.current.forEach((row) => {
      row.style.transform = `translate3d(0, ${deltaY}px, 0)`;
      row.style.zIndex = "8";
      row.style.pointerEvents = "none";
    });

    draggedTrackHeadersRef.current.forEach((header) => {
      header.classList.add("is-dragging");
    });

    const dropTargets = timelineShellRef.current?.querySelectorAll(".is-drop-target");
    dropTargets?.forEach((element) => {
      if (element instanceof HTMLElement && element.dataset.trackId !== dropState?.targetTrackId) {
        element.classList.remove(
          "is-drop-target",
          "is-drop-before",
          "is-drop-after",
          "is-drop-inside-folder",
        );
      }
    });

    if (dropState?.targetTrackId) {
      const nextDropRows = timelineShellRef.current?.querySelectorAll(`[data-track-id="${dropState.targetTrackId}"]`);
      nextDropRows?.forEach((element) => {
        element.classList.remove("is-drop-before", "is-drop-after", "is-drop-inside-folder");
        element.classList.add("is-drop-target", `is-drop-${dropState.mode}`);
      });
    }

    droppedTrackRowRef.current = null;
    trackDropStateRef.current = dropState;
  }, [clearTrackDragVisuals, selectedTrackIds]);

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
    const maxDuration = timelineDurationSecondsRef.current > 0
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

    syncLivePosition(isRunning ? anchorPositionSeconds : nextSnapshot.positionSeconds);
  }

  function resolveCurrentVisualPosition() {
    const anchor = playbackVisualAnchorRef.current;
    const elapsedSeconds = anchor.running
      ? (performance.now() - anchor.anchorReceivedAtMs) / 1000
      : 0;
    const durationSeconds = anchor.durationSeconds || timelineDurationSecondsRef.current || songDurationSecondsRef.current;

    return clamp(
      anchor.anchorPositionSeconds + elapsedSeconds,
      0,
      durationSeconds || Number.MAX_SAFE_INTEGER,
    );
  }

  useEffect(() => {
    const syncPlaybackSnapshot = (nextSnapshot: TransportSnapshot | null) => {
      const previousSnapshot = snapshotRef.current;
      snapshotRef.current = nextSnapshot;

      if (!nextSnapshot) {
        playbackVisualAnchorRef.current = {
          anchorPositionSeconds: 0,
          anchorReceivedAtMs: performance.now(),
          durationSeconds: timelineDurationSecondsRef.current || songDurationSecondsRef.current,
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

      const shouldPreserveVisualAnchor =
        !anchorMeta &&
        previousSnapshot?.playbackState === "playing" &&
        nextSnapshot.playbackState === "playing" &&
        previousSnapshot.projectRevision === nextSnapshot.projectRevision &&
        playbackVisualAnchorRef.current.running &&
        Boolean(nextSnapshot.transportClock?.running);

      if (shouldPreserveVisualAnchor) {
        const polledAnchorPosition =
          nextSnapshot.transportClock?.anchorPositionSeconds ?? nextSnapshot.positionSeconds;
        const visualDriftSeconds = Math.abs(resolveCurrentVisualPosition() - polledAnchorPosition);

        if (visualDriftSeconds <= PLAYBACK_SNAPSHOT_REANCHOR_TOLERANCE_SECONDS) {
          return;
        }
      }

      applyTransportVisualAnchor(nextSnapshot, anchorMeta);
    };

    syncPlaybackSnapshot(useTransportStore.getState().playback);

    return useTransportStore.subscribe((state) => state.playback, syncPlaybackSnapshot);
  }, []);

  useEffect(() => {
    let active = true;

    void refreshAudioSettings()
      .catch((error) => {
        if (!active) {
          return;
        }
        setStatus(formatErrorStatus(error));
      })
      .finally(() => {
        if (active) {
          setIsSettingsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [refreshAudioSettings]);

  useEffect(() => {
    if (!isSettingsModalOpen && !isRemoteModalOpen) {
      return () => {};
    }

    let active = true;
    void Promise.all([getAudioOutputDevices(), getMidiInputs()])
      .then(([nextAudioDevices, nextMidiInputs]) => {
        if (!active) {
          return;
        }
        setAudioOutputDevices(nextAudioDevices.devices);
        setDefaultAudioOutputDevice(nextAudioDevices.defaultDevice ?? null);
        setMidiInputDevices(nextMidiInputs);
      })
      .catch((error) => {
        if (active) {
          setStatus(formatErrorStatus(error));
        }
      });

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsSettingsModalOpen(false);
        setIsRemoteModalOpen(false);
      }
    };

    window.addEventListener("keydown", handleWindowKeyDown);
    return () => {
      active = false;
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  }, [isRemoteModalOpen, isSettingsModalOpen]);

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
          ? t("transport.status.readyDesktop")
          : t("transport.status.readyDemo"),
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
      const paneWidth = rulerTrackRef.current?.clientWidth ?? laneAreaRef.current?.clientWidth ?? null;
      const fallbackWidth = Math.max(
        320,
        (timelineScrollViewportRef.current?.clientWidth ?? shell.clientWidth ?? DEFAULT_TIMELINE_VIEWPORT_WIDTH) -
          HEADER_WIDTH,
      );
      setTimelineViewportWidth(Math.max(320, paneWidth ?? fallbackWidth));
    };

    updateViewportWidth();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(updateViewportWidth);
      observer.observe(shell);
      if (timelineScrollViewportRef.current) {
        observer.observe(timelineScrollViewportRef.current);
      }
      if (rulerTrackRef.current) {
        observer.observe(rulerTrackRef.current);
      }
      if (laneAreaRef.current) {
        observer.observe(laneAreaRef.current);
      }
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
        setLibraryFolders([]);
        setLibraryClipPreview([]);
        return;
      }

      setLibraryAssets([]);
      setLibraryFolders([]);
      setLibraryClipPreview([]);
      setIsLibraryLoading(true);
      try {
        const { assets, folders } = await loadLibraryState();
        if (!active) {
          return;
        }

        setLibraryAssets(assets);
        setLibraryFolders(folders);
      } catch (error) {
        if (active) {
          setStatus(formatErrorStatus(error));
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
  }, [loadLibraryState, playbackSongDir, song?.id]);

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

    setTempoDraft(String(getSongBaseBpm(song)));
  }, [song, song?.projectRevision]);

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
    libraryDragHoverRef.current = null;
    activeLibraryDragPayloadRef.current = null;
    stopLibraryDragAutoScroll();
    setLibraryClipPreview([]);
  }, [song?.projectRevision, song?.tracks.length, song?.clips.length]);

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
      const nextPositionSeconds = anchor.anchorPositionSeconds + elapsedSeconds;

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
            setStatus(t("transport.status.playbackPaused"));
            return;
          }

          const nextSnapshot = await playTransport();
          applyPlaybackSnapshot(nextSnapshot);
          setStatus(t("transport.status.playbackStarted"));
        });
        return;
      }

      const target = event.target as HTMLElement | null;
      const isTypingTarget = isTextEntryTarget(event.target) || target?.tagName === "SELECT";

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
          setStatus(event.shiftKey ? t("transport.status.actionRedone") : t("transport.status.actionUndone"));
        });
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        void runAction(async () => {
          const nextSnapshot = await redoAction();
          applyPlaybackSnapshot(nextSnapshot);
          setStatus(t("transport.status.actionRedone"));
        });
        return;
      }

      const keyDigit = keyboardDigit(event.code);
      if (keyDigit !== null) {
        event.preventDefault();

        if (event.shiftKey) {
          const region = song ? resolveRegionShortcut(song.regions, keyDigit) : null;
          if (!region) {
            setStatus(t("transport.status.noSongForDigit", { digit: keyDigit }));
            return;
          }

          void runAction(async () => {
            await scheduleRegionJumpWithOptions(region.id, region.name);
          });
          return;
        }

        const marker = song ? resolveMarkerShortcut(song.sectionMarkers, keyDigit) : null;
        if (!marker) {
          setStatus(t("transport.status.noMarkerForDigit", { digit: keyDigit }));
          return;
        }

        void runAction(async () => {
          const pendingJump = snapshotRef.current?.pendingMarkerJump;
          if (pendingJump && pendingJump.targetMarkerId === marker.id) {
            const nextSnapshot = await cancelMarkerJump();
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(t("transport.status.jumpCancelledDigit", { digit: keyDigit }));
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
            setStatus(t("transport.status.jumpCancelled"));
          });
          return;
        }

        clearSelections(t("transport.status.selectionsCleared"));
        return;
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        if (isTextEntryTarget(event.target)) {
          return;
        }

        event.preventDefault();

        if (selectedClipId) {
          void runAction(async () => {
            const nextSnapshot = await deleteClip(selectedClipId);
            applyPlaybackSnapshot(nextSnapshot);
            setSelectedClipId(null);
            setStatus(t("transport.status.clipDeleted"));
          });
        } else if (selectedTrackIds.length > 0) {
          void runAction(async () => {
            let lastSnapshot: TransportSnapshot | null = null;
            for (const trackId of selectedTrackIds) {
              lastSnapshot = await deleteTrack(trackId);
            }
            if (lastSnapshot) {
              applyPlaybackSnapshot(lastSnapshot);
            }
            clearSelection();
            setStatus(t("transport.status.tracksDeleted", { count: selectedTrackIds.length }));
          });
        }
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
    scheduleRegionJumpWithOptions,
    selectedClipId,
    selectedTrackIds,
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
        const timingRegion =
          getSongTempoRegionAtPosition(effectSong, clipDrag.originSeconds + deltaSeconds);
        const nextSeconds = snapEnabled
          ? snapToTimelineGrid(
              clipDrag.originSeconds + deltaSeconds,
              timingRegion?.bpm ?? effectSong.bpm,
              timingRegion?.timeSignature ?? effectSong.timeSignature,
              zoomLevel,
              effectPixelsPerSecond,
              buildSongTempoRegions(effectSong),
            )
          : clipDrag.originSeconds + deltaSeconds;

        const nextDrag = {
          ...clipDrag,
          hasMoved: clipDrag.hasMoved || exceededThreshold,
          previewSeconds: clamp(nextSeconds, 0, effectSong.durationSeconds),
        };
        clipDragRef.current = nextDrag;
        clipPreviewSecondsRef.current = { [nextDrag.clipId]: nextDrag.previewSeconds };
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
            setStatus(t("transport.status.clipMoved", { name: clip?.trackName ?? activeClipDrag.clipId }));
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
      options?.pixelsPerSecond ?? livePixelsPerSecondRef.current,
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
    const durationSeconds = options?.durationSeconds
      ?? timelineDurationSecondsRef.current
      ?? songRef.current?.durationSeconds
      ?? 0;
    const clampedPosition = clamp(positionSeconds, 0, durationSeconds || Number.MAX_SAFE_INTEGER);
    const timingRegion = getSongTempoRegionAtPosition(songRef.current, clampedPosition);
    const displayedTempo = timingRegion?.bpm ?? getSongBaseBpm(songRef.current);

    displayPositionSecondsRef.current = clampedPosition;

    if (transportReadoutTempoRef.current) {
      transportReadoutTempoRef.current.textContent = `${displayedTempo.toFixed(2)} BPM`;
    }

    if (transportReadoutValueRef.current) {
      transportReadoutValueRef.current.textContent = formatClock(clampedPosition);
    }

    if (transportReadoutBarRef.current) {
      transportReadoutBarRef.current.textContent = formatMusicalPosition(
        clampedPosition,
        songRef.current,
      );
    }
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
    const durationSeconds = options?.durationSeconds ?? songRef.current?.durationSeconds ?? 0;
    const contentEndSeconds = options?.contentEndSeconds ?? timelineContentEndSeconds;
    const effectivePixelsPerSecond = options?.pixelsPerSecond ?? livePixelsPerSecondRef.current;
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
    if (horizontalScrollbar && Math.abs(horizontalScrollbar.scrollLeft - clampedCameraX) > 0.5) {
      horizontalScrollbar.scrollLeft = clampedCameraX;
    }

    if (options?.syncPlayhead !== false) {
      syncLivePosition(playheadDragRef.current?.currentSeconds ?? displayPositionSecondsRef.current, {
        cameraX: clampedCameraX,
        durationSeconds: timelineDurationSecondsRef.current || durationSeconds,
        pixelsPerSecond: effectivePixelsPerSecond,
        viewportWidth,
      });
    }

    return clampedCameraX;
  }

  function commitCameraXToStore(nextCameraX: number) {
    updateCameraX(nextCameraX, {
      commitToStore: true,
    });
  }

  function previewSeek(positionSeconds: number) {
    const durationSeconds = timelineDurationSecondsRef.current || song?.durationSeconds || 0;
    const clampedPosition = clamp(positionSeconds, 0, durationSeconds || Number.MAX_SAFE_INTEGER);

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
      durationSeconds: timelineDurationSecondsRef.current || songDurationSecondsRef.current,
      running: false,
    };
    syncLivePosition(0);
  }

  async function performSeek(positionSeconds: number) {
    previewSeek(positionSeconds);

    try {
      const nextSnapshot = await seekTransport(positionSeconds);
      applyPlaybackSnapshot(nextSnapshot);
      setStatus(t("transport.status.cursorMoved", { time: formatClock(nextSnapshot.positionSeconds) }));
    } catch (error) {
      restoreConfirmedTransportVisual();
      throw error;
    }
  }

  function normalizeTimelineSeekSeconds(
    positionSeconds: number,
    durationSeconds = timelineDurationSecondsRef.current || song?.durationSeconds || 0,
  ) {
    const clampedPosition = clamp(positionSeconds, 0, Math.max(0, durationSeconds));
    const timingRegion = getSongTempoRegionAtPosition(song, clampedPosition);

    return snapEnabled
      ? clamp(
          snapToTimelineGrid(
            clampedPosition,
            timingRegion?.bpm ?? songBaseBpm,
            timingRegion?.timeSignature ?? songBaseTimeSignature,
            zoomLevel,
            pixelsPerSecond,
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

  function snappedRulerSecondsAtClientX(clientX: number, durationSeconds: number) {
    const rulerTrack = rulerTrackRef.current;
    if (!rulerTrack) {
      return 0;
    }

    return normalizeTimelineSeekSeconds(
      rulerClientXToSeconds(clientX, rulerTrack, getCameraX(), durationSeconds, pixelsPerSecond),
      durationSeconds,
    );
  }

  const laneViewportWidth = Math.max(320, timelineViewportWidth);
  const timelineFitViewportWidth = Math.max(
    320,
    laneViewportWidth - Math.min(TIMELINE_FIT_RIGHT_GUTTER_PX, laneViewportWidth * 0.16),
  );
  const timelineContentEndSeconds = useMemo(() => {
    if (!song) {
      return 0;
    }

    let furthestContentSeconds = song.durationSeconds;
    for (const clip of song.clips) {
      furthestContentSeconds = Math.max(
        furthestContentSeconds,
        clip.timelineStartSeconds + clip.durationSeconds,
      );
    }
    for (const marker of song.sectionMarkers) {
      furthestContentSeconds = Math.max(furthestContentSeconds, marker.startSeconds);
    }

    return furthestContentSeconds;
  }, [song]);
  const workspaceDurationSeconds = getTimelineWorkspaceEndSeconds(
    song?.durationSeconds ?? 0,
    timelineContentEndSeconds,
  );
  const fitAllZoomLevel = timelineContentEndSeconds
    ? clamp(
        timelineFitViewportWidth / (Math.max(timelineContentEndSeconds, 1) * BASE_PIXELS_PER_SECOND),
        ZOOM_MIN,
        ZOOM_MAX,
      )
    : ZOOM_MIN;
  const effectiveZoomMin = ZOOM_MIN;
  const pixelsPerSecond = zoomLevel * BASE_PIXELS_PER_SECOND;
  const liveZoomLevelRef = useRef(zoomLevel);
  const livePixelsPerSecondRef = useRef(pixelsPerSecond);
  const maxTimelineCameraX = getMaxCameraX(
    song?.durationSeconds ?? 0,
    pixelsPerSecond,
    laneViewportWidth,
    timelineContentEndSeconds,
  );
  const pendingMarkerJump = pendingMarkerJumpSignature
    ? snapshotRef.current?.pendingMarkerJump ?? null
    : null;
  const activeVamp = snapshotRef.current?.activeVamp ?? null;
  const renderedClipsByTrack = useMemo(
    () => mergeOptimisticClipsByTrack(clipsByTrack, optimisticClipOperations),
    [clipsByTrack, optimisticClipOperations],
  );
  const readoutPositionSeconds = displayPositionSecondsRef.current;
  const readoutTempoRegion = getSongTempoRegionAtPosition(song, readoutPositionSeconds);
  const songBaseBpm = getSongBaseBpm(song);
  const songBaseTimeSignature = getSongBaseTimeSignature(song);
  const displayedBpm = readoutTempoRegion?.bpm ?? songBaseBpm;
  const musicalPositionLabel = song
    ? formatMusicalPosition(readoutPositionSeconds, song)
    : "1.1.00";
  const tempoSourceLabel = readoutTempoRegion
    ? t("transport.tempoSource.at", { time: formatClock(readoutTempoRegion.startSeconds) })
    : t("transport.tempoSource.base");
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
            : t("transport.preview.newTrack"),
        meta:
          previews.length === 1
            ? t("transport.preview.dropToCreateTrack")
            : t("transport.preview.clipsOnNewTrack", { count: previews.length }),
      }));
  }, [libraryClipPreview, t]);

  useEffect(() => {
    timelineDurationSecondsRef.current = workspaceDurationSeconds;
  }, [workspaceDurationSeconds]);

  const timelineGrid = useTimelineGrid({
    durationSeconds: workspaceDurationSeconds,
    bpm: songBaseBpm,
    regions: buildSongTempoRegions(song),
    timeSignature: songBaseTimeSignature,
    zoomLevel,
    pixelsPerSecond,
    viewportStartSeconds: 0,
    viewportEndSeconds: workspaceDurationSeconds,
  });

  async function scheduleMarkerJumpWithGlobalMode(markerId: string, markerName: string) {
    const trigger = appSettings.globalJumpMode;
    const bars = Math.max(1, Math.floor(appSettings.globalJumpBars));
    const nextSnapshot = await scheduleMarkerJump(markerId);
    applyPlaybackSnapshot(nextSnapshot);

    if (trigger === "next_marker" && !nextSnapshot.pendingMarkerJump) {
      setStatus(t("transport.status.noMarkersAhead"));
      return nextSnapshot;
    }

    setStatus(
      trigger === "immediate"
        ? t("transport.status.jumpImmediate", { name: markerName })
        : trigger === "next_marker"
          ? t("transport.status.jumpNextMarker", { name: markerName })
          : t("transport.status.jumpAfterBars", { count: bars, name: markerName }),
    );

    return nextSnapshot;
  }

  async function scheduleRegionJumpWithOptions(regionId: string, regionName: string) {
    const trigger = appSettings.songJumpTrigger;
    const bars = Math.max(1, Math.floor(appSettings.songJumpBars));
    const transition = appSettings.songTransitionMode;
    const nextSnapshot = await scheduleRegionJump(regionId);
    applyPlaybackSnapshot(nextSnapshot);

    if (trigger === "region_end" && !nextSnapshot.pendingMarkerJump) {
      setStatus(t("transport.status.noSongRegionAtCursor"));
      return nextSnapshot;
    }

    const whenLabel =
      trigger === "immediate"
        ? t("transport.jumpMode.immediate")
        : trigger === "region_end"
          ? t("transport.jumpMode.regionEnd")
          : t("transport.jumpMode.afterBars", { count: bars });
    const howLabel =
      transition === "fade_out"
        ? t("timelineToolbar.songTransitionFadeOut")
        : t("timelineToolbar.songTransitionInstant");

    setStatus(t("transport.status.songJumpScheduled", {
      name: regionName,
      when: whenLabel,
      how: howLabel,
    }));

    return nextSnapshot;
  }

  async function handleNextSongClick() {
    if (!song || song.regions.length === 0) {
      return;
    }

    const currentPosition = snapshotRef.current?.positionSeconds ?? displayPositionSecondsRef.current;
    const nextRegion = song.regions.find((region) => region.startSeconds > currentPosition + Number.EPSILON)
      ?? song.regions[0];

    if (!nextRegion) {
      return;
    }

    await scheduleRegionJumpWithOptions(nextRegion.id, nextRegion.name);
  }

  async function toggleTimelineVamp() {
    const mode = appSettings.vampMode;
    const nextSnapshot = await toggleVamp(mode, mode === "bars" ? appSettings.vampBars : undefined);
    applyPlaybackSnapshot(nextSnapshot);

    setStatus(
      nextSnapshot.activeVamp
        ? mode === "bars"
          ? t("transport.status.vampBarsEnabled", { count: appSettings.vampBars })
          : t("transport.status.vampSectionEnabled")
        : t("transport.status.vampDisabled"),
    );

    return nextSnapshot;
  }

  async function handleMarkerPrimaryAction(section: SectionMarkerSummary) {
    selectSection(section.id);
    setSelectedRegionId(null);
    setContextMenu(null);

    if (snapshotRef.current?.pendingMarkerJump?.targetMarkerId === section.id) {
      const nextSnapshot = await cancelMarkerJump();
      applyPlaybackSnapshot(nextSnapshot);
      setStatus(t("transport.status.jumpCancelledSection", { name: section.name }));
      return;
    }

    await scheduleMarkerJumpWithGlobalMode(section.id, section.name);
  }

  useEffect(() => {
    setZoomLevel((current) => (current < effectiveZoomMin ? effectiveZoomMin : current));
  }, [effectiveZoomMin]);

  useEffect(() => {
    if (!song) {
      viewportFitStateRef.current = {
        projectIdentity: null,
        hadClips: false,
      };
      return;
    }

    const projectIdentity = playbackSongDir ? `${playbackSongDir}::${song.id}` : song.id;
    const hadClips = viewportFitStateRef.current.projectIdentity === projectIdentity
      ? viewportFitStateRef.current.hadClips
      : false;
    const hasClips = song.clips.length > 0;
    const shouldFitViewport =
      laneViewportWidth > 0 && (viewportFitStateRef.current.projectIdentity !== projectIdentity || (!hadClips && hasClips));

    viewportFitStateRef.current = {
      projectIdentity,
      hadClips: hasClips,
    };

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
  }, [fitAllZoomLevel, laneViewportWidth, playbackSongDir, setZoomLevel, song, timelineContentEndSeconds]);

  useEffect(() => {
    liveZoomLevelRef.current = zoomLevel;
    livePixelsPerSecondRef.current = pixelsPerSecond;
  }, [pixelsPerSecond, zoomLevel]);

  useEffect(() => {
    if (zoomDebounceTimerRef.current === null || Math.abs(cameraXRef.current - cameraX) <= 0.5) {
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
    syncLivePosition(playheadDragRef.current?.currentSeconds ?? displayPositionSecondsRef.current);
  }, [
    pixelsPerSecond,
    song?.projectRevision,
    song?.durationSeconds,
    songBaseBpm,
    songBaseTimeSignature,
  ]);

  function clearSelections(message: string) {
    clearSelection();
    setSelectedRegionId(null);
    setSelectedTimelineRange(null);
    setContextMenu(null);
    setStatus(message);
  }

  function rulerContextMenu(
    positionSeconds: number,
    timelineRange: TimelineRangeSelection | null,
  ): ContextMenuAction[] {
    return [
      {
        label: timelineRange ? t("transport.menu.createSongRegionFromSelection") : t("transport.menu.createMarker"),
        onSelect: async () => {
          await runAction(async () => {
            const nextSnapshot = timelineRange
              ? await createSongRegion(timelineRange.startSeconds, timelineRange.endSeconds)
              : await createSectionMarker(positionSeconds);
            applyPlaybackSnapshot(nextSnapshot);
            clearSelection();
            setSelectedRegionId(null);
            setSelectedTimelineRange(null);
            setStatus(
              timelineRange
                ? t("transport.status.songCreatedInRange", {
                    start: formatClock(timelineRange.startSeconds),
                    end: formatClock(timelineRange.endSeconds),
                  })
                : t("transport.status.markerCreatedAt", { time: formatClock(positionSeconds) }),
            );
          });
        },
      },
      {
        label: t("transport.menu.changeTimelineBpm"),
        disabled: !song,
        onSelect: async () => {
          const nextBpm = Number(window.prompt(t("transport.prompt.timelineBpm"), songBaseBpm.toFixed(2)));
          if (!Number.isFinite(nextBpm) || nextBpm <= 0) {
            return;
          }

          await runAction(async () => {
            const nextSnapshot = positionSeconds <= 0.0001
              ? await updateSongTempo(nextBpm)
              : await upsertSongTempoMarker(positionSeconds, nextBpm);
            applyPlaybackSnapshot(nextSnapshot);
            setTempoDraft(String(nextBpm));
            setStatus(
              positionSeconds <= 0.0001
                ? t("transport.status.baseTimelineBpmUpdated", { bpm: nextBpm.toFixed(2) })
                : t("transport.status.tempoMarkerCreated", {
                    time: formatClock(positionSeconds),
                    bpm: nextBpm.toFixed(2),
                  }),
            );
          });
        },
      },
      {
        label: t("transport.menu.clearTimelineSelection"),
        disabled: !timelineRange,
        onSelect: () => {
          setSelectedTimelineRange(null);
          setStatus(t("transport.status.timelineSelectionCleared"));
        },
      },
    ];
  }

  function songRegionContextMenu(region: SongRegionSummary) {
    return [
      {
        label: t("transport.menu.renameSong"),
        onSelect: async () => {
          const nextName = window.prompt(t("transport.prompt.songRename"), region.name)?.trim();
          if (!nextName) {
            return;
          }

          await runAction(async () => {
            const nextSnapshot = await updateSongRegion(
              region.id,
              nextName,
              region.startSeconds,
              region.endSeconds,
            );
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(t("transport.status.songRenamed", { name: nextName }));
          });
        },
      },
      {
        label: t("transport.menu.changeBpm"),
        disabled: true,
        onSelect: () => {},
      },
      {
        label: t("transport.menu.deleteSong"),
        onSelect: async () => {
          await runAction(async () => {
            const nextSnapshot = await deleteSongRegion(region.id);
            applyPlaybackSnapshot(nextSnapshot);
            setSelectedRegionId(null);
            setStatus(t("transport.status.songDeleted", { name: region.name }));
          });
        },
      },
    ];
  }

  function tempoMarkerContextMenu(marker: TempoMarkerSummary) {
    return [
      {
        label: t("transport.menu.changeBpm"),
        onSelect: async () => {
          const nextBpm = Number(window.prompt(t("transport.prompt.tempoMarkerBpm"), marker.bpm.toFixed(2)));
          if (!Number.isFinite(nextBpm) || nextBpm <= 0) {
            return;
          }

          await runAction(async () => {
            const nextSnapshot = await upsertSongTempoMarker(marker.startSeconds, nextBpm);
            applyPlaybackSnapshot(nextSnapshot);
            setTempoDraft(String(nextBpm));
            setStatus(t("transport.status.tempoMarkerUpdated", { bpm: nextBpm.toFixed(2) }));
          });
        },
      },
      {
        label: t("transport.menu.deleteMarker"),
        onSelect: async () => {
          await runAction(async () => {
            const nextSnapshot = await deleteSongTempoMarker(marker.id);
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(t("transport.status.tempoMarkerDeleted", { time: formatClock(marker.startSeconds) }));
          });
        },
      },
    ];
  }

  function previewZoom(
    nextZoomLevel: number,
    anchorViewportX = laneViewportWidth / 2,
    options?: {
      scheduleCommit?: boolean;
    },
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

    const nextView = {
      cameraX: clampedCameraX,
      zoomLevel: clampedZoom,
    };

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
    previewZoom(nextZoomLevel, anchorViewportX, {
      scheduleCommit: true,
    });
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
    setTrackHeight(clamp(Math.round(nextTrackHeight), TRACK_HEIGHT_MIN, TRACK_HEIGHT_MAX));
  }

  function handleTrackHeadersWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (event.defaultPrevented) {
      return;
    }

    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      applyTrackHeight(trackHeight + (event.deltaY < 0 ? TRACK_HEIGHT_STEP : -TRACK_HEIGHT_STEP));
      return;
    }

    const shouldScrollHorizontally = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
    if (!shouldScrollHorizontally) {
      return;
    }

    event.preventDefault();
    updateCameraX(cameraXRef.current + event.deltaX + (event.shiftKey ? event.deltaY : 0), {
      commitToStore: false,
    });
  }

  async function handleTrackDrop(draggedTrackId: string, dropState: NonNullable<TrackDropState>) {
    const targetTrack = tracksById[dropState.targetTrackId] ?? null;
    if (!song || !targetTrack || draggedTrackId === targetTrack.id) {
      return;
    }

    const tracksToMove =
      selectedTrackIds.includes(draggedTrackId) && selectedTrackIds.length > 1
        ? selectedTrackIds
        : [draggedTrackId];

    await runAction(async () => {
      let lastSnapshot: TransportSnapshot | null = null;
      for (const trackId of tracksToMove) {
        if (trackId === targetTrack.id) {
          continue;
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

        lastSnapshot = await moveTrack(moveArgs);
      }

      if (lastSnapshot) {
        applyPlaybackSnapshot(lastSnapshot);
      }
      await refreshSongView();
      setStatus(t("transport.status.tracksReordered", { count: tracksToMove.length }));
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
    const defaultName = kind === "folder"
      ? t("transport.defaults.folderTrackName")
      : t("transport.defaults.audioTrackName");
    const name = window.prompt(t("transport.prompt.trackName"), defaultName)?.trim();
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
      await refreshSongView();
      setStatus(t("transport.status.trackCreated", { name }));
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
        label: t("transport.menu.insertTrack"),
        onSelect: () => handleCreateTrack("audio", track, track.parentTrackId ?? null),
      },
      {
        label: t("transport.menu.insertFolderTrack"),
        onSelect: () => handleCreateTrack("folder", track, track.parentTrackId ?? null),
      },
      {
        label: t("common.rename"),
        onSelect: async () => {
          const nextName = window.prompt(t("transport.prompt.trackRename"), track.name)?.trim();
          if (!nextName) {
            return;
          }
          await runAction(async () => {
            const nextSnapshot = await updateTrack({ trackId: track.id, name: nextName });
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(t("transport.status.trackRenamed", { name: nextName }));
          });
        },
      },
      {
        label: t("common.delete"),
        onSelect: async () => {
          const clipCount = currentSong.clips.filter((clip) => clip.trackId === track.id).length;
          if (
            track.kind === "audio" &&
            clipCount > 0 &&
            !window.confirm(t("transport.confirm.deleteTrackWithClips"))
          ) {
            return;
          }

          await runAction(async () => {
            const nextSnapshot = await deleteTrack(track.id);
            applyPlaybackSnapshot(nextSnapshot);
            clearLibraryDragPreview();
            await refreshSongView();
            setStatus(t("transport.status.trackDeleted", { name: track.name }));
          });
        },
      },
      {
        label: t("transport.menu.indentIntoPreviousFolder"),
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
            await refreshSongView();
            setStatus(t("transport.status.trackMovedIntoFolder", { name: previousFolder.name }));
          });
        },
      },
      {
        label: t("transport.menu.removeFromFolder"),
        disabled: !track.parentTrackId,
        onSelect: async () => {
          await runAction(async () => {
            const nextSnapshot = await moveTrack({
              trackId: track.id,
              insertAfterTrackId: track.parentTrackId ?? null,
              parentTrackId: parentOfParent,
            });
            applyPlaybackSnapshot(nextSnapshot);
            await refreshSongView();
            setStatus(t("transport.status.trackRemovedFromFolder", { name: track.name }));
          });
        },
      },
    ];
  }

  function globalTrackListContextMenu() {
    return [
      {
        label: t("transport.menu.addAudioTrack"),
        onSelect: () => handleCreateTrack("audio", null, null),
      },
      {
        label: t("transport.menu.addFolderTrack"),
        onSelect: () => handleCreateTrack("folder", null, null),
      },
    ];
  }

  const handleTrackHeaderSelect = useCallback((
    trackId: string,
    trackName: string,
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    if (suppressTrackClickRef.current) {
      suppressTrackClickRef.current = false;
      return;
    }

    const currentSelection = useTimelineUIStore.getState().selectedTrackIds;
    let nextSelection = [trackId];

    if (event.ctrlKey || event.metaKey) {
      nextSelection = currentSelection.includes(trackId)
        ? currentSelection.filter((id) => id !== trackId)
        : [...currentSelection, trackId];
    } else if (event.shiftKey && currentSelection.length > 0) {
      const visibleTrackIds = visibleTracks.map((track) => track.id);
      const lastSelectedIdx = visibleTrackIds.indexOf(currentSelection[currentSelection.length - 1]);
      const currentIdx = visibleTrackIds.indexOf(trackId);

      if (lastSelectedIdx !== -1 && currentIdx !== -1) {
        const start = Math.min(lastSelectedIdx, currentIdx);
        const end = Math.max(lastSelectedIdx, currentIdx);
        const range = visibleTrackIds.slice(start, end + 1);
        nextSelection = [...new Set([...currentSelection, ...range])];
      }
    }

    selectTrack(nextSelection);
    setStatus(
      nextSelection.length > 1
        ? t("transport.status.tracksSelected", { count: nextSelection.length })
        : t("transport.status.trackSelected", { name: trackName }),
    );
  }, [selectTrack, t, visibleTracks]);

  function handleTrackHeaderContextMenu(event: ReactMouseEvent<HTMLDivElement>, trackId: string) {
    const track = findTrack(songRef.current, trackId);
    if (!track) {
      return;
    }

    selectTrack([track.id]);
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
        rowElement: event.currentTarget.closest(".lt-track-header-row") as HTMLDivElement | null,
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
        label: t("transport.menu.splitClipAtCursor"),
        disabled: !canSplit,
        onSelect: async () => {
          await runAction(async () => {
            const nextSnapshot = await splitClip(clip.id, currentCursorSeconds);
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(t("transport.status.clipSplitAt", { time: formatClock(currentCursorSeconds) }));
          });
        },
      },
      {
        label: t("transport.menu.duplicateClip"),
        onSelect: async () => {
          await runAction(async () => {
            const nextSnapshot = await duplicateClip(
              clip.id,
              clip.timelineStartSeconds + clip.durationSeconds + 1,
            );
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(t("transport.status.clipDuplicated", { name: clip.trackName }));
          });
        },
      },
      {
        label: t("common.delete"),
        onSelect: async () => {
          await runAction(async () => {
            const nextSnapshot = await deleteClip(clip.id);
            applyPlaybackSnapshot(nextSnapshot);
            setSelectedClipId(null);
            setStatus(t("transport.status.clipDeleted", { name: clip.trackName }));
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
      selectClip(hitClip.id, track.id);
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

      updateCameraX(activePan.originCameraX + deltaX, {
        commitToStore: false,
      });
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
      selectClip(hitClip.id, track.id);
      openMenu(event, hitClip.trackName, clipContextMenu(hitClip));
      return;
    }

    selectTrack([track.id]);
    openMenu(event, track.name, trackContextMenu(track));
  }

  function handleTrackListContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    if (!songRef.current) {
      return;
    }

    const target = event.target as HTMLElement | null;
    if (target?.closest(".lt-track-lane-row")) {
      return;
    }

    clearSelection();
    setSelectedRegionId(null);
    openMenu(event, "Tracks", globalTrackListContextMenu());
  }

  function sectionContextMenu(section: SectionMarkerSummary) {
    const canEditMarker = Boolean(section);

    return [
      {
        label: t("transport.menu.jumpToMarker"),
        disabled: !canEditMarker,
        onSelect: async () => {
          await runAction(async () => {
            const nextSnapshot = await scheduleMarkerJump(section.id);
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(t("transport.status.markerCursorSent", { name: section.name }));
          });
        },
      },
      {
        label: t("common.rename"),
        disabled: !canEditMarker,
        onSelect: async () => {
          const nextName = window.prompt(t("transport.prompt.markerRename"), section.name)?.trim();
          if (!nextName) {
            return;
          }
          await runAction(async () => {
            const nextSnapshot = await updateSectionMarker(section.id, nextName, section.startSeconds);
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(t("transport.status.markerRenamed", { name: nextName }));
          });
        },
      },
      {
        label: t("common.delete"),
        disabled: !canEditMarker,
        onSelect: async () => {
          await runAction(async () => {
            const nextSnapshot = await deleteSectionMarker(section.id);
            applyPlaybackSnapshot(nextSnapshot);
            setSelectedSectionId(null);
            setStatus(t("transport.status.markerDeleted", { name: section.name }));
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
            ? t("transport.status.projectCreatedAt", { path: nextSnapshot.songFilePath })
            : t("transport.status.projectCreated"),
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
            ? t("transport.status.projectSavedAt", { path: nextSnapshot.songFilePath })
            : t("transport.status.projectSaved"),
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
            ? t("transport.status.projectSavedAt", { path: nextSnapshot.songFilePath })
            : t("transport.status.projectSavedNewLocation"),
        );
      },
      { busy: true },
    );
  }

  function handleSidebarTabToggle(tab: SidebarTab) {
    setActiveSidebarTab((currentTab) => (currentTab === tab ? null : tab));
  }

  function handleSettingsButtonClick() {
    setIsRemoteModalOpen(false);
    setIsSettingsModalOpen((current) => !current);
  }

  function handleRemoteButtonClick() {
    setIsSettingsModalOpen(false);
    setIsRemoteModalOpen((current) => !current);
  }

  function handleMidiLearnToggle(options?: { closePanels?: boolean }) {
    if (options?.closePanels) {
      setIsSettingsModalOpen(false);
      setIsRemoteModalOpen(false);
    }

    setMidiLearnMode(midiLearnMode === null ? "" : null);
  }

  function handleMidiLearnButtonClick() {
    handleMidiLearnToggle({ closePanels: true });
  }

  function handleMidiLearnTarget(controlKey: string) {
    if (midiLearnMode === null) {
      return false;
    }

    setMidiLearnMode(controlKey);
    return true;
  }

  function handleMidiLearnCommandRelearn(controlKey: string) {
    setMidiLearnMode(controlKey);
  }

  function handleResetMidiMappings() {
    persistAudioSettings(
      normalizeAppSettings({
        ...appSettingsRef.current,
        midiMappings: {},
      }),
      t("transport.status.midiMappingsReset"),
    );
    setMidiLearnFeedback(null);
  }

  function handleAudioOutputDeviceChange(nextValue: string) {
    persistAudioSettings(
      {
        ...appSettings,
        selectedOutputDevice: nextValue || null,
      },
      nextValue
        ? t("transport.status.audioDeviceUpdated", { name: nextValue })
        : t("transport.status.audioDeviceSystemDefault"),
    );
  }

  function handleSplitStereoChange(nextValue: boolean) {
    persistAudioSettings(
      {
        ...appSettings,
        splitStereoEnabled: nextValue,
      },
      nextValue
        ? t("transport.status.splitStereoEnabled")
        : t("transport.status.splitStereoDisabled"),
    );
  }

  function handleMetronomeEnabledChange(nextValue: boolean) {
    const nextSettings = normalizeAppSettings({
      ...appSettingsRef.current,
      metronomeEnabled: nextValue,
    });

    appSettingsRef.current = nextSettings;
    setAppSettings(nextSettings);

    void runAction(async () => {
      const liveSettings = normalizeAppSettings(await updateAudioSettings(nextSettings));
      appSettingsRef.current = liveSettings;
      setAppSettings(liveSettings);
      setStatus(
        nextValue
          ? t("transport.status.metronomeEnabled")
          : t("transport.status.metronomeDisabled"),
      );
    });
  }

  function handleMetronomeVolumeDraftChange(nextValue: number) {
    const normalizedValue = Math.max(0, Math.min(1, nextValue));
    const nextSettings = normalizeAppSettings({
      ...appSettingsRef.current,
      metronomeVolume: normalizedValue,
    });
    const requestId = metronomeLiveRequestIdRef.current + 1;

    metronomeLiveRequestIdRef.current = requestId;
    appSettingsRef.current = nextSettings;
    setMetronomeVolumeDraft(normalizedValue);
    setAppSettings(nextSettings);

    void updateAudioSettings(nextSettings)
      .then((liveSettings) => {
        if (metronomeLiveRequestIdRef.current !== requestId) {
          return;
        }

        const normalizedLiveSettings = normalizeAppSettings(liveSettings);
        appSettingsRef.current = normalizedLiveSettings;
        setAppSettings(normalizedLiveSettings);
      })
      .catch((error) => {
        if (metronomeLiveRequestIdRef.current !== requestId) {
          return;
        }

        setStatus(formatErrorStatus(error));
      });
  }

  function commitMetronomeVolumeDraft(nextValue: number) {
    const normalizedValue = Math.max(0, Math.min(1, nextValue));
    const nextSettings = normalizeAppSettings({
      ...appSettingsRef.current,
      metronomeVolume: normalizedValue,
    });

    appSettingsRef.current = nextSettings;
    setMetronomeVolumeDraft(normalizedValue);
    setAppSettings(nextSettings);

    void runAction(async () => {
      try {
        const liveSettings = normalizeAppSettings(await updateAudioSettings(nextSettings));
        appSettingsRef.current = liveSettings;
        setAppSettings(liveSettings);
        setStatus(t("transport.status.metronomeVolumeUpdated", {
          volume: Math.round(liveSettings.metronomeVolume * 100),
        }));
      } catch (error) {
        setStatus(formatErrorStatus(error));
      }
    });
  }

  function handleGlobalJumpModeChange(nextValue: AppSettings["globalJumpMode"]) {
    persistAudioSettings(
      normalizeAppSettings({
        ...appSettingsRef.current,
        globalJumpMode: nextValue,
      }),
      "Jump settings updated.",
    );
  }

  function handleGlobalJumpBarsChange(nextValue: number) {
    persistAudioSettings(
      normalizeAppSettings({
        ...appSettingsRef.current,
        globalJumpBars: Math.max(1, Math.floor(nextValue) || 1),
      }),
      "Jump settings updated.",
    );
  }

  function handleSongJumpTriggerChange(nextValue: AppSettings["songJumpTrigger"]) {
    persistAudioSettings(
      normalizeAppSettings({
        ...appSettingsRef.current,
        songJumpTrigger: nextValue,
      }),
      "Song jump settings updated.",
    );
  }

  function handleSongJumpBarsChange(nextValue: number) {
    persistAudioSettings(
      normalizeAppSettings({
        ...appSettingsRef.current,
        songJumpBars: Math.max(1, Math.floor(nextValue) || 1),
      }),
      "Song jump settings updated.",
    );
  }

  function handleSongTransitionModeChange(nextValue: AppSettings["songTransitionMode"]) {
    persistAudioSettings(
      normalizeAppSettings({
        ...appSettingsRef.current,
        songTransitionMode: nextValue,
      }),
      "Song transition updated.",
    );
  }

  function handleVampModeChange(nextValue: AppSettings["vampMode"]) {
    persistAudioSettings(
      normalizeAppSettings({
        ...appSettingsRef.current,
        vampMode: nextValue,
      }),
      "Vamp settings updated.",
    );
  }

  function handleVampBarsChange(nextValue: number) {
    persistAudioSettings(
      normalizeAppSettings({
        ...appSettingsRef.current,
        vampBars: Math.max(1, Math.floor(nextValue) || 1),
      }),
      "Vamp settings updated.",
    );
  }

  function handleMidiInputDeviceChange(nextValue: string) {
    persistAudioSettings(
      {
        ...appSettings,
        selectedMidiDevice: nextValue || null,
      },
      nextValue
        ? t("transport.status.midiDeviceUpdated", { name: nextValue })
        : t("transport.status.midiDeviceDisabled"),
    );
  }

  function handleLocaleChange(nextValue: string) {
    persistAudioSettings(
      {
        ...appSettings,
        locale: nextValue || null,
      },
      (savedSettings) => savedSettings.locale
        ? i18n.t("transport.status.settingsLanguageUpdated", {
            name: translateLanguageName(savedSettings.locale === "es" ? "es" : "en"),
          })
        : i18n.t("transport.status.settingsLanguageSystem"),
    );
  }

  async function handleImportLibraryAssetsClick() {
    if (!playbackSongDir) {
      setStatus(t("transport.status.importRequiresSession"));
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
      setLibraryFolders(await getLibraryFolders());
      setStatus(t("transport.status.libraryUpdated", { count: assets.length }));
    });
    setIsImportingLibrary(false);
    setLibraryImportProgress(null);
  }

  async function handleDeleteLibraryAssets(assetsToDelete: LibraryAssetSummary[]) {
    const uniqueAssets = [...new Map(assetsToDelete.map((asset) => [asset.filePath, asset])).values()];
    if (!uniqueAssets.length) {
      return;
    }

    const confirmationMessage =
      uniqueAssets.length === 1
        ? t("transport.confirm.deleteLibraryAsset", { name: uniqueAssets[0].fileName })
        : t("transport.confirm.deleteLibraryAssets", { count: uniqueAssets.length });
    if (!window.confirm(confirmationMessage)) {
      return;
    }

    try {
      await runAction(async () => {
        let nextAssets = libraryAssets;
        const deletedFilePaths = new Set(uniqueAssets.map((asset) => asset.filePath));

        for (const asset of uniqueAssets) {
          setDeletingLibraryFilePath(asset.filePath);
          nextAssets = await deleteLibraryAsset(asset.filePath);
        }

        const { folders } = await loadLibraryState();
        setLibraryAssets(nextAssets);
        setLibraryFolders(folders);
        setLibraryClipPreview((current) => current.filter((preview) => !deletedFilePaths.has(preview.filePath)));
        setStatus(
          uniqueAssets.length === 1
            ? t("transport.status.libraryAssetDeleted", { name: uniqueAssets[0].fileName })
            : t("transport.status.libraryAssetsDeleted", { count: uniqueAssets.length }),
        );
      });
    } finally {
      setDeletingLibraryFilePath(null);
    }
  }

  async function handleCreateLibraryFolder() {
    if (!playbackSongDir) {
      setStatus(t("transport.status.createFolderRequiresSession"));
      return;
    }

    const folderPath = window.prompt(
      t("transport.prompt.virtualFolderName"),
      t("transport.defaults.virtualFolderName"),
    );
    if (folderPath === null) {
      return;
    }

    await runAction(async () => {
      const folders = await createLibraryFolder(folderPath);
      setLibraryFolders(folders);
      setStatus(t("transport.status.virtualFolderCreated", {
        name: folderPath.trim() || t("transport.defaults.unnamedFolder"),
      }));
    });
  }

  async function handleMoveLibraryAssets(filePaths: string[], newFolderPath: string | null) {
    const uniqueFilePaths = [...new Set(filePaths)];
    if (!uniqueFilePaths.length) {
      return;
    }

    await runAction(async () => {
      let nextAssets = libraryAssets;

      for (const filePath of uniqueFilePaths) {
        nextAssets = await moveLibraryAsset(filePath, newFolderPath);
      }

      const { folders } = await loadLibraryState();
      setLibraryAssets(nextAssets);
      setLibraryFolders(folders);
      setStatus(
        newFolderPath
          ? t("transport.status.libraryAssetsMoved", { count: uniqueFilePaths.length, name: newFolderPath })
          : t("transport.status.libraryAssetsMovedRoot", { count: uniqueFilePaths.length }),
      );
    });
  }

  async function handleRenameLibraryFolder(folderPath: string) {
    if (!playbackSongDir) {
      setStatus(t("transport.status.renameFolderRequiresSession"));
      return;
    }

    const nextFolderPath = window.prompt(t("transport.prompt.virtualFolderRename"), folderPath);
    if (nextFolderPath === null) {
      return;
    }

    await runAction(async () => {
      const assets = await renameLibraryFolder(folderPath, nextFolderPath);
      const { folders } = await loadLibraryState();
      setLibraryAssets(assets);
      setLibraryFolders(folders);
      setStatus(t("transport.status.virtualFolderRenamed", { from: folderPath, to: nextFolderPath.trim() }));
    });
  }

  async function handleDeleteLibraryFolder(folderPath: string) {
    if (!window.confirm(t("transport.confirm.deleteLibraryFolder", { name: folderPath }))) {
      return;
    }

    await runAction(async () => {
      const assets = await deleteLibraryFolder(folderPath);
      const { folders } = await loadLibraryState();
      setLibraryAssets(assets);
      setLibraryFolders(folders);
      setStatus(t("transport.status.virtualFolderDeleted", { name: folderPath }));
    });
  }

  function resolveDraggedLibraryAsset(filePath: string, durationSeconds: number): LibraryAssetSummary {
    return (
      libraryAssets.find((asset) => asset.filePath === filePath) ?? {
        fileName: libraryAssetFileName(filePath),
        filePath,
        durationSeconds,
        detectedBpm: null,
        folderPath: null,
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
    const timingRegion = getSongTempoRegionAtPosition(song, rawSeconds);

    return snapEnabled
      ? snapToTimelineGrid(
          rawSeconds,
          timingRegion?.bpm ?? songBaseBpm,
          timingRegion?.timeSignature ?? songBaseTimeSignature,
          zoomLevel,
          pixelsPerSecond,
          buildSongTempoRegions(song),
        )
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
    const verticalScrollViewport = timelineScrollViewportRef.current;
    const hoverState = libraryDragHoverRef.current;

    if (!hoverState || (!autoScrollState.horizontalVelocity && !autoScrollState.verticalVelocity)) {
      autoScrollState.frameId = null;
      return;
    }

    if (autoScrollState.horizontalVelocity) {
      updateCameraX(cameraXRef.current + autoScrollState.horizontalVelocity);
    }

    if (verticalScrollViewport && autoScrollState.verticalVelocity) {
      verticalScrollViewport.scrollTop += autoScrollState.verticalVelocity;
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
    const verticalBounds = timelineScrollViewportRef.current?.getBoundingClientRect();

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
    const currentBpm = getSongBaseBpm(currentSong);
    if (
      !currentSong ||
      currentSong.clips.length > 0 ||
      asset.detectedBpm == null ||
      !Number.isFinite(asset.detectedBpm) ||
      Math.abs(asset.detectedBpm - currentBpm) < 0.01
    ) {
      return;
    }

    const shouldUpdateTempo = window.confirm(
      t("transport.confirm.adjustProjectTempo", { bpm: asset.detectedBpm.toFixed(1) }),
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

      selectTrack([targetTrackId]);
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
        selectTrack([selectedTrackId]);
      }
    }

    setSelectedSectionId(null);
    setStatus(
      assets.length === 1
        ? t("transport.status.clipAdded", { name: assets[0].fileName })
        : t("transport.status.clipsAdded", { count: assets.length }),
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

  const selectedAudioOutputDevice = appSettings.selectedOutputDevice ?? "";
  const selectedMidiInputDevice = appSettings.selectedMidiDevice ?? "";
  const selectedLocale = appSettings.locale ?? "";
  const selectedAudioOutputDeviceMissing = Boolean(
    appSettings.selectedOutputDevice && !audioOutputDevices.includes(appSettings.selectedOutputDevice),
  );
  const selectedMidiInputDeviceMissing = Boolean(
    appSettings.selectedMidiDevice && !midiInputDevices.includes(appSettings.selectedMidiDevice),
  );

  return (
    <Profiler id="transport-panel" onRender={handlePanelRender}>
      <div
        className={`lt-daw-shell ${midiLearnMode !== null ? "is-midi-learn-active" : ""}`}
        ref={panelRef}
        onContextMenu={(event) => event.preventDefault()}
      >
      {isBusy ? (
        <div className="busy-overlay" aria-live="polite">
          <div className="busy-overlay-card">
            <strong>{t("transport.shell.busyTitle")}</strong>
            <p>{t("transport.shell.busyDescription")}</p>
          </div>
        </div>
      ) : null}

      <TimelineTopbar
        openTopMenu={openTopMenu}
        menuBarRef={menuBarRef}
        canPersistProject={canPersistProject}
        isProjectEmpty={isProjectEmpty}
        tempoDraft={tempoDraft}
        tempoSourceLabel={tempoSourceLabel}
        displayedBpm={displayedBpm}
        song={song}
        musicalPositionLabel={musicalPositionLabel}
        readoutPositionSecondsLabel={formatClock(readoutPositionSeconds)}
        playbackState={playbackState}
        transportReadoutTempoRef={transportReadoutTempoRef}
        transportReadoutBarRef={transportReadoutBarRef}
        transportReadoutValueRef={transportReadoutValueRef}
        onToggleTopMenu={handleToggleTopMenu}
        onTopMenuAction={handleTopMenuAction}
        onCreateSong={handleCreateSongClick}
        onOpenProject={handleOpenProjectClick}
        onSaveProject={handleSaveProjectClick}
        onSaveProjectAs={handleSaveProjectAsClick}
        onStopTransport={() =>
          void runAction(async () => {
            const nextSnapshot = await stopTransport();
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(t("transport.status.playbackStopped"));
          })
        }
        onPlayTransport={() =>
          void runAction(async () => {
            const nextSnapshot = await playTransport();
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(t("transport.status.playbackStarted"));
          })
        }
        onNextSong={() =>
          void runAction(async () => {
            await handleNextSongClick();
          })
        }
        onPauseTransport={() =>
          void runAction(async () => {
            const nextSnapshot = await pauseTransport();
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(t("transport.status.playbackPaused"));
          })
        }
        metronomeEnabled={appSettings.metronomeEnabled}
        onToggleMetronome={() => handleMetronomeEnabledChange(!appSettings.metronomeEnabled)}
        onTempoDraftChange={setTempoDraft}
        onTempoCommit={() => {
          const nextBpm = Number(tempoDraft);
          const currentBpm = songBaseBpm;

          if (!song || !Number.isFinite(nextBpm) || nextBpm <= 0 || nextBpm === currentBpm) {
            setTempoDraft(String(currentBpm));
            return;
          }

          void runAction(async () => {
            const nextSnapshot = await updateSongTempo(nextBpm);
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(t("transport.status.tempoUpdated", { bpm: nextBpm.toFixed(1) }));
          });
        }}
        midiLearnMode={midiLearnMode}
        onMidiLearnTarget={handleMidiLearnTarget}
      />

      <div className="lt-shell-body">
        <aside className="lt-side-nav" aria-label={t("transport.shell.navigation")}>
          <button
            type="button"
            className={activeSidebarTab === "library" ? "is-active" : ""}
            aria-label={t("transport.shell.library")}
            onClick={() => handleSidebarTabToggle("library")}
          >
            <span className="material-symbols-outlined">library_music</span>
            {t("transport.shell.library")}
          </button>
          <button
            type="button"
            className={isRemoteModalOpen ? "is-active" : ""}
            aria-label={t("transport.shell.remote")}
            onClick={handleRemoteButtonClick}
          >
            <span className="material-symbols-outlined">phonelink</span>
            {t("transport.shell.remote")}
          </button>
          <button
            type="button"
            className={isSettingsModalOpen ? "is-active" : ""}
            aria-label={t("transport.shell.settings")}
            onClick={handleSettingsButtonClick}
          >
            <span className="material-symbols-outlined">settings</span>
            {t("transport.shell.settings")}
          </button>
          <button
            type="button"
            className={midiLearnMode !== null ? "is-active is-midi-learn" : "is-midi-learn"}
            aria-label={t("transport.shell.midiLearn")}
            aria-pressed={midiLearnMode !== null}
            onClick={handleMidiLearnButtonClick}
          >
            <span className="material-symbols-outlined">graphic_eq</span>
            {t("transport.shell.midiLearn")}
          </button>
        </aside>

        <div className="lt-workspace">
      <div className="lt-workspace-body">
      {activeSidebarTab === "library" ? (
        <LibrarySidebarPanel
          assets={libraryAssets}
          folders={libraryFolders}
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
          onCreateFolder={() => {
            void handleCreateLibraryFolder();
          }}
          onMoveAssetsToFolder={(filePaths, folderPath) => {
            void handleMoveLibraryAssets(filePaths, folderPath);
          }}
          onRenameFolder={(folderPath) => {
            void handleRenameLibraryFolder(folderPath);
          }}
          onDeleteFolder={(folderPath) => {
            void handleDeleteLibraryFolder(folderPath);
          }}
          onDeleteRequested={(assets) => {
            void handleDeleteLibraryAssets(assets);
          }}
        />
      ) : null}
      {shouldShowEmptyState ? (
        <div className="lt-empty-state">
          <div className="lt-empty-state-card">
            <span className="lt-empty-state-eyebrow">{t("transport.shell.emptyEyebrow")}</span>
            <h1>{t("transport.shell.emptyTitle")}</h1>
            <p>{t("transport.shell.emptyDescription")}</p>
            <div className="lt-empty-state-actions">
              <button type="button" className="is-primary" onClick={handleCreateSongClick}>{t("common.create")}</button>
              <button type="button" onClick={handleOpenProjectClick}>{t("common.open")}</button>
            </div>
          </div>
        </div>
      ) : (
      <section className="lt-main-stage">
        <TimelineToolbar
          snapEnabled={snapEnabled}
          subdivisionPerBeat={timelineGrid.subdivisionPerBeat}
          globalJumpMode={appSettings.globalJumpMode}
          globalJumpBars={appSettings.globalJumpBars}
          songJumpTrigger={appSettings.songJumpTrigger}
          songJumpBars={appSettings.songJumpBars}
          songTransitionMode={appSettings.songTransitionMode}
          vampMode={appSettings.vampMode}
          vampBars={appSettings.vampBars}
          isVampActive={Boolean(activeVamp)}
          pendingMarkerJumpLabel={
            pendingMarkerJump
              ? t("transport.shell.pendingJump", {
                  markerName: pendingMarkerJump.targetMarkerName,
                  trigger: translateJumpTrigger(pendingMarkerJump.trigger),
                })
              : null
          }
          isProjectEmpty={isProjectEmpty}
          trackCount={song?.tracks.length ?? 0}
          clipCount={song?.clips.length ?? 0}
          markerCount={song?.sectionMarkers.length ?? 0}
          onToggleSnap={toggleSnapEnabled}
          onGlobalJumpModeChange={handleGlobalJumpModeChange}
          onGlobalJumpBarsChange={handleGlobalJumpBarsChange}
          onSongJumpTriggerChange={handleSongJumpTriggerChange}
          onSongJumpBarsChange={handleSongJumpBarsChange}
          onSongTransitionModeChange={handleSongTransitionModeChange}
          onVampModeChange={handleVampModeChange}
          onVampBarsChange={handleVampBarsChange}
          onToggleVamp={() =>
            void runAction(async () => {
              await toggleTimelineVamp();
            })
          }
          onCancelPendingJump={() =>
            void runAction(async () => {
              const nextSnapshot = await cancelMarkerJump();
              applyPlaybackSnapshot(nextSnapshot);
              setStatus(t("transport.status.jumpCancelled"));
            })
          }
          midiLearnMode={midiLearnMode}
          onMidiLearnTarget={handleMidiLearnTarget}
        />

        <div className="lt-timeline-shell" ref={timelineShellRef}>
          <div className="lt-timeline-scroll-viewport" ref={timelineScrollViewportRef}>
            <div className="lt-timeline-main-grid">
              <TrackHeadersPane
                song={song}
                visibleTracks={visibleTracks}
                selectedTrackIds={selectedTrackIds}
                trackHeight={trackHeight}
                collapsedFolders={collapsedFolders}
                previewTrackDensityClass={previewTrackDensityClass}
                libraryPreviewRows={libraryPreviewRows}
                shouldShowEmptyArrangementHint={shouldShowEmptyArrangementHint}
                onHeadersWheel={handleTrackHeadersWheel}
                getTrackChildCount={(trackId) => (song ? trackChildrenCount(song, trackId) : 0)}
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

              <TimelineCanvasPane
                laneViewportWidth={laneViewportWidth}
                trackHeight={trackHeight}
                song={song}
                visibleTracks={visibleTracks}
                renderedClipsByTrack={renderedClipsByTrack}
                clipsByTrack={clipsByTrack}
                waveformCache={waveformCache}
                cameraXRef={cameraXRef}
                pixelsPerSecond={pixelsPerSecond}
                livePixelsPerSecondRef={livePixelsPerSecondRef}
                timelineGrid={timelineGrid}
                selectedTimelineRange={selectedTimelineRange}
                selectedClipId={selectedClipId}
                selectedRegionId={selectedRegionId}
                selectedSectionId={selectedSectionId}
                pendingMarkerJump={pendingMarkerJump}
                activeVamp={activeVamp}
                displayPositionSecondsRef={displayPositionSecondsRef}
                playheadDragRef={playheadDragRef}
                clipPreviewSecondsRef={clipPreviewSecondsRef}
                playheadDurationSeconds={workspaceDurationSeconds}
                rulerTrackRef={rulerTrackRef}
                horizontalScrollbarRef={horizontalScrollbarRef}
                laneAreaRef={laneAreaRef}
                scrollViewportRef={timelineScrollViewportRef}
                libraryClipPreview={libraryClipPreview}
                libraryPreviewRows={libraryPreviewRows}
                shouldShowEmptyArrangementHint={shouldShowEmptyArrangementHint}
                normalizePositionSeconds={(positionSeconds) =>
                  normalizeTimelineSeekSeconds(positionSeconds, workspaceDurationSeconds)}
                resolveLibraryGhostLeft={resolveLibraryGhostLeft}
                onRulerMouseDown={(event) => {
                  if (!song || event.button !== 0 || !rulerTrackRef.current) {
                    return;
                  }

                  event.preventDefault();
                  const seekStartSeconds = snappedRulerSeconds(event, workspaceDurationSeconds);
                  const startSeconds = snappedRulerSeconds(event, workspaceDurationSeconds);
                  clearSelection();
                  setSelectedRegionId(null);
                  setContextMenu(null);
                  setSelectedTimelineRange({
                    startSeconds,
                    endSeconds: startSeconds,
                  });

                  const startClientX = event.clientX;
                  let hasMoved = false;
                  let autoScrollFrameId: number | null = null;
                  let autoScrollVelocity = 0;
                  let latestClientX = startClientX;

                  const stopRangeAutoScroll = () => {
                    autoScrollVelocity = 0;
                    if (autoScrollFrameId !== null) {
                      window.cancelAnimationFrame(autoScrollFrameId);
                      autoScrollFrameId = null;
                    }
                  };

                  const updateRangeSelection = (clientX: number) => {
                    const currentSeconds = snappedRulerSecondsAtClientX(clientX, workspaceDurationSeconds);
                    setSelectedTimelineRange({
                      startSeconds: Math.min(startSeconds, currentSeconds),
                      endSeconds: Math.max(startSeconds, currentSeconds),
                    });
                  };

                  const tickRangeAutoScroll = () => {
                    if (!autoScrollVelocity) {
                      autoScrollFrameId = null;
                      return;
                    }

                    updateCameraX(cameraXRef.current + autoScrollVelocity, {
                      commitToStore: false,
                    });
                    updateRangeSelection(latestClientX);
                    autoScrollFrameId = window.requestAnimationFrame(tickRangeAutoScroll);
                  };

                  const updateRangeAutoScroll = (clientX: number) => {
                    const bounds = rulerTrackRef.current?.getBoundingClientRect();
                    if (!bounds) {
                      stopRangeAutoScroll();
                      return;
                    }

                    const distanceToLeft = clientX - bounds.left;
                    const distanceToRight = bounds.right - clientX;
                    if (distanceToLeft < LIBRARY_DRAG_EDGE_BUFFER_PX) {
                      autoScrollVelocity = -resolveLibraryAutoScrollVelocity(distanceToLeft);
                    } else if (distanceToRight < LIBRARY_DRAG_EDGE_BUFFER_PX) {
                      autoScrollVelocity = resolveLibraryAutoScrollVelocity(distanceToRight);
                    } else {
                      autoScrollVelocity = 0;
                    }

                    if (!autoScrollVelocity) {
                      stopRangeAutoScroll();
                      return;
                    }

                    if (autoScrollFrameId === null) {
                      autoScrollFrameId = window.requestAnimationFrame(tickRangeAutoScroll);
                    }
                  };

                  const onMouseMove = (windowEvent: MouseEvent) => {
                    const exceededThreshold = Math.abs(windowEvent.clientX - startClientX) > DRAG_THRESHOLD_PX;
                    if (!hasMoved && !exceededThreshold) {
                      return;
                    }

                    hasMoved = true;
                    latestClientX = windowEvent.clientX;
                    updateRangeSelection(windowEvent.clientX);
                    updateRangeAutoScroll(windowEvent.clientX);
                  };

                  const onMouseUp = (windowEvent: MouseEvent) => {
                    if (windowEvent.button !== 0) {
                      return;
                    }

                    window.removeEventListener("mousemove", onMouseMove);
                    window.removeEventListener("mouseup", onMouseUp);
                    stopRangeAutoScroll();

                    if (!hasMoved) {
                      setSelectedTimelineRange(null);
                      void runAction(async () => {
                        await performSeek(seekStartSeconds);
                      });
                      return;
                    }

                    const endSeconds = snappedRulerSeconds(windowEvent, workspaceDurationSeconds);
                    const normalizedStartSeconds = Math.min(startSeconds, endSeconds);
                    const normalizedEndSeconds = Math.max(startSeconds, endSeconds);
                    setSelectedTimelineRange({
                      startSeconds: normalizedStartSeconds,
                      endSeconds: normalizedEndSeconds,
                    });
                    setStatus(
                      t("transport.status.rangeSelected", {
                        start: formatClock(normalizedStartSeconds),
                        end: formatClock(normalizedEndSeconds),
                      }),
                    );
                  };

                  window.addEventListener("mousemove", onMouseMove);
                  window.addEventListener("mouseup", onMouseUp);
                }}
                onRulerContextMenu={(event) => {
                  if (!song || !rulerTrackRef.current) {
                    return;
                  }

                  const positionSeconds = snappedRulerSeconds(event, workspaceDurationSeconds);
                  clearSelection();
                  setSelectedRegionId(null);
                  const activeTimelineRange =
                    selectedTimelineRange &&
                    positionSeconds >= selectedTimelineRange.startSeconds &&
                    positionSeconds <= selectedTimelineRange.endSeconds
                      ? selectedTimelineRange
                      : null;
                  if (!activeTimelineRange) {
                    setSelectedTimelineRange(null);
                  }
                  openMenu(
                    event,
                    activeTimelineRange
                      ? t("transport.shell.contextSelectionTitle", {
                          start: formatClock(activeTimelineRange.startSeconds),
                          end: formatClock(activeTimelineRange.endSeconds),
                        })
                      : t("transport.shell.contextTimelineTitle", { time: formatClock(positionSeconds) }),
                    rulerContextMenu(positionSeconds, activeTimelineRange),
                  );
                }}
                onMarkerPrimaryAction={(sectionId) => {
                  const section = song?.sectionMarkers.find((candidate) => candidate.id === sectionId);
                  if (!section) {
                    return;
                  }

                  void runAction(async () => {
                    await handleMarkerPrimaryAction(section);
                  });
                }}
                onMarkerContextMenu={(event, sectionId) => {
                  const section = song?.sectionMarkers.find((candidate) => candidate.id === sectionId);
                  if (!section) {
                    return;
                  }

                  setSelectedRegionId(null);
                  selectSection(section.id);
                  openMenu(event, section.name, sectionContextMenu(section));
                }}
                onTempoMarkerContextMenu={(event, markerId) => {
                  const marker = song?.tempoMarkers.find((candidate) => candidate.id === markerId);
                  if (!marker) {
                    return;
                  }

                  clearSelection();
                  setSelectedTimelineRange(null);
                  setSelectedRegionId(null);
                  openMenu(event, `${t("timelineTopbar.tempoReadout")} ${marker.bpm.toFixed(2)} BPM`, tempoMarkerContextMenu(marker));
                }}
                onRegionContextMenu={(event, regionId) => {
                  const region = song?.regions.find((candidate) => candidate.id === regionId);
                  if (!region) {
                    return;
                  }

                  clearSelection();
                  setSelectedTimelineRange(null);
                  setSelectedRegionId(region.id);
                  openMenu(event, region.name, songRegionContextMenu(region));
                }}
                canNativeZoom={Boolean(song)}
                onNativeCameraXPreview={(nextCameraX) =>
                  updateCameraX(nextCameraX, {
                    commitToStore: false,
                    debounceStoreCommit: false,
                  })}
                onNativeCameraXCommit={commitCameraXToStore}
                onNativeZoomPreview={(nextZoomLevel, anchorViewportX) =>
                  previewZoom(nextZoomLevel, anchorViewportX, {
                    scheduleCommit: false,
                  })}
                onNativeZoomCommit={commitZoomViewToStore}
                onNativeTrackHeightChange={applyTrackHeight}
                onPreviewPositionChange={syncLivePosition}
                onPlayheadSeekCommit={(positionSeconds) => {
                  setContextMenu(null);
                  void runAction(async () => {
                    await performSeek(positionSeconds);
                  });
                }}
                onTrackListContextMenu={handleTrackListContextMenu}
                onTrackListLibraryDragOver={handleTrackListLibraryDragOver}
                onTrackListLibraryDrop={handleTrackListLibraryDrop}
                onTrackListLibraryDragLeave={handleTrackListLibraryDragLeave}
                onEmptyArrangementLibraryDragOver={handleEmptyArrangementLibraryDragOver}
                onEmptyArrangementLibraryDrop={handleEmptyArrangementLibraryDrop}
                onTrackLaneMouseDown={handleTrackLaneMouseDown}
                onTrackLaneContextMenu={handleTrackLaneContextMenu}
                onTrackLaneLibraryDragOver={handleTrackLaneLibraryDragOver}
                onTrackLaneLibraryDrop={handleTrackLaneLibraryDrop}
                onLibraryPreviewLaneDragOver={handleLibraryPreviewLaneDragOver}
                onLibraryPreviewLaneDrop={handleLibraryPreviewLaneDrop}
              />
            </div>
          </div>
          <div className="lt-timeline-bottom-grid" aria-hidden={!song}>
            <div className="lt-horizontal-scrollbar-spacer" />
            <div className="lt-horizontal-scrollbar">
              <div
                ref={horizontalScrollbarRef}
                className="lt-horizontal-scrollbar-rail"
                aria-label={t("transport.shell.horizontalScroll")}
                onScroll={(event) => {
                  const scrollLeft = event.currentTarget.scrollLeft;
                  updateCameraX(scrollLeft, {
                    commitToStore: false,
                  });
                }}
              >
                <div
                  className="lt-horizontal-scrollbar-content"
                  style={{ width: laneViewportWidth + maxTimelineCameraX }}
                />
              </div>
            </div>
          </div>
        </div>

  </section>
  )}
  </div>

        {isSettingsModalOpen ? (
          <div className="lt-modal-backdrop" onClick={() => setIsSettingsModalOpen(false)}>
            <section
              className="lt-settings-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="lt-settings-modal-title"
              onClick={(event) => event.stopPropagation()}
            >
              <header className="lt-settings-modal-header">
                <div>
                  <span className="lt-settings-modal-eyebrow">{t("transport.settingsModal.eyebrow")}</span>
                  <h2 id="lt-settings-modal-title">{t("transport.settingsModal.title")}</h2>
                  <p>{t("transport.settingsModal.description")}</p>
                </div>
                <button type="button" className="lt-settings-modal-close" onClick={() => setIsSettingsModalOpen(false)}>
                  <span className="material-symbols-outlined">close</span>
                  {t("transport.settingsModal.close")}
                </button>
              </header>

              <div className="lt-settings-modal-body">
                <label className="lt-settings-field">
                  <span className="lt-settings-field-label">{t("transport.settingsModal.audioDevice")}</span>
                  <select
                    value={selectedAudioOutputDevice}
                    disabled={isSettingsLoading || isSettingsSaving}
                    onChange={(event) => handleAudioOutputDeviceChange(event.target.value)}
                  >
                    <option value="">
                      {defaultAudioOutputDevice
                        ? t("transport.settingsModal.audioDeviceSystemDefaultNamed", { name: defaultAudioOutputDevice })
                        : t("transport.settingsModal.audioDeviceSystemDefault")}
                    </option>
                    {selectedAudioOutputDeviceMissing ? (
                      <option value={selectedAudioOutputDevice}>
                        {t("transport.settingsModal.audioDeviceUnavailable", { name: selectedAudioOutputDevice })}
                      </option>
                    ) : null}
                    {audioOutputDevices.map((deviceName) => (
                      <option key={deviceName} value={deviceName}>
                        {deviceName}
                      </option>
                    ))}
                  </select>
                  <small>
                    {defaultAudioOutputDevice
                      ? t("transport.settingsModal.audioDeviceCurrentDefault", { name: defaultAudioOutputDevice })
                      : t("transport.settingsModal.audioDeviceNoDefault")}
                  </small>
                </label>

                <label className="lt-settings-field">
                  <span className="lt-settings-field-label">{t("transport.settingsModal.midiDevice")}</span>
                  <select
                    value={selectedMidiInputDevice}
                    disabled={isSettingsLoading || isSettingsSaving}
                    onChange={(event) => handleMidiInputDeviceChange(event.target.value)}
                  >
                    <option value="">{t("transport.settingsModal.midiDeviceNone")}</option>
                    {selectedMidiInputDeviceMissing ? (
                      <option value={selectedMidiInputDevice}>
                        {t("transport.settingsModal.midiDeviceUnavailable", { name: selectedMidiInputDevice })}
                      </option>
                    ) : null}
                    {midiInputDevices.map((deviceName) => (
                      <option key={deviceName} value={deviceName}>
                        {deviceName}
                      </option>
                    ))}
                  </select>
                  <small>{t("transport.settingsModal.midiDeviceHelp")}</small>
                </label>

                <label className="lt-settings-field">
                  <span className="lt-settings-field-label">{t("transport.settingsModal.language")}</span>
                  <select
                    value={selectedLocale}
                    disabled={isSettingsLoading || isSettingsSaving}
                    onChange={(event) => handleLocaleChange(event.target.value)}
                  >
                    <option value="">{t("transport.settingsModal.languageSystemDefault")}</option>
                    <option value="en">{t("transport.settingsModal.languageEnglish")}</option>
                    <option value="es">{t("transport.settingsModal.languageSpanish")}</option>
                  </select>
                </label>

                <label className="lt-settings-field">
                  <span className="lt-settings-field-label">{t("transport.settingsModal.metronomeVolume")}</span>
                  <input
                    className="lt-range-input"
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={metronomeVolumeDraft}
                    disabled={isSettingsLoading || isSettingsSaving}
                    onPointerDown={(event) => {
                      if (midiLearnMode === null) {
                        return;
                      }

                      event.preventDefault();
                      event.stopPropagation();
                      handleMidiLearnTarget("param:metronome_volume");
                    }}
                    onChange={(event) => handleMetronomeVolumeDraftChange(Number(event.target.value))}
                    onPointerUp={(event) => commitMetronomeVolumeDraft(Number(event.currentTarget.value))}
                    onBlur={(event) => commitMetronomeVolumeDraft(Number(event.currentTarget.value))}
                  />
                  <small>
                    {t("transport.settingsModal.metronomeVolumeValue", {
                      value: Math.round(metronomeVolumeDraft * 100),
                    })}
                  </small>
                </label>

                <label className="lt-settings-toggle">
                  <input
                    type="checkbox"
                    checked={appSettings.splitStereoEnabled}
                    disabled={isSettingsLoading || isSettingsSaving}
                    onPointerDown={(event) => {
                      if (midiLearnMode === null) {
                        return;
                      }

                      event.preventDefault();
                      event.stopPropagation();
                      handleMidiLearnTarget("action:toggle_split_stereo");
                    }}
                    onChange={(event) => handleSplitStereoChange(event.target.checked)}
                  />
                  <div className="lt-settings-toggle-copy">
                    <strong>{t("transport.settingsModal.splitStereoTitle")}</strong>
                    <small>
                      {t("transport.settingsModal.splitStereoDescription")}
                    </small>
                  </div>
                </label>

                <section className="lt-midi-learn-panel" aria-labelledby="lt-midi-learn-panel-title">
                  <div className="lt-midi-learn-panel-header">
                    <div>
                      <span id="lt-midi-learn-panel-title" className="lt-settings-field-label">
                        {t("transport.settingsModal.midiLearnSectionTitle")}
                      </span>
                      <p>{t("transport.settingsModal.midiLearnSectionDescription")}</p>
                    </div>
                    <div className="lt-midi-learn-actions">
                      <button
                        type="button"
                        className={`lt-midi-learn-activate ${midiLearnMode !== null ? "is-active" : ""}`}
                        disabled={isSettingsLoading || isSettingsSaving}
                        onClick={() => handleMidiLearnToggle({ closePanels: false })}
                      >
                        <span className="material-symbols-outlined">graphic_eq</span>
                        {t("transport.shell.midiLearn")}
                      </button>
                      <button
                        type="button"
                        className="lt-midi-learn-reset"
                        disabled={isSettingsLoading || isSettingsSaving || Object.keys(appSettings.midiMappings).length === 0}
                        onClick={handleResetMidiMappings}
                      >
                        {t("transport.settingsModal.midiLearnReset")}
                      </button>
                    </div>
                  </div>

                  <div className="lt-midi-learn-feedback">
                    <strong>{t("transport.settingsModal.midiLearnLatest")}</strong>
                    {midiLearnFeedback ? (
                      <p>
                        {midiLearnFeedbackCommand?.label ?? midiLearnFeedback.key}: {formatMidiBinding(midiLearnFeedback.binding)}
                      </p>
                    ) : (
                      <p>{t("transport.settingsModal.midiLearnEmpty")}</p>
                    )}
                  </div>

                  {midiLearnMode !== null ? (
                    <div className="lt-midi-learn-live">
                      <strong>{t("transport.settingsModal.midiLearnListening")}</strong>
                      <p>
                        {midiLearnMode === ""
                          ? t("transport.settingsModal.midiLearnArmed")
                          : t("transport.settingsModal.midiLearnTargeting", {
                              key: activeMidiLearnCommand?.label ?? midiLearnMode,
                            })}
                      </p>
                    </div>
                  ) : null}

                  <div className="lt-midi-learn-table-wrap">
                    <table className="lt-midi-learn-table">
                      <thead>
                        <tr>
                          <th scope="col">{t("transport.settingsModal.midiLearnTableCommand")}</th>
                          <th scope="col">{t("transport.settingsModal.midiLearnTableBinding")}</th>
                          <th scope="col">{t("transport.settingsModal.midiLearnTableAction")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {midiLearnCommandRows.map((command) => {
                          const hasBinding = Boolean(command.binding);
                          const isTarget = midiLearnMode === command.key;

                          return (
                            <tr key={command.key} className={isTarget ? "is-midi-target" : undefined}>
                              <td>
                                <strong>{command.label}</strong>
                                <code>{command.key}</code>
                              </td>
                              <td>
                                {hasBinding && command.binding ? (
                                  <span className="lt-midi-binding-pill">{formatMidiBinding(command.binding)}</span>
                                ) : (
                                  <span className="lt-midi-binding-empty">{t("transport.settingsModal.midiLearnUnassigned")}</span>
                                )}
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className={`lt-midi-learn-relearn ${isTarget ? "is-active" : ""}`}
                                  disabled={isSettingsLoading || isSettingsSaving}
                                  onClick={() => handleMidiLearnCommandRelearn(command.key)}
                                >
                                  {isTarget
                                    ? t("transport.settingsModal.midiLearnListeningShort")
                                    : t("transport.settingsModal.midiLearnRelearn")}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>

              </div>
            </section>
          </div>
        ) : null}

        {isRemoteModalOpen ? (
          <div className="lt-modal-backdrop" onClick={() => setIsRemoteModalOpen(false)}>
            <section
              className="lt-settings-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="lt-remote-modal-title"
              onClick={(event) => event.stopPropagation()}
            >
              <header className="lt-settings-modal-header">
                <div>
                  <span className="lt-settings-modal-eyebrow">{t("remoteAccess.eyebrow")}</span>
                  <h2 id="lt-remote-modal-title">{t("remoteAccess.title")}</h2>
                  <p>{t("remoteAccess.description")}</p>
                </div>
                <button type="button" className="lt-settings-modal-close" onClick={() => setIsRemoteModalOpen(false)}>
                  <span className="material-symbols-outlined">close</span>
                  {t("common.close")}
                </button>
              </header>

              <div className="lt-settings-modal-body">
                <RemoteAccessCard remoteServerInfo={remoteServerInfo} />
              </div>
            </section>
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

        <div className="lt-status-overlay" aria-live="polite">
          <span>{status}</span>
        </div>
        </div>
      </div>
      </div>
    </Profiler>
  );
}
