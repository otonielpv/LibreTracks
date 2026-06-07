import {
  Profiler,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { flushSync } from "react-dom";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import {
  DEFAULT_APP_SETTINGS,
  buildSongTempoRegions,
  getEffectiveBpmAt,
  getPrimarySongRegion,
  getSongBaseBpm,
  getSongBaseTimeSignature,
  getSongTempoRegionAtPosition,
  getSongRegionAtPosition,
  normalizeAppSettings,
  type AppSettings,
  type AudioBackendKind,
  type AudioDeviceDescriptor,
  type AudioMeterLevel,
  type ClipSummary,
  type JumpTriggerLabel,
  type LibraryAssetSummary,
  type LibraryImportProgressEvent,
  type MidiBinding,
  type PendingJumpSummary,
  type PitchPrepareSummary,
  type RemoteServerInfo,
  type SectionMarkerSummary,
  type SongRegionSummary,
  type SongView,
  type TempoMarkerSummary,
  type TimeSignatureMarkerSummary,
  type TrackKind,
  type TrackSummary,
  type TransportSnapshot,
  type WaveformSummaryDto,
} from "@libretracks/shared/models";
import {
  assignSectionMarkerDigit,
  cancelMarkerJump,
  createClipsBatch,
  createClipsWithAutoTracks,
  moveClipToTrack,
  createLibraryFolder,
  createSectionMarker,
  createSongRegion,
  createTrack,
  deleteClip,
  deleteLibraryAsset,
  deleteLibraryFolder,
  deleteSectionMarker,
  deleteSongRegion,
  deleteSongTempoMarker,
  deleteSongTimeSignatureMarker,
  deleteTrack,
  duplicateClips,
  exportRegionAsPackage,
  getAudioOutputDevices,
  getLibraryAssets,
  getLibraryFolders,
  getLibraryWaveformSummaries,
  getMidiInputs,
  getRemoteServerInfo,
  getSongView,
  getWaveformSummaries,
  importLibraryAssetsFromDialog,
  importAudioFilesFromBytes,
  importAudioFilesFromPaths,
  importSongPackage,
  isTauriApp,
  listenToMidiRawMessage,
  listenToProjectLoadProgress,
  listenToSettingsUpdated,
  listenToWaveformReady,
  moveClip,
  moveClipLive,
  moveClipsBatch,
  moveClipsLiveBatch,
  type ClipMoveRequest,
  moveLibraryAsset,
  moveTrack,
  pauseTransport,
  playTransport,
  prewarmTimelineSeek,
  renameLibraryFolder,
  reportUiRenderMetric,
  resolveMissingFile,
  saveSettings,
  scheduleMarkerJump,
  seekTransport,
  setMetronomeEnabledRealtime,
  setMetronomeVolumeRealtime,
  setMetronomeSoundRealtime,
  splitClip,
  splitClips,
  stopTransport,
  updateClipColor,
  updateAudioSettings,
  updateSectionMarker,
  updateLiveRegionMasterGain,
  moveSongRegion,
  updateSongRegion,
  updateSongRegionMasterGain,
  updateSongRegionTranspose,
  updateSongRegionWarp,
  updateSongTempo,
  updateSongTimeSignature,
  updateTrack,
  updateTrackColor,
  updateTrackMixRealtime,
  commitTrackMixChange,
  updateTrackTransposeEnabled,
  upsertSongTempoMarker,
  upsertSongTimeSignatureMarker,
  formatTransposeSemitones,
} from "./desktopApi";
import { getSystemLanguage } from "../../shared/i18n";
import { TimelineCanvasPane } from "./TimelineCanvasPane";
import { useRenderCounter } from "./perf/useRenderCounter";
import { CompactView } from "./CompactView";
import { TimelineToolbar } from "./TimelineToolbar";
import { TimelineTopbar } from "./TimelineTopbar";
import { TrackHeadersPane } from "./TrackHeadersPane";
import { buildClipSnapAnchors, findSnappedGroupDelta } from "./clipSnapping";
import { snapToTimelineGrid, useTimelineGrid } from "./useTimelineGrid";
import {
  BASE_PIXELS_PER_SECOND,
  clampCameraX,
  clientXToTimelineSeconds,
  getCumulativeMusicalPosition,
  getMaxCameraX,
  getTimelineWorkspaceEndSeconds,
  getZoomLevelDelta,
  nextDownbeatAfter,
  screenXToSeconds,
  secondsToScreenX,
  TIMELINE_ZOOM_MULTIPLIER,
  zoomCameraAtViewportX,
} from "./timelineMath";
import { useTransportStore, type OptimisticMixState } from "./store";
import {
  createPendingAudioImports,
  createPendingAudioImportsFromPaths,
  mergeLibraryAssetsByFilePath,
  mergePendingClipsByTrack,
  nextPaint,
  toPendingLibraryAsset,
  toPendingTrack,
  type PendingAudioImport,
  type PendingLibraryAssetSummary,
  type TimelineClipSummary,
  type TimelineTrackSummary,
} from "./pendingAudioImports";
import { TIMELINE_DEFAULT_TRACK_HEIGHT, useTimelineUIStore } from "./uiStore";
import { SideNav } from "./shell/SideNav";
import { SettingsPanel } from "./panels/SettingsPanel";
import {
  ExportSongModal,
  type ExportSongTarget,
} from "./panels/ExportSongModal";
import { RemotePanel } from "./panels/RemotePanel";
import { LibraryPanel } from "./panels/LibraryPanel";
import { useAudioMeters } from "./hooks/useAudioMeters";
import { useRegionMeters } from "./hooks/useRegionMeters";
import { useLibraryActions } from "./hooks/useLibraryActions";
import { useSettingsState } from "./hooks/useSettingsState";
import { useTransportLifecycle } from "./hooks/useTransportLifecycle";
import { useTransportPolling } from "./hooks/useTransportPolling";
import { useProjectActions } from "./hooks/useProjectActions";
import { TimelineContextMenus } from "./timeline/TimelineContextMenus";
import { useTimelineActions } from "./timeline/useTimelineActions";
import { useTimelineKeyboardShortcuts } from "./timeline/TimelineKeyboardShortcuts";
import {
  buildTimelineDropPreviewGeometry,
  classifyDroppedPaths,
  isAcceptedDroppedFileName,
  type DroppedFileClassification,
  type ExternalDropKind,
  type ExternalDropPreview,
  type NativeDroppedPathClassification,
} from "./dragDrop";
import type {
  ClipDragMember,
  ClipDragState,
  ClipSnapAnchor,
  ContextMenuAction,
  ContextMenuState,
  InternalLibraryPointerDrag,
  LibraryAssetDragPayload,
  LibraryClipPreviewState,
  LibraryDragAutoScrollState,
  LibraryDragHoverState,
  LibraryDropLayout,
  LiveClipMoveState,
  LiveTrackMixRequestState,
  MidiLearnCommand,
  MidiLearnCommandRow,
  MidiLearnFeedback,
  NativeClientPointCandidate,
  NativeDropCandidateDebug,
  NativeDropCoordinateMode,
  NativeDropDebugRect,
  NativeDroppedFile,
  OptimisticClipOperation,
  PlayheadDragState,
  SettingsTab,
  SidebarTab,
  TimelineDropGeometry,
  TimelinePanState,
  TimelineRangeSelection,
  TrackDragState,
  TrackDropState,
  TransportAnchorMeta,
} from "./types";
import {
  CLIP_SNAP_RADIUS_PX,
  DEFAULT_TIMELINE_VIEWPORT_WIDTH,
  densityFromHeight,
  DRAG_THRESHOLD_PX,
  DOM_EXTERNAL_DROP_PREVIEW_TTL_MS,
  HARDWARE_OUTPUT_CHANNEL_COUNT,
  HEADER_WIDTH,
  LIBRARY_DRAG_EDGE_BUFFER_PX,
  LIBRARY_DRAG_MAX_SCROLL_SPEED_PX,
  LIVE_TRACK_MIX_MIN_INTERVAL_MS,
  LIVE_ZOOM_COMMIT_DEBOUNCE_MS,
  MIDI_LEARN_COMMANDS,
  NATIVE_DND_DEBUG_ENABLED,
  PLAYBACK_SNAPSHOT_REANCHOR_TOLERANCE_SECONDS,
  RULER_HEIGHT,
  SCROLL_COMMIT_DEBOUNCE_MS,
  TIMELINE_FIT_RIGHT_GUTTER_PX,
  TRACK_HEIGHT_MAX,
  TRACK_HEIGHT_MIN,
  TRACK_HEIGHT_STEP,
  ZOOM_MAX,
  ZOOM_MIN,
} from "./constants";
import {
  buildAudioRoutingOptions,
  buildMemoizedClipsByTrack,
  buildVisibleTracks,
  clamp,
  clipDisplayName,
  describeNativeDropElement,
  filterOutputChannelsForOutputCount,
  findClip,
  findMidiMappingKeyForMessage,
  findPreviousFolderTrack,
  findSection,
  findTrack,
  formatBpmDraft,
  formatClock,
  formatMidiBinding,
  formatMusicalPosition,
  getNativeCandidatePointerDelta,
  humanizeLibraryTrackName,
  isAudioDeviceVisibleForBackend,
  isInteractiveTimelineTarget,
  isTimelineZoomTarget,
  isTrackDescendant,
  isTrackInfoScrollTarget,
  lanePointerToClip,
  libraryAssetFileName,
  mergeOptimisticClipsByTrack,
  nativeClientPointCandidates,
  normalizeEnabledOutputChannelsForOutputCount,
  resolveCompactTrackDropState,
  resolveNativeAudioImportPayloads,
  resolveTrackDropState,
  rulerClientXToSeconds,
  selectNativeDropCandidate,
  toClientPointFromNativePosition,
  toNativeDropDebugRect,
  trackChildrenCount,
  waitForUiPaint,
} from "./helpers";
import { createSettingsHandlers } from "./settings/settingsHandlers";
import { createMetronomeDeviceHandlers } from "./settings/metronomeDeviceHandlers";
import { createLibraryHandlers } from "./library/libraryHandlers";
import { createColorHandlers } from "./colors/colorHandlers";
import { createTrackHandlers } from "./tracks/trackHandlers";
import { createMidiLearnHandlers } from "./midi/midiLearnHandlers";
import { createTapTempoHandler } from "./tempo/tapTempoHandler";

const MIN_SESSION_BPM = 20;
const MAX_SESSION_BPM = 300;
const TIMELINE_COLOR_PRESETS = [
  { label: "Rojo", value: "#E35D5B" },
  { label: "Ambar", value: "#E0A83A" },
  { label: "Verde", value: "#57B66C" },
  { label: "Cian", value: "#3CDDC7" },
  { label: "Azul", value: "#5C8CE6" },
  { label: "Violeta", value: "#9C73E6" },
  { label: "Rosa", value: "#DF6FA8" },
] as const;

function normalizeTimelineColorInput(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  const hex = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  return /^[\da-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : null;
}

function resolveSharedTimelineColor(tracks: TrackSummary[]) {
  if (tracks.length === 0) {
    return null;
  }

  const [firstTrack, ...remainingTracks] = tracks;
  const firstColor = normalizeTimelineColorInput(firstTrack.color);
  return remainingTracks.every(
    (track) => normalizeTimelineColorInput(track.color) === firstColor,
  )
    ? firstColor
    : null;
}

type TimelineColorPopoverProps = {
  x: number;
  y: number;
  title: string;
  initialColor: string;
  onApply: (color: string) => Promise<void>;
  onDismiss: () => void;
};

function TimelineColorPopover({
  x,
  y,
  title,
  initialColor,
  onApply,
  onDismiss,
}: TimelineColorPopoverProps) {
  const [draftColor, setDraftColor] = useState(initialColor);

  useEffect(() => {
    setDraftColor(initialColor);
  }, [initialColor]);

  const normalizedColor = normalizeTimelineColorInput(draftColor) ?? "#3CDDC7";

  return (
    <div
      className="lt-color-popover"
      style={{ left: x, top: y }}
      onClick={(event) => event.stopPropagation()}
    >
      <strong>{title}</strong>
      <div
        className="lt-color-popover-preview"
        style={{ background: normalizedColor }}
        aria-hidden="true"
      />
      <div className="lt-color-popover-swatches">
        {TIMELINE_COLOR_PRESETS.map((preset) => (
          <button
            key={preset.value}
            type="button"
            className="lt-color-popover-swatch"
            style={{ background: preset.value }}
            aria-label={preset.label}
            title={preset.label}
            onClick={() => setDraftColor(preset.value)}
          />
        ))}
      </div>
      <label className="lt-color-popover-hex">
        <span>HEX</span>
        <input
          type="text"
          value={draftColor}
          spellCheck={false}
          onChange={(event) => {
            setDraftColor(event.currentTarget.value);
          }}
          onBlur={() => {
            setDraftColor((current) => normalizeTimelineColorInput(current) ?? normalizedColor);
          }}
        />
      </label>
      <label className="lt-color-popover-picker">
        <span>Selector</span>
        <input
          type="color"
          value={normalizedColor}
          aria-label="Selector de color"
          onInput={(event) => {
            const nextColor = normalizeTimelineColorInput(
              event.currentTarget.value,
            );
            if (nextColor) {
              setDraftColor(nextColor);
            }
          }}
          onChange={(event) => {
            const nextColor = normalizeTimelineColorInput(
              event.currentTarget.value,
            );
            if (nextColor) {
              setDraftColor(nextColor);
            }
          }}
        />
      </label>
      <div className="lt-color-popover-actions">
        <button type="button" onClick={onDismiss}>
          Cancelar
        </button>
        <button
          type="button"
          onClick={() => {
            const color = normalizeTimelineColorInput(draftColor);
            onDismiss();
            if (color) {
              void onApply(color);
            }
          }}
        >
          Aplicar
        </button>
      </div>
    </div>
  );
}

function getEffectiveTempoMarkerAt(
  song: SongView | null | undefined,
  positionSeconds: number,
): TempoMarkerSummary | null {
  if (!song?.tempoMarkers.length) return null;
  let bestMarker: TempoMarkerSummary | null = null;
  for (const marker of song.tempoMarkers) {
    if (
      marker.startSeconds <= positionSeconds + 0.001 &&
      (!bestMarker || marker.startSeconds > bestMarker.startSeconds)
    ) {
      bestMarker = marker;
    }
  }
  return bestMarker;
}

// Backward-compatible re-exports (TransportPanelContent.test.ts imports these)
export {
  filterOutputChannelsForOutputCount,
  isAudioDeviceVisibleForBackend,
  normalizeEnabledOutputChannelsForOutputCount,
  selectNativeDropCandidate,
  getNativeCandidatePointerDelta,
} from "./helpers";
export type {
  NativeDropCandidateDebug,
  NativeDropCoordinateMode,
} from "./types";

// Tap-tempo math now lives in ./tapTempo; re-exported here because
// TransportPanelContent.test.ts imports these from this module.
export { calculateTapTempoBpm, nextTapTempoTimes } from "./tapTempo";

export function TransportPanelContent() {
  useRenderCounter("TransportPanelContent");
  const { t, i18n } = useTranslation();
  const [song, setSong] = useState<SongView | null>(null);
  const [waveformCache, setWaveformCache] = useState<
    Record<string, WaveformSummaryDto>
  >({});
  const [clipsByTrack, setClipsByTrack] = useState<
    Record<string, ClipSummary[]>
  >({});
  const [tracksById, setTracksById] = useState<Record<string, TrackSummary>>(
    {},
  );
  const [status, setStatusRaw] = useState(() =>
    t("transport.status.loadingSession"),
  );
  // Auto-clear the status banner ~5s after the last message so the
  // overlay doesn't sit there forever after a completed action. We
  // never auto-clear a message that begins with the loading-session
  // copy (that's a persistent state, not a one-shot notification).
  const statusClearTimerRef = useRef<number | null>(null);
  const setStatus = useCallback((next: string) => {
    setStatusRaw(next);
    if (statusClearTimerRef.current !== null) {
      window.clearTimeout(statusClearTimerRef.current);
      statusClearTimerRef.current = null;
    }
    if (next === "") return;
    statusClearTimerRef.current = window.setTimeout(() => {
      setStatusRaw("");
      statusClearTimerRef.current = null;
    }, 5500);
  }, []);
  useEffect(
    () => () => {
      if (statusClearTimerRef.current !== null) {
        window.clearTimeout(statusClearTimerRef.current);
      }
    },
    [],
  );
  const [pitchPrepareUiState, setPitchPrepareUiState] = useState<{
    active: boolean;
    message: string;
    error?: string;
    startedAt?: number;
  }>({ active: false, message: "" });
  const [isBusy, setIsBusy] = useState(false);
  const [isProjectViewHydrating, setIsProjectViewHydrating] = useState(false);
  const [busyFeedback, setBusyFeedback] = useState<{
    message: string;
    percent?: number;
    detail?: string;
  } | null>(null);
  const [remoteServerInfo, setRemoteServerInfo] =
    useState<RemoteServerInfo | null>(null);
  const [tempoDraft, setTempoDraft] = useState("120");
  const [timeSignatureDraft, setTimeSignatureDraft] = useState("4/4");
  // Re-render trigger when the playhead crosses into a different tempo region.
  // displayPositionSecondsRef is updated per-frame without re-rendering, so the
  // tempo input would otherwise stay frozen at the last region's BPM.
  const [activeTempoRegionKey, setActiveTempoRegionKey] = useState<string>("");
  // While the user is editing the tempo input, do not stomp their in-progress
  // value with the effective BPM at the playhead. Cleared on blur.
  const tempoDraftFocusedRef = useRef(false);
  const tempoDraftDirtyRef = useRef(false);
  const activeTempoRegionKeyRef = useRef("");
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const contextMenuPositionRef = useRef({ x: 0, y: 0 });
  const [colorPickerPopover, setColorPickerPopover] = useState<{
    x: number;
    y: number;
    title: string;
    initialColor: string;
    onApply: (color: string) => Promise<void>;
  } | null>(null);
  const [openTopMenu, setOpenTopMenu] = useState<"file" | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    new Set(),
  );
  const [activeSidebarTab, setActiveSidebarTab] = useState<SidebarTab | null>(
    null,
  );
  const [libraryClipPreview, setLibraryClipPreview] = useState<
    LibraryClipPreviewState[]
  >([]);
  const [internalLibraryPointerDrag, setInternalLibraryPointerDrag] =
    useState<InternalLibraryPointerDrag | null>(null);
  // Drag preview for the compact view, driven by both the internal
  // library pointer pipeline and the native OS drag pipeline. HTML5
  // dragover doesn't fire reliably under Tauri, so this is the single
  // source of truth the CompactView reads from to render placeholders
  // and the package ghost column.
  //
  //   targetRegionId: the song column under the pointer (null when the
  //     pointer is on the strip but not on a column, e.g. over the
  //     action buttons or empty gutter).
  //   count: number of files/assets about to be dropped (≥ 1).
  //   isPackage: true when at least one .ltpkg path is being dragged;
  //     paints the strip-level ghost column instead of per-column
  //     placeholders.
  const [compactDragPreview, setCompactDragPreview] = useState<{
    targetRegionId: string | null;
    count: number;
    isPackage: boolean;
  } | null>(null);
  // Position (in seconds) of the anchor a magneted clip drag is locked onto.
  // Drives the vertical snap indicator. null when no anchor is engaged.
  const [clipDragSnapIndicatorSeconds, setClipDragSnapIndicatorSeconds] =
    useState<number | null>(null);
  const [externalDropPreview, setExternalDropPreview] =
    useState<ExternalDropPreview | null>(null);
  const [nativeDropDebugCandidates, setNativeDropDebugCandidates] = useState<
    NativeDropCandidateDebug[]
  >([]);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  // When set, the export-mode chooser (Light / Full) is shown for this song.
  const [exportSongTarget, setExportSongTarget] =
    useState<ExportSongTarget | null>(null);
  const selectedRegion = useMemo(
    () =>
      song?.regions.find((region) => region.id === selectedRegionId) ?? null,
    [selectedRegionId, song?.regions],
  );

  // Compact view: "Solo cancion activa" filter. Owned here so the
  // toggle button lives in the TimelineToolbar (saves strip space),
  // and the CompactMixer just reads the boolean as a controlled prop.
  // Persists across sessions via localStorage; the read happens once
  // at mount, the write on every change.
  const COMPACT_MIXER_FILTER_KEY = "libretracks.compactMixer.filterActiveSong";
  const [compactMixerFilterActiveSong, setCompactMixerFilterActiveSong] =
    useState<boolean>(() => {
      if (typeof window === "undefined") return false;
      try {
        return window.localStorage.getItem(COMPACT_MIXER_FILTER_KEY) === "1";
      } catch {
        return false;
      }
    });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        COMPACT_MIXER_FILTER_KEY,
        compactMixerFilterActiveSong ? "1" : "0",
      );
    } catch {
      // Storage quota / private mode — toggle still works in memory.
    }
  }, [compactMixerFilterActiveSong]);
  const toggleCompactMixerFilterActiveSong = useCallback(() => {
    setCompactMixerFilterActiveSong((current) => !current);
  }, []);
  // "Available" — coarse proxy: the toggle has potential effect as
  // soon as the project has at least one song region. The exact
  // "playhead is inside a region right now" check would require
  // subscribing to a reactive playhead state we don't have here;
  // the project-has-regions test is enough to gate the disabled
  // appearance, and toggling with the playhead between regions is
  // a harmless no-op (the mixer falls back to showing every track).
  const compactMixerFilterAvailable = (song?.regions.length ?? 0) > 0;
  const [selectedTimelineRange, setSelectedTimelineRange] =
    useState<TimelineRangeSelection | null>(null);
  const [optimisticClipOperations, setOptimisticClipOperations] = useState<
    OptimisticClipOperation[]
  >([]);
  const copiedClipsRef = useRef<ClipSummary[]>([]);
  const [missingMidiDeviceWarning, setMissingMidiDeviceWarning] = useState<
    string | null
  >(null);
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(
    DEFAULT_TIMELINE_VIEWPORT_WIDTH,
  );
  // Mirrors `selectedOutputChannelCount` (derived far below in render) so the
  // settings handler factory — instantiated near the top — can read the current
  // value without depending on render-order of the derived memo.
  const selectedOutputChannelCountRef = useRef(1);
  // Mirrors `audioDeviceDescriptors` so the settings handler factory can look up
  // a device descriptor at call time without depending on render order.
  const audioDeviceDescriptorsRef = useRef<AudioDeviceDescriptor[]>([]);
  const hasShownMissingMidiDeviceWarningRef = useRef(false);
  const metronomeLiveRequestIdRef = useRef(0);
  const tapTempoTimesRef = useRef<number[]>([]);
  const syncSettingsLanguage = useCallback(
    async (settings: AppSettings) => {
      await i18n.changeLanguage(settings.locale || getSystemLanguage());
    },
    [i18n],
  );
  // Settings / Audio / MIDI configuration state. See hooks/useSettingsState.
  const {
    isSettingsModalOpen,
    setIsSettingsModalOpen,
    isRemoteModalOpen,
    setIsRemoteModalOpen,
    activeSettingsTab,
    setActiveSettingsTab,
    isSettingsLoading,
    setIsSettingsLoading,
    isSettingsSaving,
    setIsSettingsSaving,
    appSettings,
    setAppSettings,
    appSettingsRef,
    midiLearnFeedback,
    setMidiLearnFeedback,
    midiLearnView,
    setMidiLearnView,
    metronomeVolumeDraft,
    setMetronomeVolumeDraft,
    enabledOutputChannelsDraft,
    setEnabledOutputChannelsDraft,
    audioDeviceDescriptors,
    setAudioDeviceDescriptors,
    audioOutputChannelCounts,
    setAudioOutputChannelCounts,
    defaultAudioOutputDevice,
    setDefaultAudioOutputDevice,
    midiInputDevices,
    setMidiInputDevices,
    isMidiInputRefreshing,
    setIsMidiInputRefreshing,
    refreshAudioSettings,
  } = useSettingsState({ syncSettingsLanguage });
  useEffect(() => {
    if (isSettingsModalOpen) {
      setActiveSettingsTab("audio");
    }
  }, [isSettingsModalOpen, setActiveSettingsTab]);
  const formatErrorStatus = useCallback(
    (error: unknown) => {
      // Log to devtools so we can grab the full string even after the
      // status banner auto-hides. The status banner truncates long
      // engine error messages; the console keeps them in full.
      console.error("[lt] action error:", error);
      return t("transport.status.error", { message: String(error) });
    },
    [t],
  );
  const translateJumpTrigger = useCallback(
    (trigger: JumpTriggerLabel) => {
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
    },
    [t],
  );
  const translateLanguageName = useCallback(
    (language: "en" | "es") => {
      return i18n.t(
        language === "es"
          ? "transport.settingsModal.languageSpanish"
          : "transport.settingsModal.languageEnglish",
      );
    },
    [i18n],
  );
  const cameraX = useTimelineUIStore((state) => state.cameraX);
  const zoomLevel = useTimelineUIStore((state) => state.zoomLevel);
  const trackHeight = useTimelineUIStore((state) => state.trackHeight);
  const snapEnabled = useTimelineUIStore((state) => state.snapEnabled);
  const midiLearnMode = useTimelineUIStore((state) => state.midiLearnMode);
  const viewMode = useTimelineUIStore((state) => state.viewMode);
  const toggleViewMode = useTimelineUIStore((state) => state.toggleViewMode);
  const midiLearnCommandRows = useMemo(
    () =>
      MIDI_LEARN_COMMANDS.map((command) => ({
        ...command,
        label: t(command.labelKey),
        binding: appSettings.midiMappings[command.key] ?? null,
      })) satisfies MidiLearnCommandRow[],
    [appSettings.midiMappings, t],
  );
  const dynamicMidiLearnJumpRows = useMemo(
    () =>
      Object.entries(appSettings.midiMappings)
        .filter(([key]) => {
          if (key.startsWith("action:jump_marker_")) {
            const index = Number(key.slice("action:jump_marker_".length));
            return Number.isInteger(index) && index >= 1 && index <= 100;
          }

          if (key.startsWith("action:jump_song_")) {
            const index = Number(key.slice("action:jump_song_".length));
            return Number.isInteger(index) && index >= 1 && index <= 20;
          }

          return false;
        })
        .map(([key, binding]) => {
          const markerIndex = key.startsWith("action:jump_marker_")
            ? Number(key.slice("action:jump_marker_".length))
            : null;
          const songIndex = key.startsWith("action:jump_song_")
            ? Number(key.slice("action:jump_song_".length))
            : null;
          return {
            key,
            label:
              markerIndex !== null && Number.isInteger(markerIndex)
                ? t("transport.settingsModal.midiLearnJumpMarker", {
                    index: markerIndex,
                  })
                : t("transport.settingsModal.midiLearnJumpSong", {
                    index: songIndex,
                  }),
            binding,
          };
        })
        .sort((left, right) =>
          left.key.localeCompare(right.key, undefined, { numeric: true }),
        ),
    [appSettings.midiMappings, t],
  );
  const midiLearnRows = useMemo(
    () => [...midiLearnCommandRows, ...dynamicMidiLearnJumpRows],
    [dynamicMidiLearnJumpRows, midiLearnCommandRows],
  );
  const midiLearnMarkerRows = useMemo(
    () =>
      dynamicMidiLearnJumpRows.filter((command) =>
        command.key.startsWith("action:jump_marker_"),
      ),
    [dynamicMidiLearnJumpRows],
  );
  const midiLearnSongRows = useMemo(
    () =>
      dynamicMidiLearnJumpRows.filter((command) =>
        command.key.startsWith("action:jump_song_"),
      ),
    [dynamicMidiLearnJumpRows],
  );
  const visibleMidiLearnRows = useMemo(() => {
    if (midiLearnView === "markers") {
      return midiLearnMarkerRows;
    }

    if (midiLearnView === "songs") {
      return midiLearnSongRows;
    }

    return midiLearnCommandRows;
  }, [
    midiLearnCommandRows,
    midiLearnMarkerRows,
    midiLearnSongRows,
    midiLearnView,
  ]);
  const midiLearnFeedbackCommand = useMemo(
    () =>
      midiLearnRows.find((command) => command.key === midiLearnFeedback?.key) ??
      null,
    [midiLearnRows, midiLearnFeedback],
  );
  const formatMidiLearnCommandLabel = useCallback(
    (key: string) => {
      const learnedRow = midiLearnRows.find((command) => command.key === key);
      if (learnedRow) {
        return learnedRow.label;
      }

      if (key.startsWith("action:jump_marker_")) {
        const index = Number(key.slice("action:jump_marker_".length));
        if (Number.isInteger(index) && index >= 1 && index <= 100) {
          return t("transport.settingsModal.midiLearnJumpMarker", { index });
        }
      }

      if (key.startsWith("action:jump_song_")) {
        const index = Number(key.slice("action:jump_song_".length));
        if (Number.isInteger(index) && index >= 1 && index <= 20) {
          return t("transport.settingsModal.midiLearnJumpSong", { index });
        }
      }

      return key;
    },
    [midiLearnRows, t],
  );
  const activeMidiLearnCommand = useMemo(
    () =>
      midiLearnMode === null
        ? null
        : {
            key: midiLearnMode,
            label: formatMidiLearnCommandLabel(midiLearnMode),
            binding: appSettings.midiMappings[midiLearnMode] ?? null,
          },
    [formatMidiLearnCommandLabel, midiLearnMode, appSettings.midiMappings],
  );

  useEffect(() => {
    setMetronomeVolumeDraft(appSettings.metronomeVolume);
  }, [appSettings.metronomeVolume]);

  useEffect(() => {
    setEnabledOutputChannelsDraft(appSettings.enabledOutputChannels);
  }, [appSettings.enabledOutputChannels]);

  useEffect(() => {
    if (isSettingsModalOpen) {
      setEnabledOutputChannelsDraft(
        appSettingsRef.current.enabledOutputChannels,
      );
    }
  }, [isSettingsModalOpen]);

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

  const handleNativeFileDragOverRef = useRef(handleNativeFileDragOver);
  const handleNativeFileDropRef = useRef(handleNativeFileDrop);

  useEffect(() => {
    handleNativeFileDragOverRef.current = handleNativeFileDragOver;
    handleNativeFileDropRef.current = handleNativeFileDrop;
  });

  useEffect(() => {
    if (!isTauriApp) {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;
    const currentWebview = getCurrentWebview();

    void (async () => {
      try {
        const position = await currentWebview.position();
        if (disposed) {
          return;
        }

        nativeWebviewPositionRef.current = {
          x: position.x,
          y: position.y,
        };
      } catch {
        nativeWebviewPositionRef.current = null;
      }

      const dispose = await currentWebview.onDragDropEvent((event) => {
        const payload = event.payload;

        // Tauri 2.x emits FOUR variants: `enter`, `over`, `drop`,
        // `leave`. The `paths` array is only included in `enter` and
        // `drop` — `over` carries position-only. Earlier we only
        // listened to `over`/`drop`, so the dragover preview path
        // never received paths and always classified the kind as
        // "unknown", which silenced every per-column placeholder /
        // ghost feedback. We now treat `enter` and `over` as the
        // same logical event for our preview pipeline; the handler
        // already caches paths into nativeExternalDropPathsRef so
        // subsequent `over` ticks (no paths) can reuse them.
        if (payload.type === "enter" || payload.type === "over") {
          const positionalPaths =
            payload.type === "enter" ? payload.paths : undefined;
          handleNativeFileDragOverRef.current({
            paths: positionalPaths,
            position: payload.position,
          });
          return;
        }

        if (payload.type === "drop") {
          handleNativeFileDropRef.current({
            paths: payload.paths,
            position: payload.position,
          });
          return;
        }

        nativeExternalDropPathsRef.current = [];
        nativeDropKindRef.current = null;
        domExternalDropPreviewUntilRef.current = 0;
        lastNativeTimelineDropRef.current = null;
        nativeDropCoordinateModeRef.current = null;
        setExternalDropPreview(null);
        setCompactDragPreview(null);
        if (NATIVE_DND_DEBUG_ENABLED) {
          setNativeDropDebugCandidates([]);
        }
      });

      if (disposed) {
        dispose();
        return;
      }

      unlisten = dispose;
    })().catch((error) => {
      console.error(
        "[native-dnd] failed to register drag/drop listener",
        error,
      );
      nativeExternalDropPathsRef.current = [];
      nativeDropKindRef.current = null;
      domExternalDropPreviewUntilRef.current = 0;
      lastNativeTimelineDropRef.current = null;
      setExternalDropPreview(null);
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    return () => {
      stopInternalLibraryPointerDragListeners();
    };
  }, []);
  const selectedTrackIds = useTimelineUIStore(
    (state) => state.selectedTrackIds,
  );
  const selectedClipId = useTimelineUIStore((state) => state.selectedClipId);
  const selectedClipIds = useTimelineUIStore((state) => state.selectedClipIds);
  const selectedSectionId = useTimelineUIStore(
    (state) => state.selectedSectionId,
  );
  const setCameraX = useTimelineUIStore((state) => state.setCameraX);
  const setZoomLevel = useTimelineUIStore((state) => state.setZoomLevel);
  const setTrackHeight = useTimelineUIStore((state) => state.setTrackHeight);
  const setSnapEnabled = useTimelineUIStore((state) => state.setSnapEnabled);
  const toggleSnapEnabled = useTimelineUIStore(
    (state) => state.toggleSnapEnabled,
  );
  const setSelectedClipId = useTimelineUIStore(
    (state) => state.setSelectedClipId,
  );
  const setSelectedClipIds = useTimelineUIStore(
    (state) => state.setSelectedClipIds,
  );
  const toggleClipSelection = useTimelineUIStore(
    (state) => state.toggleClipSelection,
  );
  const setSelectedSectionId = useTimelineUIStore(
    (state) => state.setSelectedSectionId,
  );
  const clearSelection = useTimelineUIStore((state) => state.clearSelection);
  const selectTrack = useTimelineUIStore((state) => state.selectTrack);
  const selectClip = useTimelineUIStore((state) => state.selectClip);
  const selectSection = useTimelineUIStore((state) => state.selectSection);
  const setMidiLearnMode = useTimelineUIStore(
    (state) => state.setMidiLearnMode,
  );
  useEffect(() => {
    if (trackHeight < TRACK_HEIGHT_MIN) {
      setTrackHeight(TRACK_HEIGHT_MIN);
    }
  }, [setTrackHeight, trackHeight]);
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
  // Set right before an explicit transport action (seek/play/pause/stop) so
  // the next snapshot from the store subscriber forces a re-anchor even if
  // shouldPreserveVisualAnchor would otherwise short-circuit. Without this,
  // previewSeek() leaves the anchor with running=false while the RTT to the
  // backend resolves, and if the returned snapshot's lastSeekPositionSeconds
  // matches the previous one the anchor never re-runs → playhead frozen.
  const forceReanchorOnNextSnapshotRef = useRef(false);
  const displayPositionSecondsRef = useRef(0);
  const suppressTrackClickRef = useRef(false);
  const trackSelectionAnchorRef = useRef<string | null>(null);
  const clipSelectionAnchorRef = useRef<string | null>(null);
  // When a plain click lands on a clip that is part of an existing
  // multi-selection, we keep the group selected so the drag can move it
  // together. If the user releases without dragging, the click is treated
  // as "collapse selection to just this clip" — this ref carries the clip
  // ID across mouseDown→mouseUp.
  const clipSelectionPendingCollapseRef = useRef<string | null>(null);
  const renderMetricTimeoutRef = useRef<number | null>(null);
  const pendingRenderMetricRef = useRef(0);
  const nativeExternalDropPathsRef = useRef<string[]>([]);
  const nativeDropKindRef = useRef<ExternalDropKind | null>(null);
  const domExternalDropPreviewUntilRef = useRef(0);
  const nativeDropCoordinateModeRef = useRef<NativeDropCoordinateMode | null>(
    null,
  );
  const lastNativeTimelineDropRef = useRef<{
    seconds: number;
    rawSeconds: number;
    snappedSeconds: number;
    previewClientX: number;
    snapApplied: boolean;
    coordinateMode: NativeDropCoordinateMode;
  } | null>(null);
  const nativeWebviewPositionRef = useRef<{ x: number; y: number } | null>(
    null,
  );
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
  const snapshotRef = useRef<TransportSnapshot | null>(
    useTransportStore.getState().playback,
  );
  const songRef = useRef<SongView | null>(null);
  // True once the SongView with waveforms has been fetched (or a fetch is
  // in flight). Used by the revision-effect to decide whether the next
  // getSongView call needs to pull the ~27 MB waveform payload or can
  // skip it. Distinct from songRef.current !== null because that lags by
  // one render — multiple revision bumps during the initial load can race
  // and all try to fetch waveforms before the first setSong commits.
  const waveformsHydratedRef = useRef(false);
  // When the frontend applies a mutation optimistically (transpose, mute,
  // gain commit, …), it already knows the resulting state. We record the
  // backend project_revision that the mutation will produce so the
  // revision-effect can recognise it and skip the refetch entirely — there
  // is nothing new to learn from the server. Without this every transpose
  // click still refetches the full SongView for no reason.
  const optimisticallyAppliedRevisionsRef = useRef(new Set<number>());
  const tracksByIdRef = useRef<Record<string, TrackSummary>>({});
  const clipDragRef = useRef<ClipDragState>(null);
  const clipMoveLiveStatesRef = useRef<Record<string, LiveClipMoveState>>({});
  const clipMoveCommitPendingRef = useRef<Set<string>>(new Set());
  const clipPreviewClearAfterRevisionRef = useRef<Record<string, number>>({});
  // Batch live-move state for multi-clip drags. Single state because the
  // batch IPC replaces every selected clip's position in one call, so there
  // can only ever be one in-flight batch at a time.
  const clipMoveBatchLiveStateRef = useRef<{
    inFlight: boolean;
    queuedMoves: ClipMoveRequest[] | null;
  }>({ inFlight: false, queuedMoves: null });
  const duplicateClipCursorRef = useRef<Record<string, number>>({});
  const trackMixRequestIdsRef = useRef<Record<string, number>>({});
  const trackMixLiveStatesRef = useRef<
    Record<string, LiveTrackMixRequestState>
  >({});
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
  const activeLibraryDragPayloadRef = useRef<LibraryAssetDragPayload[] | null>(
    null,
  );
  const internalLibraryPointerDragRef =
    useRef<InternalLibraryPointerDrag | null>(null);
  const internalLibraryPointerDragListenersRef = useRef<{
    move: (event: PointerEvent) => void;
    up: (event: PointerEvent) => void;
    cancel: (event: PointerEvent) => void;
    mouseMove: (event: MouseEvent) => void;
    mouseUp: (event: MouseEvent) => void;
  } | null>(null);
  const libraryDragAutoScrollRef = useRef<LibraryDragAutoScrollState>({
    frameId: null,
    horizontalVelocity: 0,
    verticalVelocity: 0,
  });
  const scrollDebounceTimerRef = useRef<number | null>(null);
  const zoomDebounceTimerRef = useRef<number | null>(null);
  const playbackState = useTransportStore(
    (state) => state.playback?.playbackState ?? "empty",
  );
  const playbackProjectRevision = useTransportStore(
    (state) => state.playback?.projectRevision ?? 0,
  );
  const playbackSongDir = useTransportStore(
    (state) => state.playback?.songDir ?? null,
  );
  const isShellBusy = isBusy || isProjectViewHydrating;
  const {
    libraryAssets,
    libraryFolders,
    isLibraryLoading,
    isImportingLibrary,
    libraryImportProgress,
    deletingLibraryFilePath,
    libraryStateRequestIdRef,
    loadLibraryState,
    refreshLibraryState,
    mergeLibraryAssets,
    setLibraryAssets,
    setLibraryFolders,
    setIsLibraryLoading,
    setIsImportingLibrary,
    setLibraryImportProgress,
    setDeletingLibraryFilePath,
  } = useLibraryActions({ playbackSongDir });
  // Mirror library assets / song dir so the library handler factory reads the
  // live values inside its async runAction bodies without capturing stale state.
  const libraryAssetsRef = useRef(libraryAssets);
  libraryAssetsRef.current = libraryAssets;
  const playbackSongDirRef = useRef(playbackSongDir);
  playbackSongDirRef.current = playbackSongDir;
  const pendingAudioImports = useTransportStore(
    (state) => state.pendingAudioImports,
  );
  const projectIdentityRef = useRef<{
    songDir: string | null;
    songId: string | null;
  } | null>(null);
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
      pendingJump.transition,
    ].join("|");
  });
  const activeVampSignature = useTransportStore((state) => {
    const activeVamp = state.playback?.activeVamp;
    if (!activeVamp) {
      return "";
    }

    return [
      activeVamp.startSeconds.toFixed(6),
      activeVamp.endSeconds.toFixed(6),
    ].join("|");
  });

  songRef.current = song;
  tracksByIdRef.current = tracksById;

  const runAction = useCallback(
    async (work: () => Promise<void>, options?: { busy?: boolean }) => {
      try {
        if (options?.busy) {
          setIsBusy(true);
          setBusyFeedback(null);
        }
        await work();
      } catch (error) {
        setStatus(formatErrorStatus(error));
      } finally {
        if (options?.busy) {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
          setIsBusy(false);
          setBusyFeedback(null);
        }
      }
    },
    [formatErrorStatus],
  );

  const registerProjectLoadProgressListener = useCallback(async () => {
    return listenToProjectLoadProgress((event) => {
      const detail =
        event.sourcesTotal > 0
          ? `${event.sourcesReady}/${event.sourcesTotal} fuentes · RAM ${event.ramCacheMb} MB · disco ${event.diskCacheMb} MB`
          : undefined;
      setBusyFeedback({
        message: event.message,
        percent: event.percent,
        detail,
      });
    });
  }, []);

  const hydrateWaveformCacheFromSong = useCallback(
    (nextSong: SongView | null) => {
      const nextWaveforms = Object.fromEntries(
        (nextSong?.waveforms ?? []).map((summary) => [
          summary.waveformKey,
          summary,
        ]),
      );
      if (!nextSong) {
        setWaveformCache({});
      } else if (Object.keys(nextWaveforms).length > 0) {
        setWaveformCache((current) => ({
          ...current,
          ...nextWaveforms,
        }));
      }
    },
    [],
  );

  const refreshSongView = useCallback(
    async (options?: { sync?: boolean; includeWaveforms?: boolean }) => {
      // includeWaveforms defaults to true to preserve the contract for the
      // initial load and for structural mutations (clip add/remove/move). For
      // mutations that never touch peaks — transpose, gain, mute, solo, region
      // rename — pass `includeWaveforms: false` to collapse the IPC payload
      // from ~27 MB to ~50 KB. The frontend keeps its previously hydrated
      // waveform cache; ClipSummary.waveformKey still points at it. When
      // waveforms are skipped we must NOT re-hydrate from an empty array
      // (it would wipe the cache); skip hydration in that case and preserve
      // the existing entries on the next setSong.
      const includeWaveforms = options?.includeWaveforms ?? true;
      if (includeWaveforms) {
        waveformsHydratedRef.current = true;
      }
      const nextSong = await getSongView({ includeWaveforms });
      const apply = () => {
        if (includeWaveforms) {
          hydrateWaveformCacheFromSong(nextSong);
          setSong(nextSong);
        } else {
          // Merge: keep waveforms from the previous song; overlay everything
          // else from nextSong. If there was no previous song we still take
          // nextSong as-is (no waveforms to preserve).
          setSong((previous) => {
            if (!nextSong) return null;
            if (!previous) return nextSong;
            return { ...nextSong, waveforms: previous.waveforms };
          });
        }
      };
      if (options?.sync) {
        flushSync(apply);
      } else {
        apply();
      }
      return nextSong;
    },
    [hydrateWaveformCacheFromSong],
  );

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
      if (learnMode === null) {
        const mappedKey = findMidiMappingKeyForMessage(
          appSettingsRef.current.midiMappings,
          message,
        );

        if (mappedKey === "action:select_previous_region") {
          handleSelectRegionFromMidi(-1);
        } else if (mappedKey === "action:select_next_region") {
          handleSelectRegionFromMidi(1);
        } else if (
          mappedKey === "action:region_transpose_up" ||
          mappedKey === "action:region_transpose_down" ||
          mappedKey === "action:region_transpose_reset"
        ) {
          handleRegionTransposeFromMidi(mappedKey);
        }

        return;
      }

      if (learnMode === "") {
        return;
      }

      const nextBinding = {
        status: message.status,
        data1: message.data1,
        isCc: (message.status & 0xf0) === 0xb0,
      };
      const nextSettings = normalizeAppSettings({
        ...appSettingsRef.current,
        midiMappings: {
          ...appSettingsRef.current.midiMappings,
          [learnMode]: nextBinding,
        },
      });
      const previousSettings = appSettingsRef.current;
      const learnedCommandLabel = formatMidiLearnCommandLabel(learnMode);

      appSettingsRef.current = nextSettings;
      setAppSettings(nextSettings);
      setMidiLearnMode(null);

      void runAction(async () => {
        try {
          const liveSettings = normalizeAppSettings(
            await updateAudioSettings(nextSettings),
          );
          const savedSettings = normalizeAppSettings(
            await saveSettings(liveSettings),
          );
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
  }, [formatMidiLearnCommandLabel, runAction, setMidiLearnMode, t]);

  useEffect(() => {
    if (!isTauriApp) {
      return;
    }

    let active = true;
    let unlisten: (() => void) | null = null;
    void registerProjectLoadProgressListener().then((dispose) => {
      if (!active) {
        dispose();
        return;
      }
      unlisten = dispose;
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, [registerProjectLoadProgressListener]);

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
          const liveSettings = normalizeAppSettings(
            await updateAudioSettings(normalizedSettings),
          );
          const savedSettings = normalizeAppSettings(
            await saveSettings(liveSettings),
          );
          setAppSettings(savedSettings);
          await syncSettingsLanguage(savedSettings);
          setStatus(
            typeof successMessage === "function"
              ? successMessage(savedSettings)
              : successMessage,
          );
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

  // Settings transform handlers, extracted to ./settings/settingsHandlers.
  // They read appSettingsRef.current (kept in sync with appSettings by an
  // effect below), so the factory only depends on stable identities and never
  // needs to be re-created when appSettings changes — keeping SettingsPanel's
  // handler props referentially stable across renders.
  const settingsHandlers = useMemo(
    () =>
      createSettingsHandlers({
        appSettingsRef,
        persistAudioSettings,
        getSelectedOutputChannelCount: () =>
          selectedOutputChannelCountRef.current,
        getAudioDeviceDescriptors: () => audioDeviceDescriptorsRef.current,
        setMidiLearnFeedback,
        setEnabledOutputChannelsDraft,
        t,
        translateLocaleMessage: (savedSettings) =>
          savedSettings.locale
            ? i18n.t("transport.status.settingsLanguageUpdated", {
                name: translateLanguageName(
                  savedSettings.locale === "es" ? "es" : "en",
                ),
              })
            : i18n.t("transport.status.settingsLanguageSystem"),
      }),
    [persistAudioSettings, t, i18n, translateLanguageName],
  );
  const {
    handleAudioBackendChange,
    handleOutputSampleRateChange,
    handleOutputBufferSizeChange,
    handleAudioSafeModeChange,
    handleEnabledOutputChannelChange,
    handleDiscardEnabledOutputChannels,
    handleSelectAllOutputChannels,
    handleClearOutputChannels,
    handleCommitEnabledOutputChannels,
    handleMetronomeOutputChange,
    handleAudioOutputDeviceChange,
    handleResetMidiMappings,
    handleGlobalJumpModeChange,
    handleGlobalJumpBarsChange,
    handleSongJumpTriggerChange,
    handleSongJumpBarsChange,
    handleSongTransitionModeChange,
    handleVampModeChange,
    handleVampBarsChange,
    handleTimelineNavigationSchemeChange,
    handleLocaleChange,
  } = settingsHandlers;

  // Metronome realtime + audio-device/MIDI refresh handlers. Like
  // settingsHandlers, instantiated once with stable deps so SettingsPanel's
  // handler props stay referentially stable. `isMidiInputRefreshing` is read
  // through a getter so the guard sees the live flag without re-creating the
  // factory. See ./settings/metronomeDeviceHandlers.
  const isMidiInputRefreshingRef = useRef(isMidiInputRefreshing);
  isMidiInputRefreshingRef.current = isMidiInputRefreshing;
  const metronomeDeviceHandlers = useMemo(
    () =>
      createMetronomeDeviceHandlers({
        appSettingsRef,
        persistAudioSettings,
        setAppSettings,
        setMetronomeVolumeDraft,
        setIsSettingsLoading,
        setIsMidiInputRefreshing,
        setAudioDeviceDescriptors,
        setAudioOutputChannelCounts,
        setDefaultAudioOutputDevice,
        setMidiInputDevices,
        metronomeLiveRequestIdRef,
        isTauriApp,
        isMidiInputRefreshing: () => isMidiInputRefreshingRef.current,
        runAction,
        setStatus,
        formatErrorStatus,
        t,
        getAudioOutputDevices,
        getMidiInputs,
        setMetronomeSoundRealtime,
        setMetronomeEnabledRealtime,
        setMetronomeVolumeRealtime,
        saveSettings,
      }),
    [persistAudioSettings, runAction, setStatus, formatErrorStatus, t],
  );
  const {
    handleRefreshAudioDevices,
    handleMetronomeSoundChange,
    handleMetronomeEnabledChange,
    handleMetronomeVolumeDraftChange,
    commitMetronomeVolumeDraft,
    handleMidiInputDeviceChange,
    handleRefreshMidiInputDevices,
  } = metronomeDeviceHandlers;

  // Library asset/folder mutation handlers. See ./library/libraryHandlers.
  const libraryHandlers = useMemo(
    () =>
      createLibraryHandlers({
        getPlaybackSongDir: () => playbackSongDirRef.current,
        getLibraryAssets: () => libraryAssetsRef.current,
        runAction,
        waitForUiPaint,
        setStatus,
        setLibraryAssets,
        setLibraryFolders,
        setLibraryClipPreview,
        setIsImportingLibrary,
        setLibraryImportProgress,
        setDeletingLibraryFilePath,
        loadLibraryState,
        t,
        importLibraryAssetsFromDialog,
        getLibraryFolders,
        deleteLibraryAsset,
        createLibraryFolder,
        moveLibraryAsset,
        renameLibraryFolder,
        deleteLibraryFolder,
        confirm: (message) => window.confirm(message),
        prompt: (message, defaultValue) => window.prompt(message, defaultValue),
      }),
    [
      runAction,
      setStatus,
      loadLibraryState,
      setLibraryAssets,
      setLibraryFolders,
      setLibraryClipPreview,
      setIsImportingLibrary,
      setLibraryImportProgress,
      setDeletingLibraryFilePath,
      t,
    ],
  );
  const {
    handleImportLibraryAssetsClick,
    handleDeleteLibraryAssets,
    handleCreateLibraryFolder,
    handleMoveLibraryAssets,
    handleRenameLibraryFolder,
    handleDeleteLibraryFolder,
  } = libraryHandlers;

  const applyPitchPrepareSnapshot = useCallback(
    (pitch: PitchPrepareSummary | null | undefined) => {
      if (!pitch) {
        return;
      }
      if (pitch.pitchPrepareStatus === "failed") {
        setPitchPrepareUiState({
          active: true,
          message: "No se pudo preparar el audio transpuesto",
          error: pitch.lastPitchProxyError || pitch.pitchPrepareMessage,
          startedAt: Date.now(),
        });
        return;
      }
      if (pitch.lastPitchPrepareReason.startsWith("seek_")) {
        setPitchPrepareUiState({ active: false, message: "" });
        return;
      }
      if (pitch.pitchPrepareActive) {
        setPitchPrepareUiState({
          active: true,
          message: "Preparando audio transpuesto...",
          startedAt: Date.now(),
        });
        return;
      }
      setPitchPrepareUiState({ active: false, message: "" });
    },
    [],
  );

  const applyPlaybackSnapshot = useCallback(
    (nextSnapshot: TransportSnapshot | null) => {
      useTransportStore.getState().setPlaybackState(nextSnapshot);
      snapshotRef.current = nextSnapshot;
      applyPitchPrepareSnapshot(nextSnapshot?.pitch);
    },
    [applyPitchPrepareSnapshot],
  );

  // Track/clip colour handlers (optimistic song patch + snapshot publish).
  // See ./colors/colorHandlers.
  const {
    handleSetTrackColor,
    handleSetTrackColors,
    handleSetClipColor,
  } = useMemo(
    () =>
      createColorHandlers({
        runAction,
        setSong,
        applyPlaybackSnapshot,
        setStatus,
        optimisticallyAppliedRevisionsRef,
        clipDisplayName,
        updateTrackColor,
        updateClipColor,
      }),
    [runAction, setSong, applyPlaybackSnapshot, setStatus],
  );

  const missingFilePaths = useMemo(() => {
    const paths = new Set<string>();
    for (const clip of song?.clips ?? []) {
      if (clip.isMissing) {
        paths.add(clip.filePath);
      }
    }
    for (const asset of libraryAssets) {
      if (asset.isMissing) {
        paths.add(asset.filePath);
      }
    }
    return [...paths].sort((left, right) => left.localeCompare(right));
  }, [libraryAssets, song?.clips]);

  const handleLocateMissingFile = useCallback(
    async (missingPath: string) => {
      await runAction(
        async () => {
          const selectedPath = await open({
            multiple: false,
            directory: false,
            title: "Locate missing audio file",
          });
          if (typeof selectedPath !== "string") {
            return;
          }

          const nextSnapshot = await resolveMissingFile(
            missingPath,
            selectedPath,
          );
          applyPlaybackSnapshot(nextSnapshot);
          await Promise.all([refreshSongView(), refreshLibraryState()]);
          setStatus(t("transport.status.projectSaved"));
        },
        { busy: true },
      );
    },
    [applyPlaybackSnapshot, refreshLibraryState, refreshSongView, runAction, t],
  );

  const getTrackOptimisticMix = useCallback((trackId: string) => {
    return useTransportStore.getState().optimisticMix[trackId] ?? {};
  }, []);

  const setTrackOptimisticMix = useCallback(
    (trackId: string, nextMix: OptimisticMixState) => {
      useTransportStore
        .getState()
        .setOptimisticMix(
          trackId,
          Object.keys(nextMix).length ? nextMix : null,
        );
    },
    [],
  );

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

  const completeOptimisticClipOperation = useCallback(
    (operationId: string, projectRevision: number) => {
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
    },
    [],
  );

  const discardOptimisticClipOperation = useCallback((operationId: string) => {
    setOptimisticClipOperations((current) =>
      current.filter((operation) => operation.id !== operationId),
    );
  }, []);

  const selectedClipSummaries = useMemo(() => {
    if (!song || !selectedClipIds.length) {
      return [];
    }
    const selectedIds = new Set(selectedClipIds);
    return song.clips
      .filter((clip) => selectedIds.has(clip.id))
      .sort(
        (left, right) =>
          left.timelineStartSeconds - right.timelineStartSeconds ||
          left.trackId.localeCompare(right.trackId),
      );
  }, [selectedClipIds, song]);

  const duplicateClipGroup = useCallback(
    async (sourceClips: ClipSummary[], targetStartSeconds?: number) => {
      const currentSong = songRef.current;
      if (!currentSong || !sourceClips.length) {
        return;
      }

      const sortedSourceClips = [...sourceClips].sort(
        (left, right) =>
          left.timelineStartSeconds - right.timelineStartSeconds ||
          left.trackId.localeCompare(right.trackId),
      );
      const sourceStartSeconds = Math.min(
        ...sortedSourceClips.map((clip) => clip.timelineStartSeconds),
      );
      const sourceEndSeconds = Math.max(
        ...sortedSourceClips.map(
          (clip) => clip.timelineStartSeconds + clip.durationSeconds,
        ),
      );
      const groupDurationSeconds = Math.max(
        0,
        sourceEndSeconds - sourceStartSeconds,
      );
      const duplicateCursorKey = sortedSourceClips
        .map(
          (clip) =>
            `${clip.id}:${clip.timelineStartSeconds.toFixed(6)}:${clip.durationSeconds.toFixed(6)}`,
        )
        .join("|");
      const previousDuplicateCursor =
        duplicateClipCursorRef.current[duplicateCursorKey];
      const insertionStartSeconds = Math.max(
        0,
        targetStartSeconds ?? sourceEndSeconds,
        previousDuplicateCursor ?? sourceEndSeconds,
      );
      const placements = sortedSourceClips.map((clip) => ({
        clipId: clip.id,
        timelineStartSeconds:
          insertionStartSeconds +
          (clip.timelineStartSeconds - sourceStartSeconds),
      }));
      const optimisticClips = sortedSourceClips.map((clip, index) => ({
        ...clip,
        id: `optimistic-duplicate-${Date.now()}-${index}`,
        timelineStartSeconds: placements[index].timelineStartSeconds,
      }));
      const optimisticOperationId =
        startOptimisticClipOperation(optimisticClips);

      try {
        const nextSnapshot = await duplicateClips(placements);
        completeOptimisticClipOperation(
          optimisticOperationId,
          nextSnapshot.projectRevision,
        );
        duplicateClipCursorRef.current[duplicateCursorKey] =
          insertionStartSeconds + groupDurationSeconds;
        applyPlaybackSnapshot(nextSnapshot);
      } catch (error) {
        discardOptimisticClipOperation(optimisticOperationId);
        throw error;
      }
    },
    [
      applyPlaybackSnapshot,
      completeOptimisticClipOperation,
      discardOptimisticClipOperation,
      startOptimisticClipOperation,
    ],
  );

  const copySelectedClips = useCallback(() => {
    if (!selectedClipSummaries.length) {
      return false;
    }
    copiedClipsRef.current = selectedClipSummaries;
    return true;
  }, [selectedClipSummaries]);

  const duplicateSelectedClips = useCallback(async () => {
    if (!selectedClipSummaries.length) {
      return false;
    }
    await duplicateClipGroup(selectedClipSummaries);
    return true;
  }, [duplicateClipGroup, selectedClipSummaries]);

  const pasteCopiedClips = useCallback(async () => {
    const copiedClips = copiedClipsRef.current;
    if (!copiedClips.length) {
      return false;
    }
    const sourceIds = new Set(copiedClips.map((clip) => clip.id));
    const currentCopies = (songRef.current?.clips ?? []).filter((clip) =>
      sourceIds.has(clip.id),
    );
    if (!currentCopies.length) {
      return false;
    }
    const targetGroup = selectedClipSummaries.length
      ? selectedClipSummaries
      : currentCopies;
    const targetStartSeconds = Math.max(
      ...targetGroup.map(
        (clip) => clip.timelineStartSeconds + clip.durationSeconds,
      ),
    );
    await duplicateClipGroup(currentCopies, targetStartSeconds);
    return true;
  }, [duplicateClipGroup, selectedClipSummaries]);

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
      if (
        keys.includes("volume") &&
        Math.abs(resolvedMix.volume - track.volume) >= 0.0001
      ) {
        payload.volume = resolvedMix.volume;
      }
      if (
        keys.includes("pan") &&
        Math.abs(resolvedMix.pan - track.pan) >= 0.0001
      ) {
        payload.pan = resolvedMix.pan;
      }

      if (Object.keys(payload).length === 1) {
        clearTrackOptimisticMixKeys(trackId, keys);
        return;
      }

      const requestId = nextTrackMixRequestId(trackId);

      try {
        const nextSnapshot = await commitTrackMixChange(payload);
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
    [
      applyPlaybackSnapshot,
      clearTrackOptimisticMixKeys,
      nextTrackMixRequestId,
      resolveTrackMix,
    ],
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
          const remainingDelay =
            LIVE_TRACK_MIX_MIN_INTERVAL_MS - (now - liveState.lastSentAt);
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

          await updateTrackMixRealtime(payload);
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
        clearTrackOptimisticMixKeys(trackId, [
          "muted",
          "solo",
          "volume",
          "pan",
        ]);
        delete trackMixLiveStatesRef.current[trackId];
        setStatus(formatErrorStatus(error));
      });
    },
    [clearTrackOptimisticMixKeys, flushTrackMixLiveUpdates],
  );

  const flushClipMoveLiveUpdates = useCallback(async (clipId: string) => {
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
      if (
        clipDragRef.current?.clipId !== clipId &&
        !clipMoveCommitPendingRef.current.has(clipId)
      ) {
        clipPreviewSecondsRef.current = {};
      }
    }
  }, []);

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
        if (
          clipDragRef.current?.clipId !== clipId &&
          !clipMoveCommitPendingRef.current.has(clipId)
        ) {
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

  const flushClipMoveBatchLive = useCallback(async () => {
    const state = clipMoveBatchLiveStateRef.current;
    if (!state || state.inFlight) {
      return;
    }
    state.inFlight = true;
    try {
      while (state.queuedMoves !== null) {
        const moves = state.queuedMoves;
        state.queuedMoves = null;
        await moveClipsLiveBatch(moves);
      }
    } finally {
      state.inFlight = false;
    }
  }, []);

  const queueClipMoveBatchLiveUpdate = useCallback(
    (moves: ClipMoveRequest[]) => {
      const state = clipMoveBatchLiveStateRef.current;
      state.queuedMoves = moves;
      void flushClipMoveBatchLive().catch((error) => {
        state.queuedMoves = null;
        state.inFlight = false;
        setStatus(formatErrorStatus(error));
      });
    },
    [flushClipMoveBatchLive, setStatus],
  );

  const waitForClipMoveBatchLiveIdle = useCallback(() => {
    return new Promise<void>((resolve) => {
      const tick = () => {
        const state = clipMoveBatchLiveStateRef.current;
        if (!state.inFlight && state.queuedMoves === null) {
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
      // Mirror the additional .is-dragging tag the compact branch
      // applies in applyTrackDragVisuals so re-opening the view
      // doesn't leave strips faded.
      row.classList.remove("is-dragging");
    });

    draggedTrackHeadersRef.current.forEach((header) => {
      header.classList.remove("is-dragging");
    });

    // Sweep both DAW shell and the document — we don't know here
    // whether the latest drag originated in compact or DAW, and
    // missing a stale indicator would leave the UI in a "stuck
    // highlighted" state.
    const dropTargets = document.querySelectorAll(".is-drop-target");
    dropTargets.forEach((element) => {
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

  // Track create / reorder handlers. See ./tracks/trackHandlers. Reactive state
  // is read through getters (songRef, tracksByIdRef, the timeline UI store) so
  // the factory stays referentially stable across renders.
  const { handleTrackDrop, handleCreateTrack } = useMemo(
    () =>
      createTrackHandlers({
        getSong: () => songRef.current,
        getTracksById: () => tracksByIdRef.current,
        getSelectedTrackIds: () =>
          useTimelineUIStore.getState().selectedTrackIds,
        runAction,
        refreshSongView,
        applyPlaybackSnapshot,
        clearTrackDragVisuals,
        optimisticallyAppliedRevisionsRef,
        setStatus,
        t,
        moveTrack,
        createTrack,
        prompt: (message, defaultValue) => window.prompt(message, defaultValue),
      }),
    [
      runAction,
      refreshSongView,
      applyPlaybackSnapshot,
      clearTrackDragVisuals,
      setStatus,
      t,
    ],
  );

  // MIDI-learn arming handlers. midiLearnMode is read from the timeline UI store
  // through a getter so the factory never has to be re-created. See
  // ./midi/midiLearnHandlers.
  const {
    handleMidiLearnToggle,
    handleMidiLearnTarget,
    handleMidiLearnCommandRelearn,
    handleDynamicMidiLearnJump,
  } = useMemo(
    () =>
      createMidiLearnHandlers({
        getMidiLearnMode: () => useTimelineUIStore.getState().midiLearnMode,
        setMidiLearnMode,
        setIsSettingsModalOpen,
        setIsRemoteModalOpen,
        t,
        prompt: (message) => window.prompt(message),
      }),
    [setMidiLearnMode, t],
  );

  const applyTrackDragVisuals = useCallback(
    (dragState: NonNullable<TrackDragState>, dropState: TrackDropState) => {
      const isCompact = dragState.originSurface === "compact";
      const deltaY = dragState.currentClientY - dragState.startClientY;
      const deltaX = dragState.currentClientX - dragState.startClientX;

      // Selector lists vary by origin: DAW drags grab both the
      // header row and the lane row so they translate together;
      // compact drags grab the single mixer strip. data-track-id is
      // present on all three so the same querySelector works.
      const dragSelector = (trackId: string) =>
        isCompact
          ? `.lt-compact-mixer-strip[data-track-id="${trackId}"]`
          : `.lt-track-header-row[data-track-id="${trackId}"], .lt-track-lane-row[data-track-id="${trackId}"]`;

      if (draggedTrackRowRef.current !== dragState.rowElement) {
        clearTrackDragVisuals();
        draggedTrackRowRef.current = dragState.rowElement;

        const dragTrackIds =
          selectedTrackIds.includes(dragState.trackId) &&
          selectedTrackIds.length > 1
            ? selectedTrackIds
            : [dragState.trackId];
        const draggedRows: HTMLDivElement[] = [];
        const draggedHeaders: HTMLElement[] = [];

        // Compact strips live outside the DAW shell, so for compact
        // drags we query the document directly. DAW drags stay scoped
        // to the shell to avoid accidentally matching unrelated rows
        // in side panels.
        const dragRoot: ParentNode =
          isCompact ? document : (timelineShellRef.current ?? document);
        dragTrackIds.forEach((trackId) => {
          const matchingRows = dragRoot.querySelectorAll(
            dragSelector(trackId),
          );

          matchingRows?.forEach((element) => {
            if (
              !(element instanceof HTMLDivElement) ||
              draggedRows.includes(element)
            ) {
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
        row.style.transform = isCompact
          ? `translate3d(${deltaX}px, 0, 0)`
          : `translate3d(0, ${deltaY}px, 0)`;
        row.style.zIndex = "8";
        row.style.pointerEvents = "none";
        // Compact strips don't have an inner .lt-track-header child to
        // tag, so we tag the row (which IS the strip) directly so the
        // is-dragging CSS picks it up.
        if (isCompact) {
          row.classList.add("is-dragging");
        }
      });

      draggedTrackHeadersRef.current.forEach((header) => {
        header.classList.add("is-dragging");
      });

      const indicatorRoot: ParentNode =
        isCompact ? document : (timelineShellRef.current ?? document);
      const dropTargets = indicatorRoot.querySelectorAll(".is-drop-target");
      dropTargets?.forEach((element) => {
        if (
          element instanceof HTMLElement &&
          element.dataset.trackId !== dropState?.targetTrackId
        ) {
          element.classList.remove(
            "is-drop-target",
            "is-drop-before",
            "is-drop-after",
            "is-drop-inside-folder",
          );
        }
      });

      if (dropState?.targetTrackId) {
        const nextDropRows = indicatorRoot.querySelectorAll(
          `[data-track-id="${dropState.targetTrackId}"]`,
        );
        nextDropRows?.forEach((element) => {
          element.classList.remove(
            "is-drop-before",
            "is-drop-after",
            "is-drop-inside-folder",
          );
          element.classList.add("is-drop-target", `is-drop-${dropState.mode}`);
        });
      }

      droppedTrackRowRef.current = null;
      trackDropStateRef.current = dropState;
    },
    [clearTrackDragVisuals, selectedTrackIds],
  );

  function transportSnapshotKey(nextSnapshot: TransportSnapshot) {
    return [
      nextSnapshot.playbackState,
      nextSnapshot.positionSeconds.toFixed(6),
      nextSnapshot.transportClock?.anchorPositionSeconds?.toFixed(6) ?? "none",
      nextSnapshot.transportClock?.running ? "1" : "0",
      String(nextSnapshot.projectRevision),
    ].join("|");
  }

  function resolvePendingJumpTargetSeconds(
    pendingJump: PendingJumpSummary,
    effectSong: SongView | null,
  ) {
    if (!effectSong) {
      return null;
    }

    const targetRegion = effectSong.regions.find(
      (region) => region.id === pendingJump.targetMarkerId,
    );
    if (targetRegion) {
      return targetRegion.startSeconds;
    }

    const targetMarker = effectSong.sectionMarkers.find(
      (marker) => marker.id === pendingJump.targetMarkerId,
    );
    return targetMarker?.startSeconds ?? null;
  }

  function resolveVisualPositionAcrossPendingJump(positionSeconds: number) {
    const snapshot = snapshotRef.current;
    const pendingJump = snapshot?.pendingMarkerJump;
    if (
      !snapshot ||
      !pendingJump ||
      snapshot.playbackState !== "playing" ||
      positionSeconds < pendingJump.executeAtSeconds
    ) {
      return positionSeconds;
    }

    const targetSeconds = resolvePendingJumpTargetSeconds(
      pendingJump,
      songRef.current,
    );
    if (targetSeconds === null) {
      return positionSeconds;
    }

    const overshootSeconds = Math.max(
      0,
      positionSeconds - pendingJump.executeAtSeconds,
    );
    return targetSeconds + overshootSeconds;
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

  useEffect(() => {
    const syncPlaybackSnapshot = (nextSnapshot: TransportSnapshot | null) => {
      const previousSnapshot = snapshotRef.current;
      snapshotRef.current = nextSnapshot;

      if (!nextSnapshot) {
        playbackVisualAnchorRef.current = {
          anchorPositionSeconds: 0,
          anchorReceivedAtMs: performance.now(),
          durationSeconds:
            timelineDurationSecondsRef.current ||
            songDurationSecondsRef.current,
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

      const forceReanchor = forceReanchorOnNextSnapshotRef.current;
      forceReanchorOnNextSnapshotRef.current = false;

      const shouldPreserveVisualAnchor =
        !forceReanchor &&
        !anchorMeta &&
        previousSnapshot?.playbackState === "playing" &&
        nextSnapshot.playbackState === "playing" &&
        previousSnapshot.projectRevision === nextSnapshot.projectRevision &&
        previousSnapshot.transportClock?.lastJumpPositionSeconds ===
          nextSnapshot.transportClock?.lastJumpPositionSeconds &&
        previousSnapshot.transportClock?.lastSeekPositionSeconds ===
          nextSnapshot.transportClock?.lastSeekPositionSeconds &&
        playbackVisualAnchorRef.current.running &&
        Boolean(nextSnapshot.transportClock?.running);

      if (shouldPreserveVisualAnchor) {
        const polledAnchorPosition =
          nextSnapshot.transportClock?.anchorPositionSeconds ??
          nextSnapshot.positionSeconds;
        const visualDriftSeconds = Math.abs(
          resolveCurrentVisualPosition() - polledAnchorPosition,
        );

        if (
          visualDriftSeconds <= PLAYBACK_SNAPSHOT_REANCHOR_TOLERANCE_SECONDS
        ) {
          return;
        }
      }

      applyTransportVisualAnchor(nextSnapshot, anchorMeta);
    };

    syncPlaybackSnapshot(useTransportStore.getState().playback);

    return useTransportStore.subscribe(
      (state) => state.playback,
      syncPlaybackSnapshot,
    );
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
        setAudioDeviceDescriptors(nextAudioDevices.deviceDescriptors ?? []);
        setAudioOutputChannelCounts(nextAudioDevices.channelCounts ?? {});
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

  useTransportLifecycle({
    applyPlaybackSnapshot,
    transportAnchorMetaRef,
    setStatus,
    t,
  });

  useAudioMeters();
  useRegionMeters();

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

      if (
        playbackSongDir &&
        event.songDir !== playbackSongDir.replace(/\\/g, "/")
      ) {
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

  const handleSelectedRegionTransposeChange = useCallback(
    (nextTransposeSemitones: number) => {
      if (!selectedRegion) {
        return;
      }

      const clampedTransposeSemitones = Math.max(
        -12,
        Math.min(12, Math.round(nextTransposeSemitones)),
      );
      if (clampedTransposeSemitones === selectedRegion.transposeSemitones) {
        return;
      }

      const targetRegionId = selectedRegion.id;
      const targetRegionName = selectedRegion.name;
      void runAction(async () => {
        setPitchPrepareUiState({
          active: true,
          message: "Aplicando cambio de tono...",
          startedAt: Date.now(),
        });
        const nextSnapshot = await updateSongRegionTranspose(
          targetRegionId,
          clampedTransposeSemitones,
        );
        // Refetch the SongView: under the Ableton-style semantics, a region
        // transpose change with warp OFF resizes every overlapping clip
        // (varispeed shrinks/expands duration by 2^(st/12)). The old
        // optimistic patch only touched the region's transposeSemitones and
        // left clip durations stale, so the UI showed the wrong clip width
        // until the next structural mutation. Skipping waveforms keeps this
        // cheap (~50ms IPC).
        await refreshSongView({ includeWaveforms: false, sync: true });
        applyPlaybackSnapshot(nextSnapshot);
        setStatus(
          t("transport.status.regionTransposeUpdated", {
            name: targetRegionName,
            transpose: formatTransposeSemitones(clampedTransposeSemitones),
          }),
        );
      });
    },
    [applyPlaybackSnapshot, runAction, selectedRegion, setStatus, t],
  );

  // Warp: keep the same shape as transpose handler. The IPC carries both
  // the toggle and the source BPM; when enabling for the first time we
  // auto-fill source BPM with the timeline's effective tempo at the region
  // start so the initial ratio is 1.0 (no audible change). The user then
  // fine-tunes via the +/- stepper.
  const handleSelectedRegionWarpToggle = useCallback(
    (nextEnabled: boolean) => {
      if (!selectedRegion) return;
      const targetRegionId = selectedRegion.id;
      const previousSourceBpm = selectedRegion.warpSourceBpm;
      // When enabling and no source BPM has been configured, seed it with the
      // effective tempo at the region start. When disabling we pass null so the
      // backend leaves the previously-configured value untouched.
      const effectiveBpm = getEffectiveBpmAt(song, selectedRegion.startSeconds);
      const sourceBpm = nextEnabled
        ? (previousSourceBpm ?? effectiveBpm)
        : null;
      void runAction(async () => {
        const nextSnapshot = await updateSongRegionWarp(
          targetRegionId,
          nextEnabled,
          sourceBpm,
        );
        // Refetch the SongView: toggling warp can flip overlapping clips
        // between Bungee (warp-on) and Varispeed (warp-off + pitch), and
        // both paths produce different audible durations than Direct. The
        // old optimistic patch left clip widths stale until the next
        // structural mutation.
        await refreshSongView({ includeWaveforms: false, sync: true });
        applyPlaybackSnapshot(nextSnapshot);
      });
    },
    [applyPlaybackSnapshot, refreshSongView, runAction, selectedRegion, song],
  );

  // Master gain handlers follow the track-volume pattern: during drag the
  // slider writes an optimistic value to the store (so the thumb tracks the
  // pointer with no IPC delay) and streams realtime updates to the engine;
  // on pointer-up we commit (writes model, records undo, returns snapshot).
  const handleSelectedRegionMasterGainChange = useCallback(
    (nextMasterGain: number) => {
      if (!selectedRegion) return;
      const clamped = Math.max(0, Math.min(2, nextMasterGain));
      const targetRegionId = selectedRegion.id;
      useTransportStore
        .getState()
        .setOptimisticRegionMaster(targetRegionId, clamped);
      void updateLiveRegionMasterGain(targetRegionId, clamped).catch(() => {
        // Realtime stream is best-effort; commit on pointer-up will
        // reconcile the truth.
      });
    },
    [selectedRegion],
  );

  const handleSelectedRegionMasterGainCommit = useCallback(() => {
    if (!selectedRegion) return;
    const targetRegionId = selectedRegion.id;
    const optimistic =
      useTransportStore.getState().optimisticRegionMaster[targetRegionId];
    if (optimistic === undefined) return;
    void runAction(async () => {
      try {
        const nextSnapshot = await updateSongRegionMasterGain(
          targetRegionId,
          optimistic,
        );
        applyPlaybackSnapshot(nextSnapshot);
      } finally {
        useTransportStore
          .getState()
          .setOptimisticRegionMaster(targetRegionId, null);
      }
    });
  }, [applyPlaybackSnapshot, runAction, selectedRegion]);

  // Effective timeline BPM at the start of the selected region — the warp
  // panel uses this both for display (× ratio) and as the default source
  // BPM when the user enables warp for the first time.
  const selectedRegionEffectiveBpm = selectedRegion
    ? getEffectiveBpmAt(song, selectedRegion.startSeconds)
    : getSongBaseBpm(song);

  // For the compact view: the flat list of clips that fall inside each
  // region, sorted by the track ordering of the project (so the column
  // reads top-to-bottom in the same order the user sees tracks in the DAW
  // header pane). Each entry carries the clip name + the track name so the
  // cell can label which track the clip belongs to without a separate
  // label column.
  // Effective BPM at the start of each song. The compact view shows this
  // next to the song name so the user reads "what tempo plays here" at a
  // glance, regardless of whether the song has its own tempo marker or
  // inherits the global one.
  const bpmByRegion = useMemo(() => {
    const map: Record<string, number> = {};
    if (!song) return map;
    for (const region of song.regions) {
      map[region.id] = getEffectiveBpmAt(song, region.startSeconds);
    }
    return map;
  }, [song]);

  const clipsByRegion = useMemo(() => {
    const byRegion: Record<
      string,
      {
        id: string;
        clipName: string;
        trackId: string;
        trackName: string;
        trackColor?: string | null;
      }[]
    > = {};
    if (!song) return byRegion;
    const trackOrderIndex = new Map<string, number>();
    const trackNameById = new Map<string, string>();
    const trackColorById = new Map<string, string | null | undefined>();
    song.tracks.forEach((track, index) => {
      trackOrderIndex.set(track.id, index);
      trackNameById.set(track.id, track.name);
      trackColorById.set(track.id, track.color);
    });
    for (const region of song.regions) {
      byRegion[region.id] = [];
    }
    for (const clip of song.clips) {
      const region = song.regions.find(
        (r) =>
          clip.timelineStartSeconds >= r.startSeconds &&
          clip.timelineStartSeconds < r.endSeconds,
      );
      if (!region) continue;
      const fileName =
        clip.filePath?.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ??
        clip.id;
      byRegion[region.id].push({
        id: clip.id,
        clipName: fileName,
        trackId: clip.trackId,
        trackName: trackNameById.get(clip.trackId) ?? clip.trackId,
        trackColor: trackColorById.get(clip.trackId),
      });
    }
    // Sort each region's clip list by the track order of the project so
    // the column reflects the DAW's vertical track layout.
    for (const regionId of Object.keys(byRegion)) {
      byRegion[regionId].sort((a, b) => {
        const ia = trackOrderIndex.get(a.trackId) ?? Number.MAX_SAFE_INTEGER;
        const ib = trackOrderIndex.get(b.trackId) ?? Number.MAX_SAFE_INTEGER;
        return ia - ib;
      });
    }
    return byRegion;
  }, [song]);

  // The compact view needs a per-region master-gain commit that knows its
  // region id directly (the toolbar version reads selectedRegion from
  // context). We adapt the existing handlers to accept an explicit id.
  const handleCompactMasterGainChange = useCallback(
    (regionId: string, gain: number) => {
      const clamped = Math.max(0, Math.min(2, gain));
      useTransportStore
        .getState()
        .setOptimisticRegionMaster(regionId, clamped);
      void updateLiveRegionMasterGain(regionId, clamped).catch(() => {
        // best-effort; commit reconciles
      });
    },
    [],
  );

  const handleCompactMasterGainCommit = useCallback(
    (regionId: string) => {
      const optimistic =
        useTransportStore.getState().optimisticRegionMaster[regionId];
      if (optimistic === undefined) return;
      void runAction(async () => {
        try {
          const nextSnapshot = await updateSongRegionMasterGain(
            regionId,
            optimistic,
          );
          applyPlaybackSnapshot(nextSnapshot);
        } finally {
          useTransportStore
            .getState()
            .setOptimisticRegionMaster(regionId, null);
        }
      });
    },
    [applyPlaybackSnapshot, runAction],
  );

  // Drop handlers for the compact view's song columns. Two flavours:
  //
  //  - OS file drag: the user dragged audio files from Explorer / Finder
  //    straight into a song column. We run them through the same import
  //    pipeline the DAW uses (resolveNativeAudioImportPayloads → backend
  //    importAudioFiles*), then send the resulting library paths to
  //    createClipsWithAutoTracks so each file lands on its own auto-track.
  //
  //  - Library asset drag: the LibrarySidebarPanel emits the same payload
  //    the DAW timeline already consumes. Each entry already carries a
  //    file_path inside the project folder, so we skip the import step
  //    and go straight to createClipsWithAutoTracks.
  //
  // In both cases the new clip lands at the song's start_seconds. The
  // backend extends the region if the clip is longer than the existing
  // placeholder (step 4.4) and prunes the auto-track later if the user
  // moves the clip off it.
  // Library auto-organisation for the compact view: a song's name
  // doubles as a Library folder name. When audios are imported by
  // dropping them onto a song column, we make sure that folder exists
  // and we move the *newly-imported* assets into it. Assets that
  // already lived in another folder are respected — the user's manual
  // organisation wins. Empty song name = skip (we don't create a
  // folder for "").
  const assignAssetsToSongFolder = useCallback(
    async (songName: string, assets: LibraryAssetSummary[]) => {
      const folderName = songName.trim();
      if (!folderName || assets.length === 0) return assets;
      // 1) Ensure the folder. createLibraryFolder is idempotent (the
      //    backend just adds it to the manifest if missing and returns
      //    the full folder list).
      try {
        await createLibraryFolder(folderName);
      } catch {
        // If creation fails (already exists / name collision), keep
        // going — the move below will still place the assets.
      }
      // 2) Move only the assets that were freshly created with no
      //    folder assignment yet. moveLibraryAsset returns the full
      //    updated asset list every time, so we just keep the last
      //    response as the canonical state.
      let latest: LibraryAssetSummary[] = assets;
      for (const asset of assets) {
        if (asset.folderPath && asset.folderPath.trim().length > 0) {
          continue;
        }
        try {
          latest = await moveLibraryAsset(asset.filePath, folderName);
        } catch {
          // Per-asset failure shouldn't abort the whole batch.
        }
      }
      mergeLibraryAssets(latest);
      await refreshLibraryState({ preserveAssets: latest });
      return latest;
    },
    [mergeLibraryAssets, refreshLibraryState],
  );

  const isLibraryFolderInBranch = useCallback(
    (folderPath: string, branchRoot: string) =>
      folderPath === branchRoot || folderPath.startsWith(`${branchRoot}/`),
    [],
  );

  const resolveRenamedLibraryFolderBranch = useCallback(
    (folderPath: string, oldFolderPath: string, newFolderPath: string) => {
      if (folderPath === oldFolderPath) {
        return newFolderPath;
      }

      const suffix = folderPath.slice(oldFolderPath.length).replace(/^\/+/, "");
      return suffix ? `${newFolderPath}/${suffix}` : newFolderPath;
    },
    [],
  );

  const syncSongLibraryFolderAfterRename = useCallback(
    async (oldSongName: string, newSongName: string) => {
      const oldFolderPath = oldSongName.trim();
      const newFolderPath = newSongName.trim();
      if (!oldFolderPath || !newFolderPath || oldFolderPath === newFolderPath) {
        return;
      }

      const { assets, folders } = await loadLibraryState();
      const oldFolderExists =
        folders.includes(oldFolderPath) ||
        assets.some((asset) => asset.folderPath === oldFolderPath);
      if (!oldFolderExists) {
        return;
      }

      const newFolderExists =
        folders.includes(newFolderPath) ||
        assets.some((asset) => asset.folderPath === newFolderPath);

      let nextAssets: LibraryAssetSummary[] = assets;
      if (!newFolderExists) {
        nextAssets = await renameLibraryFolder(oldFolderPath, newFolderPath);
      } else {
        for (const asset of assets) {
          if (
            !asset.folderPath ||
            !isLibraryFolderInBranch(asset.folderPath, oldFolderPath)
          ) {
            continue;
          }

          nextAssets = await moveLibraryAsset(
            asset.filePath,
            resolveRenamedLibraryFolderBranch(
              asset.folderPath,
              oldFolderPath,
              newFolderPath,
            ),
          );
        }
        nextAssets = await deleteLibraryFolder(oldFolderPath);
      }

      const { folders: nextFolders } = await loadLibraryState();
      setLibraryAssets(nextAssets);
      setLibraryFolders(nextFolders);
    },
    [
      isLibraryFolderInBranch,
      loadLibraryState,
      resolveRenamedLibraryFolderBranch,
      setLibraryAssets,
      setLibraryFolders,
    ],
  );

  const handleCompactDropOsFilesIntoSong = useCallback(
    (regionId: string, files: File[]) => {
      const region = song?.regions.find((r) => r.id === regionId);
      if (!region) return;
      // Reject unsupported file types up front. Mixed drops (some
      // valid + some invalid) are also refused outright rather than
      // silently importing the valid subset, because the user just
      // dragged a batch and "some imported, some skipped" hides
      // failures. Status: see status.unsupportedDropRejected i18n.
      const accepted = files.filter((file) =>
        isAcceptedDroppedFileName(file.name),
      );
      const hasUnsupported = accepted.length !== files.length;
      // .ltpkg dropped onto a column is also invalid — packages go to
      // the strip, not into an existing song. Treat as unsupported.
      const hasPackage = accepted.some((file) =>
        file.name.toLowerCase().endsWith(".ltpkg"),
      );
      if (hasUnsupported || hasPackage || accepted.length === 0) {
        setStatus(
          t("transport.status.unsupportedDrop", {
            defaultValue: "Tipo de archivo no admitido",
          }),
        );
        return;
      }
      const dropSeconds = region.startSeconds;
      void runAction(async () => {
        const nativePayloads = isTauriApp
          ? resolveNativeAudioImportPayloads(accepted)
          : null;
        let importedAssets: LibraryAssetSummary[] = [];
        if (nativePayloads) {
          importedAssets = await importAudioFilesFromPaths(nativePayloads);
        } else {
          const byteloads = await Promise.all(
            accepted.map(async (file) => ({
              fileName: file.name,
              bytes: new Uint8Array(await file.arrayBuffer()),
            })),
          );
          importedAssets = await importAudioFilesFromBytes(byteloads);
        }
        mergeLibraryAssets(importedAssets);
        await refreshLibraryState({ preserveAssets: importedAssets });
        if (importedAssets.length === 0) return;
        // Auto-place the freshly imported assets in the song's Library
        // folder (creating it if needed). Assets that already had a
        // folder are respected.
        await assignAssetsToSongFolder(region.name, importedAssets);
        const snapshot = await createClipsWithAutoTracks(
          importedAssets.map((asset) => ({
            filePath: asset.filePath,
            timelineStartSeconds: dropSeconds,
          })),
        );
        applyPlaybackSnapshot(snapshot);
        setStatus(
          importedAssets.length === 1
            ? t("transport.status.clipAdded", {
                name: importedAssets[0].fileName,
              })
            : t("transport.status.clipsAdded", {
                count: importedAssets.length,
              }),
        );
      });
    },
    [
      applyPlaybackSnapshot,
      assignAssetsToSongFolder,
      mergeLibraryAssets,
      refreshLibraryState,
      runAction,
      setStatus,
      song,
      t,
    ],
  );

  const handleCompactDropLibraryAssetsIntoSong = useCallback(
    (
      regionId: string,
      payload: Array<{ filePath: string; durationSeconds?: number }>,
    ) => {
      const region = song?.regions.find((r) => r.id === regionId);
      if (!region || payload.length === 0) return;
      const dropSeconds = region.startSeconds;
      void runAction(async () => {
        const snapshot = await createClipsWithAutoTracks(
          payload.map((item) => ({
            filePath: item.filePath,
            timelineStartSeconds: dropSeconds,
          })),
        );
        applyPlaybackSnapshot(snapshot);
      });
    },
    [applyPlaybackSnapshot, runAction, song],
  );

  // Imports a .ltpkg as a new song appended at the end of the project.
  // The previous logic was "lastEnd + one bar at the project's global
  // BPM", which broke as soon as the last region's end didn't fall on a
  // downbeat (because the user trimmed the region, or because a tempo
  // marker changed the grid mid-song). The correct anchor is the first
  // real downbeat at or after `lastEnd`, computed from the project's
  // tempo regions — that way the imported song always starts on a bar
  // line regardless of how the previous song ended.
  //
  // The first song in an empty project still anchors at 0 (no leading
  // silence), same rule as create_empty_song.
  const runCompactSongPackageImport = useCallback(
    async (packagePath: string) => {
      const currentSong = song;
      if (!currentSong) return;
      const lastEnd = currentSong.regions.reduce(
        (acc, region) => Math.max(acc, region.endSeconds),
        0,
      );
      const isFirstSong = currentSong.regions.length === 0;
      const insertAt = isFirstSong
        ? 0
        : nextDownbeatAfter(
            lastEnd,
            getSongBaseBpm(currentSong),
            getSongBaseTimeSignature(currentSong),
            buildSongTempoRegions(currentSong),
          );
      await handleDroppedSongPackagePath(packagePath, insertAt);
    },
    // handleDroppedSongPackagePath is a function declaration in this
    // component body — included for exhaustive-deps even though its
    // identity is stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [song],
  );

  // File-dialog entry point for "Importar canción…" in the compact view.
  // Opens the same .ltpkg picker the DAW context-menu export uses, then
  // appends the chosen package at the end of the project.
  const handleCompactImportSongPackageFromDialog = useCallback(() => {
    void runAction(
      async () => {
        const picked = await open({
          multiple: false,
          directory: false,
          filters: [{ name: "LibreTracks Package", extensions: ["ltpkg"] }],
        });
        const path = typeof picked === "string" ? picked : null;
        if (!path) return;
        await runCompactSongPackageImport(path);
      },
      { busy: true },
    );
  }, [runAction, runCompactSongPackageImport]);

  // OS-drag of a .ltpkg dropped anywhere over the compact song strip.
  // When running under Tauri we can resolve the absolute path; in the
  // browser fallback we'd have no path to feed import_song_package, so
  // we silently no-op there.
  const handleCompactImportSongPackageFromOsFile = useCallback(
    (file: File) => {
      void runAction(
        async () => {
          const payloads = isTauriApp
            ? resolveNativeAudioImportPayloads([file])
            : null;
          const nativePath = payloads?.[0]?.sourcePath;
          if (!nativePath) return;
          await runCompactSongPackageImport(nativePath);
        },
        { busy: true },
      );
    },
    [runAction, runCompactSongPackageImport],
  );

  // Per-clip context menu handlers from the compact view.
  const handleCompactMoveClipToTrack = useCallback(
    (clipId: string, targetTrackId: string) => {
      void runAction(async () => {
        const snapshot = await moveClipToTrack({ clipId, targetTrackId });
        applyPlaybackSnapshot(snapshot);
      });
    },
    [applyPlaybackSnapshot, runAction],
  );

  const handleCompactDeleteClip = useCallback(
    (clipId: string) => {
      void runAction(async () => {
        const snapshot = await deleteClip(clipId);
        applyPlaybackSnapshot(snapshot);
      });
    },
    [applyPlaybackSnapshot, runAction],
  );

  const {
    handleSaveProjectClick,
    handleSaveProjectAsClick,
    handleCreateSongClick,
    handleOpenProjectClick,
    handleImportSongClick,
  } = useProjectActions({
    runAction,
    applyPlaybackSnapshot,
    setProjectViewHydrating: setIsProjectViewHydrating,
    setBusyFeedback,
    registerProjectLoadProgressListener,
    refreshSongView,
    refreshLibraryState,
    t,
    setStatus,
    setActiveSidebarTab,
  });

  const {
    scheduleMarkerJumpWithGlobalMode,
    scheduleRegionJumpWithOptions,
    handleNextSongClick,
    toggleTimelineVamp,
  } = useTimelineActions({
    appSettings,
    song,
    snapshotRef,
    displayPositionSecondsRef,
    selectedRegionId,
    setSelectedRegionId,
    applyPlaybackSnapshot,
    forcePlaybackVisualAnchor: applyTransportVisualAnchor,
    setStatus,
    t,
    handleSelectedRegionTransposeChange,
  });

  // Per-song play button in the compact view: routes through the same
  // scheduleRegionJumpWithOptions path the Shift+digit keyboard shortcut
  // uses, so the user gets exactly the global "song jump" behaviour
  // (immediate / after-bars / region-end + instant / fade-out transition)
  // configured from the toolbar.
  const handleCompactPlaySong = useCallback(
    (regionId: string, regionName: string) => {
      void runAction(async () => {
        // If the transport is already running, route through the
        // shared scheduler so the song-jump respects the global
        // transition mode (immediate / next marker / region end / etc.)
        // configured in the toolbar — same path the Shift+digit
        // shortcut takes.
        //
        // If the transport is NOT running yet, scheduling a jump
        // would just queue it and the user wouldn't hear anything.
        // Instead, jump the playhead to the song's start and start
        // playback. This matches the natural expectation of "I
        // clicked play on this song, please play it".
        if (playbackState === "playing") {
          await scheduleRegionJumpWithOptions(regionId, regionName);
          return;
        }
        const targetRegion = songRef.current?.regions.find(
          (region) => region.id === regionId,
        );
        if (!targetRegion) return;
        await performSeek(targetRegion.startSeconds);
        const nextSnapshot = await playTransport();
        applyPlaybackSnapshot(nextSnapshot);
        setStatus(
          t("transport.status.songStarted", {
            name: regionName,
            defaultValue: `Reproduciendo ${regionName}`,
          }),
        );
      });
    },
    [
      applyPlaybackSnapshot,
      performSeek,
      playbackState,
      runAction,
      scheduleRegionJumpWithOptions,
      setStatus,
      t,
    ],
  );

  // Rename song via window.prompt, the same way the DAW track header's
  // "Renombrar" context-menu entry works. We keep the song's existing
  // bounds + transpose; only the name changes.
  const handleCompactRenameSong = useCallback(
    (regionId: string) => {
      const currentRegion = songRef.current?.regions.find(
        (region) => region.id === regionId,
      );
      if (!currentRegion) return;
      const nextName = window
        .prompt("Renombrar canción", currentRegion.name)
        ?.trim();
      if (!nextName || nextName === currentRegion.name) return;
      void runAction(async () => {
        const snapshot = await updateSongRegion(
          regionId,
          nextName,
          currentRegion.startSeconds,
          currentRegion.endSeconds,
        );
        applyPlaybackSnapshot(snapshot);
        await syncSongLibraryFolderAfterRename(currentRegion.name, nextName);
        setStatus(`Canción renombrada como "${nextName}"`);
      });
    },
    [applyPlaybackSnapshot, runAction, setStatus, syncSongLibraryFolderAfterRename],
  );

  // Set BPM for a song. Always inserts (or replaces) a tempo marker at the
  // song's start_seconds — we agreed this stays consistent whether the song
  // is the project's first or not, so reordering songs never silently
  // changes which tempo applies to which section. Backend's
  // upsertSongTempoMarker semantics handle the "create-or-replace" part.
  const handleCompactSetSongBpm = useCallback(
    (regionId: string) => {
      const currentSong = songRef.current;
      const currentRegion = currentSong?.regions.find(
        (region) => region.id === regionId,
      );
      if (!currentSong || !currentRegion) return;
      const currentBpm = getEffectiveBpmAt(
        currentSong,
        currentRegion.startSeconds,
      );
      const raw = window.prompt(
        `BPM de "${currentRegion.name}"`,
        currentBpm.toFixed(2),
      );
      if (raw === null) return;
      const nextBpm = Number(raw.replace(",", "."));
      if (!Number.isFinite(nextBpm) || nextBpm <= 0) {
        setStatus("BPM inválido");
        return;
      }
      void runAction(async () => {
        const snapshot = await upsertSongTempoMarker(
          currentRegion.startSeconds,
          nextBpm,
        );
        applyPlaybackSnapshot(snapshot);
        setStatus(
          `BPM de "${currentRegion.name}" ajustado a ${nextBpm.toFixed(2)}`,
        );
      });
    },
    [applyPlaybackSnapshot, runAction, setStatus],
  );

  // Delete a song from the compact view. Confirms via window.confirm when
  // the song still holds clips since the backend will take them with it
  // (the new delete_song_region also evicts clips inside the region and
  // tempo markers that lived in its range). Same pattern the DAW's
  // songRegionContextMenu uses.
  const handleCompactDeleteSong = useCallback(
    (regionId: string) => {
      const currentSong = songRef.current;
      const currentRegion = currentSong?.regions.find(
        (region) => region.id === regionId,
      );
      if (!currentSong || !currentRegion) return;
      const clipCount = currentSong.clips.filter(
        (clip) =>
          clip.timelineStartSeconds >= currentRegion.startSeconds &&
          clip.timelineStartSeconds < currentRegion.endSeconds,
      ).length;
      if (clipCount > 0) {
        const confirmed = window.confirm(
          `Borrar canción "${currentRegion.name}" y sus ${clipCount} ${
            clipCount === 1 ? "clip" : "clips"
          }?`,
        );
        if (!confirmed) return;
      }
      void runAction(async () => {
        const snapshot = await deleteSongRegion(regionId);
        applyPlaybackSnapshot(snapshot);
        setSelectedRegionId(null);
        setStatus(`Canción "${currentRegion.name}" eliminada`);
      });
    },
    [applyPlaybackSnapshot, runAction, setSelectedRegionId, setStatus],
  );

  // Export the song as a LibreTracks package (.ltpkg). Reuses the exact
  // same backend command the DAW's "Exportar Canción" right-click action
  // calls, so the output format and file-dialog flow are identical
  // regardless of which view triggered the export.
  const handleCompactExportSong = useCallback(
    (regionId: string) => {
      const currentRegion = songRef.current?.regions.find(
        (region) => region.id === regionId,
      );
      if (!currentRegion) return;
      // Open the Light/Full chooser; the actual export runs on confirm.
      setExportSongTarget({ regionId, regionName: currentRegion.name });
    },
    [setExportSongTarget],
  );

  // Runs the export once the user picked a mode in the ExportSongModal.
  const handleConfirmExportSong = useCallback(
    (regionId: string, includeAudio: boolean) => {
      const currentRegion = songRef.current?.regions.find(
        (region) => region.id === regionId,
      );
      setExportSongTarget(null);
      void runAction(
        async () => {
          await exportRegionAsPackage(regionId, includeAudio);
          setStatus(
            `Paquete exportado para ${currentRegion?.name ?? "la canción"}`,
          );
        },
        { busy: true },
      );
    },
    [runAction, setStatus],
  );

  useEffect(() => {
    const selectedMidiDevice = appSettings.selectedMidiDevice;
    if (!selectedMidiDevice) {
      setMissingMidiDeviceWarning(null);
      return;
    }

    if (appSettings.suppressMissingMidiDeviceWarning) {
      setMissingMidiDeviceWarning(null);
      return;
    }

    if (hasShownMissingMidiDeviceWarningRef.current) {
      setMissingMidiDeviceWarning(null);
      return;
    }

    if (midiInputDevices.includes(selectedMidiDevice)) {
      setMissingMidiDeviceWarning(null);
      return;
    }

    hasShownMissingMidiDeviceWarningRef.current = true;
    setMissingMidiDeviceWarning(selectedMidiDevice);
  }, [
    appSettings.selectedMidiDevice,
    appSettings.suppressMissingMidiDeviceWarning,
    midiInputDevices,
  ]);

  useEffect(() => {
    const shell = timelineShellRef.current;
    if (!shell) {
      return;
    }

    const updateViewportWidth = () => {
      const paneWidth =
        rulerTrackRef.current?.clientWidth ??
        laneAreaRef.current?.clientWidth ??
        null;
      const fallbackWidth = Math.max(
        320,
        (timelineScrollViewportRef.current?.clientWidth ??
          shell.clientWidth ??
          DEFAULT_TIMELINE_VIEWPORT_WIDTH) - HEADER_WIDTH,
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
    // viewMode is in the deps so that toggling back to the DAW remounts
    // the timeline shell with fresh refs — without it the ResizeObserver
    // would still be wired to the previous (now-unmounted) shell element
    // and the lane viewport would stay frozen at whatever width it had
    // before the compact view took over. Result on a wide window:
    // ~1/3 of the timeline visible, big black gap to the right.
  }, [song?.tracks.length, viewMode]);

  useEffect(() => {
    let active = true;

    // If this revision was produced by a local optimistic mutation, the
    // frontend already applied the change and there is nothing new to learn
    // from the server. Skip the refetch entirely.
    if (
      optimisticallyAppliedRevisionsRef.current.has(playbackProjectRevision)
    ) {
      optimisticallyAppliedRevisionsRef.current.delete(playbackProjectRevision);
      return;
    }

    async function loadSong() {
      if (playbackProjectRevision === 0) {
        setSong(null);
        setIsProjectViewHydrating(false);
        waveformsHydratedRef.current = false;
        return;
      }

      // First load needs the full SongView with waveforms; subsequent
      // revision bumps (transpose, gain, mute, region edit, …) only need
      // the structural mutations — the waveform cache is still valid.
      // Use a ref (not songRef which lags by one render) so that overlapping
      // effect runs during the initial load don't all race to fetch
      // waveforms before the first setSong has committed.
      const needsWaveforms = !waveformsHydratedRef.current;
      // Reserve the slot *before* awaiting so a concurrent revision bump
      // sees needsWaveforms=false and skips the redundant 27 MB fetch.
      if (needsWaveforms) {
        waveformsHydratedRef.current = true;
      }
      const nextSong = await getSongView({ includeWaveforms: needsWaveforms });
      if (!active) {
        return;
      }

      if (!needsWaveforms && nextSong) {
        // Preserve previously hydrated waveforms.
        const previous = songRef.current;
        setSong({ ...nextSong, waveforms: previous?.waveforms ?? [] });
      } else {
        hydrateWaveformCacheFromSong(nextSong);
        setSong(nextSong);
        if (!nextSong) {
          // Fetched-with-waveforms returned null (shouldn't normally happen
          // mid-session, but be defensive): reset the flag so the next
          // load will fetch waveforms again.
          waveformsHydratedRef.current = false;
        }
      }
      if (nextSong) {
        setIsProjectViewHydrating(false);
      }
    }

    void loadSong();

    return () => {
      active = false;
    };
  }, [hydrateWaveformCacheFromSong, playbackProjectRevision]);

  useEffect(() => {
    const nextProjectIdentity = {
      songDir: playbackSongDir,
      songId: song?.id ?? null,
    };
    const previousProjectIdentity = projectIdentityRef.current;

    const shouldResetProjectScopedState =
      previousProjectIdentity !== null &&
      (previousProjectIdentity.songDir !== nextProjectIdentity.songDir ||
        (previousProjectIdentity.songId !== null &&
          nextProjectIdentity.songId !== null &&
          previousProjectIdentity.songId !== nextProjectIdentity.songId));

    if (shouldResetProjectScopedState) {
      setWaveformCache(
        Object.fromEntries(
          (song?.waveforms ?? []).map((summary) => [
            summary.waveformKey,
            summary,
          ]),
        ),
      );
      setLibraryAssets([]);
      setLibraryClipPreview([]);
      setOptimisticClipOperations([]);
      clearActiveLibraryDragPayload();
    }

    projectIdentityRef.current = nextProjectIdentity;
  }, [playbackSongDir, song?.id, song?.waveforms]);

  useEffect(() => {
    let active = true;

    async function loadLibraryAssets() {
      if (!playbackSongDir) {
        libraryStateRequestIdRef.current += 1;
        setLibraryAssets([]);
        setLibraryFolders([]);
        setLibraryClipPreview([]);
        return;
      }

      const requestId = ++libraryStateRequestIdRef.current;
      setLibraryAssets([]);
      setLibraryFolders([]);
      setLibraryClipPreview([]);
      setIsLibraryLoading(true);
      try {
        const { assets, folders } = await loadLibraryState();
        if (!active || requestId !== libraryStateRequestIdRef.current) {
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
        .filter(
          (waveformKey, index, keys) => keys.indexOf(waveformKey) === index,
        )
        .filter((waveformKey) => {
          const summary = waveformCache[waveformKey];
          return !summary;
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
        ...Object.fromEntries(
          summaries.map((summary) => [summary.waveformKey, summary]),
        ),
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

    const clearAfterRevision = clipPreviewClearAfterRevisionRef.current;
    const clearedClipIds = Object.entries(clearAfterRevision)
      .filter(([, revision]) => revision <= song.projectRevision)
      .map(([clipId]) => clipId);
    if (clearedClipIds.length) {
      const nextPreviewSeconds = { ...clipPreviewSecondsRef.current };
      for (const clipId of clearedClipIds) {
        delete nextPreviewSeconds[clipId];
        delete clearAfterRevision[clipId];
      }
      clipPreviewSecondsRef.current = nextPreviewSeconds;
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

    // Don't overwrite the input while the user is editing it — otherwise a
    // playhead move into a different tempo region (or a project revision bump
    // from an unrelated mutation) would yank the value out from under them.
    if (!tempoDraftFocusedRef.current && !tempoDraftDirtyRef.current) {
      setTempoDraft(
        formatBpmDraft(
          getEffectiveBpmAt(song, displayPositionSecondsRef.current),
        ),
      );
    }
    setTimeSignatureDraft(getSongBaseTimeSignature(song));
  }, [song, song?.projectRevision, activeTempoRegionKey]);

  useEffect(() => {
    let active = true;

    async function loadMissingWaveforms() {
      if (!song) {
        return;
      }

      const missingWaveformKeys = song.clips
        .map((clip) => clip.waveformKey)
        .filter(
          (waveformKey, index, keys) => keys.indexOf(waveformKey) === index,
        )
        .filter((waveformKey) => {
          const summary = waveformCache[waveformKey];
          return !summary;
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
        ...Object.fromEntries(
          summaries.map((summary) => [summary.waveformKey, summary]),
        ),
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

    const nextTracksById = Object.fromEntries(
      song.tracks.map((track) => [track.id, track]),
    );

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
    const optimisticMixEntries = Object.entries(
      useTransportStore.getState().optimisticMix,
    );

    if (!song) {
      for (const [trackId] of optimisticMixEntries) {
        useTransportStore.getState().setOptimisticMix(trackId, null);
      }
      trackMixRequestIdsRef.current = {};
      trackMixLiveStatesRef.current = {};
      return;
    }

    const nextTracksById = Object.fromEntries(
      song.tracks.map((track) => [track.id, track]),
    );
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
      if (
        optimisticMix.muted !== undefined &&
        optimisticMix.muted !== track.muted
      ) {
        nextOptimisticMix.muted = optimisticMix.muted;
      }
      if (
        optimisticMix.solo !== undefined &&
        optimisticMix.solo !== track.solo
      ) {
        nextOptimisticMix.solo = optimisticMix.solo;
      }
      if (
        optimisticMix.volume !== undefined &&
        Math.abs(optimisticMix.volume - track.volume) >= 0.0001
      ) {
        nextOptimisticMix.volume = optimisticMix.volume;
      }
      if (
        optimisticMix.pan !== undefined &&
        Math.abs(optimisticMix.pan - track.pan) >= 0.0001
      ) {
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
      const nextPositionSeconds = resolveVisualPositionAcrossPendingJump(
        anchor.anchorPositionSeconds + elapsedSeconds,
      );

      syncLivePosition(nextPositionSeconds);
      animationFrameId = window.requestAnimationFrame(tick);
    };

    animationFrameId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [applyPlaybackSnapshot, playbackState]);

  useTransportPolling({
    playbackState,
    applyPlaybackSnapshot,
    pitchPreparing: pitchPrepareUiState.active,
  });

  useEffect(() => {
    const closeMenu = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }
      if (
        event.target instanceof HTMLElement &&
        event.target.closest(".lt-context-menu, .lt-color-popover")
      ) {
        return;
      }
      setContextMenu(null);
      setColorPickerPopover(null);
    };
    const closeMenuOnBlur = () => {
      setContextMenu(null);
      setColorPickerPopover(null);
    };

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
      if (
        event.target instanceof Node &&
        menuBarRef.current?.contains(event.target)
      ) {
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

  useTimelineKeyboardShortcuts({
    runAction,
    applyPlaybackSnapshot,
    snapshotRef,
    song,
    selectedClipId,
    selectedClipIds,
    selectedTrackIds,
    openTopMenu,
    setOpenTopMenu,
    setSelectedClipId,
    clearSelection,
    clearSelections,
    copySelectedClips,
    duplicateSelectedClips,
    pasteCopiedClips,
    handleSaveProjectClick,
    handleSaveProjectAsClick,
    scheduleMarkerJumpWithGlobalMode,
    scheduleRegionJumpWithOptions,
    setStatus,
    t,
    toggleViewMode,
  });

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      const clipDrag = clipDragRef.current;
      const effectSong = songRef.current;
      if (clipDrag && effectSong) {
        const effectPixelsPerSecond = livePixelsPerSecondRef.current;
        const exceededThreshold =
          Math.abs(event.clientX - clipDrag.startClientX) > DRAG_THRESHOLD_PX;
        if (!clipDrag.hasMoved && exceededThreshold) {
          restoreConfirmedTransportVisual();
        }
        const rawDeltaSeconds =
          (event.clientX - clipDrag.startClientX) / effectPixelsPerSecond;

        // Holding Ctrl/Cmd during the drag enables snap-to-anchors:
        // every member's start and end edge magnets onto the playhead,
        // section markers, region edges, and the edges of other clips
        // (within 12 px). Takes precedence over the grid — Ableton works
        // the same way (Cmd-drag magnets, plain drag uses the grid).
        const magnetActive = event.ctrlKey || event.metaKey;
        const rawDelta = rawDeltaSeconds;
        let groupDelta: number;
        let activeSnapAnchor: ClipSnapAnchor | null = null;

        if (magnetActive && clipDrag.snapAnchors.length > 0) {
          const snapRadiusSeconds =
            CLIP_SNAP_RADIUS_PX / effectPixelsPerSecond;
          const durationByClipId: Record<string, number> = {};
          for (const member of clipDrag.members) {
            const clip = findClip(effectSong, member.clipId);
            if (clip) {
              durationByClipId[member.clipId] = clip.durationSeconds;
            }
          }
          const snapResult = findSnappedGroupDelta(
            clipDrag.members,
            rawDelta,
            clipDrag.snapAnchors,
            snapRadiusSeconds,
            durationByClipId,
          );
          groupDelta = snapResult.groupDelta;
          activeSnapAnchor = snapResult.activeAnchor;
        } else {
          // Standard grid snap on the primary clip. Snapping off the
          // *primary* (not each member individually) preserves the
          // relative spacing between selected clips while still aligning
          // the group to the grid.
          const timingRegion = getSongTempoRegionAtPosition(
            effectSong,
            clipDrag.originSeconds + rawDelta,
          );
          const tempoRegions = buildSongTempoRegions(effectSong);
          const primaryTarget = snapEnabled
            ? snapToTimelineGrid(
                clipDrag.originSeconds + rawDelta,
                timingRegion?.bpm ?? effectSong.bpm,
                timingRegion?.timeSignature ?? effectSong.timeSignature,
                liveZoomLevelRef.current,
                effectPixelsPerSecond,
                tempoRegions,
              )
            : clipDrag.originSeconds + rawDelta;
          groupDelta = primaryTarget - clipDrag.originSeconds;
        }

        // Keep the drag as a group while allowing pre-roll before bar 1.
        // The bound only prevents a clip from disappearing completely before
        // t=0, which would make it hard to grab back without undo.
        const durationByClipId: Record<string, number> = {};
        for (const member of clipDrag.members) {
          const clip = findClip(effectSong, member.clipId);
          if (clip) {
            durationByClipId[member.clipId] = clip.durationSeconds;
          }
        }
        const lowerBound = clipDrag.members.reduce(
          (acc, member) =>
            Math.max(
              acc,
              0.05 - (durationByClipId[member.clipId] ?? 0) - member.originSeconds,
            ),
          Number.NEGATIVE_INFINITY,
        );
        const clampedDelta = Math.max(groupDelta, lowerBound);

        const nextPreviewSeed: Record<string, number> = {};
        const nextMembers = clipDrag.members.map((member) => {
          const nextSeconds = Math.min(
            member.originSeconds + clampedDelta,
            effectSong.durationSeconds,
          );
          nextPreviewSeed[member.clipId] = nextSeconds;
          return { ...member, previewSeconds: nextSeconds };
        });

        const primaryPreview =
          nextPreviewSeed[clipDrag.clipId] ??
          Math.min(
            clipDrag.originSeconds + clampedDelta,
            effectSong.durationSeconds,
          );

        const nextDrag: NonNullable<ClipDragState> = {
          ...clipDrag,
          hasMoved: clipDrag.hasMoved || exceededThreshold,
          previewSeconds: primaryPreview,
          members: nextMembers,
          activeSnapAnchor,
        };
        clipDragRef.current = nextDrag;
        clipPreviewSecondsRef.current = nextPreviewSeed;
        setClipDragSnapIndicatorSeconds(
          activeSnapAnchor ? activeSnapAnchor.seconds : null,
        );
      }

      const trackDrag = trackDragRef.current;
      if (trackDrag && songRef.current) {
        const exceededThreshold =
          Math.abs(event.clientX - trackDrag.startClientX) >
            DRAG_THRESHOLD_PX ||
          Math.abs(event.clientY - trackDrag.startClientY) > DRAG_THRESHOLD_PX;
        const isDraggingNow = trackDrag.isDragging || exceededThreshold;
        const nextDrag = {
          ...trackDrag,
          currentClientY: event.clientY,
          currentClientX: event.clientX,
          isDragging: isDraggingNow,
        };
        trackDragRef.current = nextDrag;

        if (!isDraggingNow) {
          return;
        }

        const dropState =
          trackDrag.originSurface === "compact"
            ? resolveCompactTrackDropState(
                songRef.current,
                trackDrag.trackId,
                event.clientX,
                event.clientY,
              )
            : resolveTrackDropState(
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
      setClipDragSnapIndicatorSeconds(null);
      if (activeClipDrag) {
        const movedEnough =
          activeClipDrag.hasMoved ||
          Math.abs(event.clientX - activeClipDrag.startClientX) >
            DRAG_THRESHOLD_PX;
        if (movedEnough && activeClipDrag.members.length > 1) {
          // Multi-clip drag: commit all positions in one batch so the engine
          // rebuilds the timeline window once, the history records a single
          // entry, and only one project_revision bumps.
          const batchMoves: ClipMoveRequest[] = activeClipDrag.members.map(
            (member) => ({
              clipId: member.clipId,
              timelineStartSeconds: member.previewSeconds,
            }),
          );
          for (const move of batchMoves) {
            clipMoveCommitPendingRef.current.add(move.clipId);
          }
          queueClipMoveBatchLiveUpdate(batchMoves);
          const primaryClipId = activeClipDrag.clipId;
          const movedCount = batchMoves.length;
          void runAction(async () => {
            try {
              await waitForClipMoveBatchLiveIdle();
              const nextSnapshot = await moveClipsBatch(batchMoves);
              for (const move of batchMoves) {
                clipPreviewClearAfterRevisionRef.current[move.clipId] =
                  nextSnapshot.projectRevision;
              }
              applyPlaybackSnapshot(nextSnapshot);
              const primaryClip = findClip(songRef.current, primaryClipId);
              setStatus(
                t("transport.status.clipsMoved", {
                  count: movedCount,
                  name: primaryClip
                    ? clipDisplayName(primaryClip)
                    : primaryClipId,
                  defaultValue: "Moved {{count}} clips ({{name}}).",
                }),
              );
            } finally {
              for (const move of batchMoves) {
                clipMoveCommitPendingRef.current.delete(move.clipId);
              }
              const anyPending = batchMoves.some(
                (move) =>
                  !clipPreviewClearAfterRevisionRef.current[move.clipId],
              );
              if (!anyPending) {
                clipPreviewSecondsRef.current = {};
              }
            }
          });
        } else if (movedEnough) {
          clipMoveCommitPendingRef.current.add(activeClipDrag.clipId);
          queueClipMoveLiveUpdate(
            activeClipDrag.clipId,
            activeClipDrag.previewSeconds,
          );
          void runAction(async () => {
            try {
              await waitForClipMoveLiveIdle(activeClipDrag.clipId);
              const nextSnapshot = await moveClip(
                activeClipDrag.clipId,
                activeClipDrag.previewSeconds,
              );
              clipPreviewClearAfterRevisionRef.current[activeClipDrag.clipId] =
                nextSnapshot.projectRevision;
              applyPlaybackSnapshot(nextSnapshot);
              const clip = findClip(songRef.current, activeClipDrag.clipId);
              setStatus(
                t("transport.status.clipMoved", {
                  name: clip
                    ? clipDisplayName(clip)
                    : activeClipDrag.clipId,
                }),
              );
            } finally {
              clipMoveCommitPendingRef.current.delete(activeClipDrag.clipId);
              if (
                !clipPreviewClearAfterRevisionRef.current[activeClipDrag.clipId]
              ) {
                clipPreviewSecondsRef.current = {};
              }
            }
          });
        } else {
          clipPreviewSecondsRef.current = {};
          // Plain click on a clip that was part of a multi-selection at
          // mouseDown time: collapse the selection to just this clip now
          // that we know the user did NOT drag the group.
          const collapseTo = clipSelectionPendingCollapseRef.current;
          if (collapseTo && collapseTo === activeClipDrag.clipId) {
            const clip = findClip(songRef.current, collapseTo);
            selectClip(collapseTo, clip?.trackId ?? null);
            clipSelectionAnchorRef.current = collapseTo;
          }
          void runAction(async () => {
            await performSeek(activeClipDrag.clickSeekSeconds);
          });
        }
      } else {
        clipPreviewSecondsRef.current = {};
      }
      clipSelectionPendingCollapseRef.current = null;

      const activeTrackDrag = trackDragRef.current;
      if (activeTrackDrag) {
        const currentSong = songRef.current;
        const movedEnough =
          Math.abs(event.clientX - activeTrackDrag.startClientX) >
            DRAG_THRESHOLD_PX ||
          Math.abs(event.clientY - activeTrackDrag.startClientY) >
            DRAG_THRESHOLD_PX;
        const shouldTreatAsDrag =
          Boolean(currentSong) && (activeTrackDrag.isDragging || movedEnough);
        const dropState =
          shouldTreatAsDrag && currentSong
            ? activeTrackDrag.originSurface === "compact"
              ? resolveCompactTrackDropState(
                  currentSong,
                  activeTrackDrag.trackId,
                  event.clientX,
                  event.clientY,
                )
              : resolveTrackDropState(
                  currentSong,
                  activeTrackDrag.trackId,
                  event.clientX,
                  event.clientY,
                )
            : null;

        trackDragRef.current = null;
        suppressTrackClickRef.current = shouldTreatAsDrag;

        if (dropState) {
          void handleTrackDrop(activeTrackDrag.trackId, dropState);
        } else {
          clearTrackDragVisuals();
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
    queueClipMoveBatchLiveUpdate,
    queueClipMoveLiveUpdate,
    waitForClipMoveBatchLiveIdle,
    runAction,
    selectClip,
    selectedClipIds,
    snapEnabled,
    toggleClipSelection,
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

    const nextRegionKey = timingRegion?.id ?? "";
    if (nextRegionKey !== activeTempoRegionKeyRef.current) {
      activeTempoRegionKeyRef.current = nextRegionKey;
      setActiveTempoRegionKey(nextRegionKey);
    }

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
    updateCameraX(nextCameraX, {
      commitToStore: true,
    });
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
    forceReanchorOnNextSnapshotRef.current = true;

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
    durationSecondsOrOptions?:
      | number
      | { durationSeconds?: number; allowSnap?: boolean },
    legacyOptions?: { allowSnap?: boolean },
  ) {
    // Backwards-compatible signature:
    //   normalizeTimelineSeekSeconds(pos)
    //   normalizeTimelineSeekSeconds(pos, durationSeconds)
    //   normalizeTimelineSeekSeconds(pos, { durationSeconds?, allowSnap? })
    //   normalizeTimelineSeekSeconds(pos, durationSeconds, { allowSnap })
    let durationSeconds: number;
    let allowSnap = true;
    if (typeof durationSecondsOrOptions === "number") {
      durationSeconds = durationSecondsOrOptions;
      if (legacyOptions?.allowSnap === false) allowSnap = false;
    } else if (durationSecondsOrOptions) {
      durationSeconds =
        durationSecondsOrOptions.durationSeconds ??
        (timelineDurationSecondsRef.current || song?.durationSeconds || 0);
      if (durationSecondsOrOptions.allowSnap === false) allowSnap = false;
    } else {
      durationSeconds =
        timelineDurationSecondsRef.current || song?.durationSeconds || 0;
    }

    const clampedPosition = clamp(
      positionSeconds,
      0,
      Math.max(0, durationSeconds),
    );
    const timingRegion = getSongTempoRegionAtPosition(song, clampedPosition);

    return snapEnabled && allowSnap
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

  function snappedRulerSeconds(
    event: MouseEvent | ReactMouseEvent,
    durationSeconds: number,
  ) {
    return normalizeTimelineSeekSeconds(
      rulerClientXToSeconds(
        event.clientX,
        rulerTrackRef.current as HTMLElement,
        getCameraX(),
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

  const laneViewportWidth = Math.max(320, timelineViewportWidth);
  const timelineFitViewportWidth = Math.max(
    320,
    laneViewportWidth -
      Math.min(TIMELINE_FIT_RIGHT_GUTTER_PX, laneViewportWidth * 0.16),
  );
  const timelineContentEndSeconds = useMemo(() => {
    if (!song && pendingAudioImports.length === 0) {
      return 0;
    }

    let furthestContentSeconds = song?.durationSeconds ?? 0;
    for (const clip of song?.clips ?? []) {
      furthestContentSeconds = Math.max(
        furthestContentSeconds,
        clip.timelineStartSeconds + clip.durationSeconds,
      );
    }
    for (const marker of song?.sectionMarkers ?? []) {
      furthestContentSeconds = Math.max(
        furthestContentSeconds,
        marker.startSeconds,
      );
    }
    for (const pendingImport of pendingAudioImports) {
      furthestContentSeconds = Math.max(
        furthestContentSeconds,
        pendingImport.dropSeconds + 8,
      );
    }

    return furthestContentSeconds;
  }, [pendingAudioImports, song]);
  const workspaceDurationSeconds = getTimelineWorkspaceEndSeconds(
    song?.durationSeconds ?? 0,
    timelineContentEndSeconds,
  );
  const fitAllZoomLevel = timelineContentEndSeconds
    ? clamp(
        timelineFitViewportWidth /
          (Math.max(timelineContentEndSeconds, 1) * BASE_PIXELS_PER_SECOND),
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
    ? (snapshotRef.current?.pendingMarkerJump ?? null)
    : null;
  const activeVamp = activeVampSignature
    ? (snapshotRef.current?.activeVamp ?? null)
    : null;
  const renderedClipsByTrack = useMemo<Record<string, TimelineClipSummary[]>>(
    () =>
      mergePendingClipsByTrack(
        mergeOptimisticClipsByTrack(clipsByTrack, optimisticClipOperations),
        pendingAudioImports,
      ),
    [clipsByTrack, optimisticClipOperations, pendingAudioImports],
  );
  const readoutPositionSeconds = displayPositionSecondsRef.current;
  const readoutTempoRegion = getSongTempoRegionAtPosition(
    song,
    readoutPositionSeconds,
  );
  const songBaseBpm = getSongBaseBpm(song);
  const songBaseTimeSignature = getSongBaseTimeSignature(song);
  const displayedBpm = readoutTempoRegion?.bpm ?? songBaseBpm;
  const displayedTimeSignature =
    readoutTempoRegion?.timeSignature ?? songBaseTimeSignature;
  const musicalPositionLabel = song
    ? formatMusicalPosition(readoutPositionSeconds, song)
    : "1.1.00";
  // Render the "Tempo @ HH:MM:SS.cc" string with the time portion in a
  // monospace span so digits don't jitter as the clock advances. The i18n
  // string still uses {{time}} as a placeholder — we replace it manually.
  const tempoSourceLabel = readoutTempoRegion ? (() => {
    const sentinel = "TIME";
    const timeText = formatClock(readoutTempoRegion.startSeconds);
    const template = t("transport.tempoSource.at", { time: sentinel });
    const [before = "", after = ""] = template.split(sentinel);
    return (
      <>
        {before}
        <span className="lt-mono">{timeText}</span>
        {after}
      </>
    );
  })() : (
    t("transport.tempoSource.base")
  );
  // Tap-tempo handler. song + playhead position read through getters/refs so
  // the factory stays stable across renders. See ./tempo/tapTempoHandler.
  const handleTapTempo = useMemo(
    () =>
      createTapTempoHandler({
        getSong: () => songRef.current,
        getCursorSeconds: () => displayPositionSecondsRef.current,
        tapTempoTimesRef,
        tempoDraftDirtyRef,
        setTempoDraft,
        setStatus,
        runAction,
        refreshSongView,
        applyPlaybackSnapshot,
        optimisticallyAppliedRevisionsRef,
        getEffectiveTempoMarkerAt,
        upsertSongTempoMarker,
        updateSongTempo,
        t,
        now: () => performance.now(),
      }),
    [setStatus, runAction, refreshSongView, applyPlaybackSnapshot, t],
  );

  const canPersistProject = Boolean(song);
  const isProjectEmpty = !song;
  const isProjectPending = Boolean(playbackProjectRevision > 0 && !song);
  const shouldShowEmptyState = !isShellBusy && !isProjectPending && !song;
  const timelineRowWidth = HEADER_WIDTH + laneViewportWidth;
  const visibleTracks = useMemo<TimelineTrackSummary[]>(() => {
    const realTracks = song ? buildVisibleTracks(song, collapsedFolders) : [];
    return [...realTracks, ...pendingAudioImports.map(toPendingTrack)];
  }, [collapsedFolders, pendingAudioImports, song]);
  const visibleLibraryAssets = useMemo<PendingLibraryAssetSummary[]>(
    () => [...libraryAssets, ...pendingAudioImports.map(toPendingLibraryAsset)],
    [libraryAssets, pendingAudioImports],
  );
  const previewTrackDensityClass = densityFromHeight(trackHeight);
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
            : t("transport.preview.clipsOnNewTrack", {
                count: previews.length,
              }),
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

  function handleSelectRegionFromMidi(direction: -1 | 1) {
    const effectSong = songRef.current;
    if (!effectSong || effectSong.regions.length === 0) {
      return;
    }

    const orderedRegions = [...effectSong.regions].sort(
      (left, right) => left.startSeconds - right.startSeconds,
    );
    const currentIndex = orderedRegions.findIndex(
      (region) => region.id === selectedRegionId,
    );
    const nextIndex =
      currentIndex === -1
        ? 0
        : Math.max(
            0,
            Math.min(orderedRegions.length - 1, currentIndex + direction),
          );
    const nextRegion = orderedRegions[nextIndex] ?? null;

    if (!nextRegion) {
      return;
    }

    setSelectedRegionId(nextRegion.id);
    setStatus(t("transport.status.regionSelected", { name: nextRegion.name }));
  }

  function handleRegionTransposeFromMidi(
    commandKey:
      | "action:region_transpose_up"
      | "action:region_transpose_down"
      | "action:region_transpose_reset",
  ) {
    const effectSong = songRef.current;
    if (!effectSong || !selectedRegionId) {
      return;
    }

    const currentRegion =
      effectSong.regions.find((region) => region.id === selectedRegionId) ??
      null;
    if (!currentRegion) {
      return;
    }

    const nextTransposeSemitones =
      commandKey === "action:region_transpose_reset"
        ? 0
        : currentRegion.transposeSemitones +
          (commandKey === "action:region_transpose_up" ? 1 : -1);

    handleSelectedRegionTransposeChange(nextTransposeSemitones);
  }

  async function handleMarkerPrimaryAction(section: SectionMarkerSummary) {
    selectSection(section.id);
    setSelectedRegionId(null);
    setContextMenu(null);

    if (snapshotRef.current?.pendingMarkerJump?.targetMarkerId === section.id) {
      const nextSnapshot = await cancelMarkerJump();
      applyPlaybackSnapshot(nextSnapshot);
      setStatus(
        t("transport.status.jumpCancelledSection", { name: section.name }),
      );
      return;
    }

    await scheduleMarkerJumpWithGlobalMode(section.id, section.name);
  }

  useEffect(() => {
    setZoomLevel((current) =>
      current < effectiveZoomMin ? effectiveZoomMin : current,
    );
  }, [effectiveZoomMin]);

  useEffect(() => {
    if (!song) {
      viewportFitStateRef.current = {
        projectIdentity: null,
        hadClips: false,
      };
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
  }, [
    fitAllZoomLevel,
    laneViewportWidth,
    playbackSongDir,
    setZoomLevel,
    song,
    timelineContentEndSeconds,
  ]);

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
  }, [
    laneViewportWidth,
    pixelsPerSecond,
    song?.durationSeconds,
    timelineContentEndSeconds,
    viewMode,
  ]);

  useEffect(() => {
    syncLivePosition(
      playheadDragRef.current?.currentSeconds ??
        displayPositionSecondsRef.current,
    );
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
        label: timelineRange
          ? t("transport.menu.createSongRegionFromSelection")
          : t("transport.menu.createMarker"),
        onSelect: async () => {
          await runAction(async () => {
            const nextSnapshot = timelineRange
              ? await createSongRegion(
                  timelineRange.startSeconds,
                  timelineRange.endSeconds,
                )
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
                : t("transport.status.markerCreatedAt", {
                    time: formatClock(positionSeconds),
                  }),
            );
          });
        },
      },
      {
        label: t("transport.menu.changeTimelineBpm"),
        disabled: !song,
        onSelect: async () => {
          const nextBpm = Number(
            window.prompt(
              t("transport.prompt.timelineBpm"),
              songBaseBpm.toFixed(2),
            ),
          );
          if (!Number.isFinite(nextBpm) || nextBpm <= 0) {
            return;
          }

          await runAction(async () => {
            const nextSnapshot =
              positionSeconds <= 0.0001
                ? await updateSongTempo(nextBpm)
                : await upsertSongTempoMarker(positionSeconds, nextBpm);
            optimisticallyAppliedRevisionsRef.current.add(
              nextSnapshot.projectRevision,
            );
            await refreshSongView({ includeWaveforms: false, sync: true });
            applyPlaybackSnapshot(nextSnapshot);
            tempoDraftDirtyRef.current = false;
            setTempoDraft(formatBpmDraft(nextBpm));
            setStatus(
              positionSeconds <= 0.0001
                ? t("transport.status.baseTimelineBpmUpdated", {
                    bpm: nextBpm.toFixed(2),
                  })
                : t("transport.status.tempoMarkerCreated", {
                    time: formatClock(positionSeconds),
                    bpm: nextBpm.toFixed(2),
                  }),
            );
          });
        },
      },
      {
        label: "Crear marca de metrica",
        disabled: !song,
        onSelect: async () => {
          const nextSignature = window
            .prompt("Compas", displayedTimeSignature)
            ?.trim();
          if (!nextSignature) {
            return;
          }

          await runAction(async () => {
            const nextSnapshot =
              positionSeconds <= 0.0001
                ? await updateSongTimeSignature(nextSignature)
                : await upsertSongTimeSignatureMarker(
                    positionSeconds,
                    nextSignature,
                  );
            applyPlaybackSnapshot(nextSnapshot);
            setTimeSignatureDraft(nextSignature);
            setStatus(
              `Compas ${nextSignature} en ${formatClock(positionSeconds)}`,
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
          const nextName = window
            .prompt(t("transport.prompt.songRename"), region.name)
            ?.trim();
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
            await syncSongLibraryFolderAfterRename(region.name, nextName);
            setStatus(t("transport.status.songRenamed", { name: nextName }));
          });
        },
      },
      {
        label: t("transport.menu.changeRegionWarpSourceBpm"),
        onSelect: async () => {
          const currentSourceBpm =
            region.warpSourceBpm ?? getEffectiveBpmAt(song, region.startSeconds);
          const input = window
            .prompt(
              t("transport.prompt.regionWarpSourceBpm"),
              currentSourceBpm.toFixed(2),
            )
            ?.trim();
          if (!input) {
            return;
          }
          const nextSourceBpm = Number(input.replace(",", "."));
          if (!Number.isFinite(nextSourceBpm) || nextSourceBpm <= 0) {
            return;
          }
          await runAction(async () => {
            const nextSnapshot = await updateSongRegionWarp(
              region.id,
              region.warpEnabled,
              nextSourceBpm,
            );
            await refreshSongView({ includeWaveforms: false, sync: true });
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(
              t("transport.status.regionWarpSourceBpmUpdated", {
                bpm: nextSourceBpm.toFixed(2),
                name: region.name,
              }),
            );
          });
        },
      },
      {
        label: "Exportar Cancion",
        onSelect: () => {
          setExportSongTarget({ regionId: region.id, regionName: region.name });
        },
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
          const nextBpm = Number(
            window.prompt(
              t("transport.prompt.tempoMarkerBpm"),
              marker.bpm.toFixed(2),
            ),
          );
          if (!Number.isFinite(nextBpm) || nextBpm <= 0) {
            return;
          }

          await runAction(async () => {
            const nextSnapshot = await upsertSongTempoMarker(
              marker.sourceStartSeconds ?? marker.startSeconds,
              nextBpm,
            );
            optimisticallyAppliedRevisionsRef.current.add(
              nextSnapshot.projectRevision,
            );
            await refreshSongView({ includeWaveforms: false, sync: true });
            applyPlaybackSnapshot(nextSnapshot);
            tempoDraftDirtyRef.current = false;
            setTempoDraft(formatBpmDraft(nextBpm));
            setStatus(
              t("transport.status.tempoMarkerUpdated", {
                bpm: nextBpm.toFixed(2),
              }),
            );
          });
        },
      },
      {
        label: t("transport.menu.deleteMarker"),
        onSelect: async () => {
          await runAction(async () => {
            const nextSnapshot = await deleteSongTempoMarker(marker.id);
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(
              t("transport.status.tempoMarkerDeleted", {
                time: formatClock(marker.startSeconds),
              }),
            );
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

  function applyZoom(
    nextZoomLevel: number,
    anchorViewportX = laneViewportWidth / 2,
  ) {
    previewZoom(nextZoomLevel, anchorViewportX, {
      scheduleCommit: true,
    });
  }

  function commitZoomViewToStore(nextView: {
    cameraX: number;
    zoomLevel: number;
  }) {
    if (zoomDebounceTimerRef.current !== null) {
      window.clearTimeout(zoomDebounceTimerRef.current);
      zoomDebounceTimerRef.current = null;
    }

    liveZoomLevelRef.current = nextView.zoomLevel;
    livePixelsPerSecondRef.current =
      nextView.zoomLevel * BASE_PIXELS_PER_SECOND;
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

  function handleTimelineViewportDoubleClick(
    event: ReactMouseEvent<HTMLDivElement> | MouseEvent,
  ) {
    const viewport =
      event.currentTarget instanceof HTMLDivElement
        ? event.currentTarget
        : timelineScrollViewportRef.current;
    if (!viewport) {
      return;
    }

    const bounds = viewport.getBoundingClientRect();
    const measuredScrollbarWidth = viewport.offsetWidth - viewport.clientWidth;
    const scrollbarWidth = Math.max(measuredScrollbarWidth, 14);

    if (event.clientX >= bounds.right - scrollbarWidth - 2) {
      event.preventDefault();
      applyTrackHeight(TRACK_HEIGHT_MIN);
    }
  }

  useEffect(() => {
    const viewport = timelineScrollViewportRef.current;
    if (!viewport) {
      return;
    }

    const handleDoubleClick = (event: MouseEvent) => {
      handleTimelineViewportDoubleClick(event);
    };
    viewport.addEventListener("dblclick", handleDoubleClick);
    return () => {
      viewport.removeEventListener("dblclick", handleDoubleClick);
    };
  });

  function handleTrackHeadersWheel(event: WheelEvent) {
    if (event.defaultPrevented) {
      return;
    }

    if (event.ctrlKey || event.metaKey) {
      if (event.cancelable) {
        event.preventDefault();
      }
      applyTrackHeight(
        trackHeight +
          (event.deltaY < 0 ? TRACK_HEIGHT_STEP : -TRACK_HEIGHT_STEP),
      );
      return;
    }

    const shouldScrollHorizontally =
      event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
    if (!shouldScrollHorizontally) {
      return;
    }

    if (event.cancelable) {
      event.preventDefault();
    }
    updateCameraX(
      cameraXRef.current + event.deltaX + (event.shiftKey ? event.deltaY : 0),
      {
        commitToStore: false,
      },
    );
  }

  function openMenu(
    event: ReactMouseEvent,
    title: string,
    actions: ContextMenuAction[],
  ) {
    event.preventDefault();
    event.stopPropagation();
    contextMenuPositionRef.current = {
      x: event.clientX,
      y: event.clientY,
    };
    setColorPickerPopover(null);
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      title,
      actions,
    });
  }

  function openCustomColorPopover(
    title: string,
    initialColor: string | null | undefined,
    onColor: (color: string) => Promise<void>,
  ) {
    const position = contextMenuPositionRef.current;
    setColorPickerPopover({
      x: position.x + 12,
      y: position.y + 12,
      title,
      initialColor: normalizeTimelineColorInput(initialColor) ?? "#3CDDC7",
      onApply: onColor,
    });
  }

  function colorPickerActions(args: {
    title: string;
    currentColor?: string | null;
    onColor: (color: string | null) => Promise<void>;
  }): ContextMenuAction[] {
    return [
      ...TIMELINE_COLOR_PRESETS.map((preset) => ({
        label: `${preset.label}${args.currentColor === preset.value ? " (actual)" : ""}`,
        swatch: preset.value,
        onSelect: () => args.onColor(preset.value),
      })),
      {
        label: "Personalizado...",
        swatch: args.currentColor ?? "#3CDDC7",
        onSelect: () =>
          openCustomColorPopover(args.title, args.currentColor, (color) =>
            args.onColor(color),
          ),
      },
      {
        label: "Quitar color",
        disabled: !args.currentColor,
        onSelect: () => args.onColor(null),
      },
    ];
  }

  function openColorMenu(
    title: string,
    currentColor: string | null | undefined,
    onColor: (color: string | null) => Promise<void>,
  ) {
    const position = contextMenuPositionRef.current;
    const nextPosition = {
      x: position.x + 12,
      y: position.y + 12,
    };
    contextMenuPositionRef.current = nextPosition;
    setContextMenu({
      x: nextPosition.x,
      y: nextPosition.y,
      title,
      actions: colorPickerActions({ title, currentColor, onColor }),
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
        onSelect: () =>
          handleCreateTrack("audio", track, track.parentTrackId ?? null),
      },
      {
        label: t("transport.menu.insertFolderTrack"),
        onSelect: () =>
          handleCreateTrack("folder", track, track.parentTrackId ?? null),
      },
      {
        label: t("common.rename"),
        onSelect: async () => {
          const nextName = window
            .prompt(t("transport.prompt.trackRename"), track.name)
            ?.trim();
          if (!nextName) {
            return;
          }
          await runAction(async () => {
            const nextSnapshot = await updateTrack({
              trackId: track.id,
              name: nextName,
            });
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(t("transport.status.trackRenamed", { name: nextName }));
          });
        },
      },
      {
        label: "Seleccionar color...",
        swatch: track.color ?? undefined,
        onSelect: () =>
          openColorMenu(`Color: ${track.name}`, track.color, (color) =>
            handleSetTrackColor(track, color),
          ),
      },
      {
        label: t("common.delete"),
        onSelect: async () => {
          const clipCount = currentSong.clips.filter(
            (clip) => clip.trackId === track.id,
          ).length;
          if (
            track.kind === "audio" &&
            clipCount > 0 &&
            !window.confirm(t("transport.confirm.deleteTrackWithClips"))
          ) {
            return;
          }

          await runAction(async () => {
            const nextSnapshot = await deleteTrack(track.id);
            optimisticallyAppliedRevisionsRef.current.add(nextSnapshot.projectRevision);
            applyPlaybackSnapshot(nextSnapshot);
            clearLibraryDragPreview();
            // Deleting a track removes its clips but the surviving clips
            // still reference the same waveformKeys, and orphaned cache
            // entries are harmless until the next full reload. Skip the
            // ~27 MB waveform payload to keep the UI responsive.
            await refreshSongView({ includeWaveforms: false });
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
            setStatus(
              t("transport.status.trackMovedIntoFolder", {
                name: previousFolder.name,
              }),
            );
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
            setStatus(
              t("transport.status.trackRemovedFromFolder", {
                name: track.name,
              }),
            );
          });
        },
      },
    ];
  }

  function multiTrackContextMenu(tracks: TrackSummary[]) {
    const currentColor = resolveSharedTimelineColor(tracks);
    return [
      {
        label: "Seleccionar color...",
        swatch: currentColor ?? undefined,
        onSelect: () =>
          openColorMenu(
            `Color: ${tracks.length} tracks`,
            currentColor,
            (color) => handleSetTrackColors(tracks, color),
          ),
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

  const handleTrackHeaderSelect = useCallback(
    (
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
        trackSelectionAnchorRef.current = trackId;
      } else if (event.shiftKey) {
        const visibleTrackIds = visibleTracks.map((track) => track.id);
        const anchor = trackSelectionAnchorRef.current;
        const anchorIdx = anchor ? visibleTrackIds.indexOf(anchor) : -1;
        const currentIdx = visibleTrackIds.indexOf(trackId);

        if (anchorIdx !== -1 && currentIdx !== -1) {
          const start = Math.min(anchorIdx, currentIdx);
          const end = Math.max(anchorIdx, currentIdx);
          nextSelection = visibleTrackIds.slice(start, end + 1);
          // Anchor stays put across range extensions.
        } else {
          // No usable anchor — fall back to single-select and seed anchor.
          nextSelection = [trackId];
          trackSelectionAnchorRef.current = trackId;
        }
      } else {
        trackSelectionAnchorRef.current = trackId;
      }

      selectTrack(nextSelection);
      setStatus(
        nextSelection.length > 1
          ? t("transport.status.tracksSelected", {
              count: nextSelection.length,
            })
          : t("transport.status.trackSelected", { name: trackName }),
      );
    },
    [selectTrack, t, visibleTracks],
  );

  function handleTrackHeaderContextMenu(
    event: ReactMouseEvent<HTMLDivElement>,
    trackId: string,
  ) {
    const track = findTrack(songRef.current, trackId);
    if (!track) {
      return;
    }

    const currentSelection = useTimelineUIStore.getState().selectedTrackIds;
    const selectedTracks = currentSelection
      .map((selectedTrackId) => findTrack(songRef.current, selectedTrackId))
      .filter((candidate): candidate is TrackSummary => candidate !== null);

    if (
      currentSelection.includes(track.id) &&
      selectedTracks.length > 1
    ) {
      openMenu(
        event,
        `${selectedTracks.length} tracks`,
        multiTrackContextMenu(selectedTracks),
      );
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
      // The track header drag can be initiated from either the DAW
      // header (vertical layout) or the compact mixer strip
      // (horizontal layout). We branch on which DOM ancestor we find
      // so the visual pipeline knows whether to translate on Y or X
      // and which selector to highlight as the drop target.
      const headerElement = event.currentTarget.closest(
        ".lt-track-header",
      ) as HTMLDivElement | null;
      const compactStrip = event.currentTarget.closest(
        ".lt-compact-mixer-strip",
      ) as HTMLDivElement | null;
      const originSurface: "daw" | "compact" = compactStrip
        ? "compact"
        : "daw";
      trackDragRef.current = {
        trackId,
        pointerId: 1,
        startClientX: event.clientX,
        startClientY: event.clientY,
        currentClientY: event.clientY,
        currentClientX: event.clientX,
        isDragging: false,
        rowElement:
          originSurface === "compact"
            ? compactStrip
            : (event.currentTarget.closest(
                ".lt-track-header-row",
              ) as HTMLDivElement | null),
        headerElement,
        originSurface,
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

  const handleTrackHeaderMuteToggle = useCallback(
    (trackId: string) => {
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
    },
    [
      patchTrackOptimisticMix,
      persistTrackMix,
      queueTrackMixLiveUpdate,
      resolveTrackMix,
      runAction,
    ],
  );

  const handleTrackHeaderSoloToggle = useCallback(
    (trackId: string) => {
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
    },
    [
      patchTrackOptimisticMix,
      persistTrackMix,
      queueTrackMixLiveUpdate,
      resolveTrackMix,
      runAction,
    ],
  );

  const handleTrackHeaderVolumeChange = useCallback(
    (trackId: string, nextVolume: number) => {
      patchTrackOptimisticMix(trackId, {
        volume: clamp(nextVolume, 0, 1),
      });
      queueTrackMixLiveUpdate(trackId, ["volume"]);
    },
    [patchTrackOptimisticMix, queueTrackMixLiveUpdate],
  );

  const handleTrackHeaderVolumeCommit = useCallback(
    (trackId: string) => {
      void runAction(async () => {
        await persistTrackMix(trackId, ["volume"]);
      });
    },
    [persistTrackMix, runAction],
  );

  const handleTrackHeaderPanChange = useCallback(
    (trackId: string, nextPan: number) => {
      patchTrackOptimisticMix(trackId, {
        pan: clamp(nextPan, -1, 1),
      });
      queueTrackMixLiveUpdate(trackId, ["pan"]);
    },
    [patchTrackOptimisticMix, queueTrackMixLiveUpdate],
  );

  const handleTrackHeaderPanCommit = useCallback(
    (trackId: string) => {
      void runAction(async () => {
        await persistTrackMix(trackId, ["pan"]);
      });
    },
    [persistTrackMix, runAction],
  );

  const handleTrackHeaderTransposeToggle = useCallback(
    (trackId: string) => {
      const track = findTrack(songRef.current, trackId);
      if (!track) {
        return;
      }

      const nextTransposeEnabled = !track.transposeEnabled;
      void runAction(async () => {
        setPitchPrepareUiState({
          active: true,
          message: "Aplicando cambio de tono...",
          startedAt: Date.now(),
        });
        const nextSnapshot = await updateTrackTransposeEnabled({
          trackId,
          transposeEnabled: nextTransposeEnabled,
        });
        // Optimistic local mutation: see handleSelectedRegionTransposeChange.
        optimisticallyAppliedRevisionsRef.current.add(
          nextSnapshot.projectRevision,
        );
        setSong((previous) => {
          if (!previous) return previous;
          return {
            ...previous,
            projectRevision: nextSnapshot.projectRevision,
            tracks: previous.tracks.map((t) =>
              t.id === trackId
                ? { ...t, transposeEnabled: nextTransposeEnabled }
                : t,
            ),
          };
        });
        applyPlaybackSnapshot(nextSnapshot);
        setStatus(
          t("transport.status.trackTransposeUpdated", { name: track.name }),
        );
      });
    },
    [applyPlaybackSnapshot, runAction, setStatus, t],
  );

  function clipContextMenu(clip: ClipSummary) {
    const currentCursorSeconds = displayPositionSecondsRef.current;
    const clipName = clipDisplayName(clip);
    // If the right-clicked clip is part of a multi-selection, the split
    // is offered when *any* selected clip contains the cursor, and we
    // batch all qualifying ones into a single command. Otherwise we
    // fall back to the single-clip behaviour.
    const isMultiSelection =
      selectedClipIds.includes(clip.id) && selectedClipSummaries.length > 1;
    const splitCandidates = isMultiSelection ? selectedClipSummaries : [clip];
    const splittableClips = splitCandidates.filter(
      (candidate) =>
        currentCursorSeconds > candidate.timelineStartSeconds &&
        currentCursorSeconds <
          candidate.timelineStartSeconds + candidate.durationSeconds,
    );
    const canSplit = splittableClips.length > 0;

    return [
      {
        label: t("transport.menu.splitClipAtCursor"),
        disabled: !canSplit,
        onSelect: async () => {
          await runAction(async () => {
            const ids = splittableClips.map((entry) => entry.id);
            const nextSnapshot =
              ids.length > 1
                ? await splitClips(ids, currentCursorSeconds)
                : await splitClip(ids[0], currentCursorSeconds);
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(
              ids.length > 1
                ? t("transport.status.clipsSplitAt", {
                    count: ids.length,
                    time: formatClock(currentCursorSeconds),
                    defaultValue: "Split {{count}} clips at {{time}}.",
                  })
                : t("transport.status.clipSplitAt", {
                    time: formatClock(currentCursorSeconds),
                  }),
            );
          });
        },
      },
      {
        label: t("transport.menu.duplicateClip"),
        onSelect: async () => {
          await runAction(async () => {
            const sourceClips =
              selectedClipIds.includes(clip.id) && selectedClipSummaries.length
                ? selectedClipSummaries
                : [clip];
            const sourceEndSeconds = Math.max(
              ...sourceClips.map(
                (sourceClip) =>
                  sourceClip.timelineStartSeconds + sourceClip.durationSeconds,
              ),
            );
            await duplicateClipGroup(sourceClips, sourceEndSeconds);
            setStatus(
              t("transport.status.clipDuplicated", { name: clipName }),
            );
          });
        },
      },
      {
        label: "Seleccionar color...",
        swatch: clip.color ?? undefined,
        onSelect: () =>
          openColorMenu(`Color: ${clipName}`, clip.color, (color) =>
            handleSetClipColor(clip, color),
          ),
      },
      {
        label: t("common.delete"),
        onSelect: async () => {
          await runAction(async () => {
            const nextSnapshot = await deleteClip(clip.id);
            applyPlaybackSnapshot(nextSnapshot);
            setSelectedClipId(null);
            setStatus(
              t("transport.status.clipDeleted", { name: clipName }),
            );
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
      livePixelsPerSecondRef.current,
    );

    if (hitClip) {
      event.preventDefault();
      const clickSeekSeconds = normalizeTimelineSeekSeconds(
        rulerClientXToSeconds(
          event.clientX,
          event.currentTarget,
          getCameraX(),
          songRef.current?.durationSeconds ?? 0,
          livePixelsPerSecondRef.current,
        ),
        songRef.current?.durationSeconds ?? 0,
      );
      // Capture the playhead's true position BEFORE previewSeek shifts the
      // visual cursor to the click point — otherwise snap-to-playhead would
      // pull the dragged clip toward the click coordinate, not toward where
      // the transport actually is.
      const playheadAnchorSeconds =
        snapshotRef.current?.positionSeconds ??
        displayPositionSecondsRef.current;
      previewSeek(clickSeekSeconds);

      // Selection update. Three modes:
      //   Ctrl/Cmd+click → toggle just this clip
      //   Shift+click    → range select from the anchor through this clip
      //                    (ordered by song.clips order — the same order the
      //                    track list iterates)
      //   plain click    → replace selection (unless the clip is already
      //                    inside a multi-selection, in which case keep the
      //                    selection so the user can drag the whole group)
      const currentSong = songRef.current;
      const currentSelection =
        useTimelineUIStore.getState().selectedClipIds;
      if (event.ctrlKey || event.metaKey) {
        toggleClipSelection(hitClip.id);
        clipSelectionAnchorRef.current = hitClip.id;
      } else if (event.shiftKey && currentSong) {
        // Shift-click selects a 2-D rectangle of clips: temporal range
        // from the earliest start to the latest end across both
        // anchor and hit clip, intersected with the vertical band of
        // tracks between them. This matches the user expectation when
        // they cut several tracks at the same point and want to grab
        // every left-of-cut fragment in one gesture. Falls back to
        // single select when there's no usable anchor (e.g. anchor
        // clip got deleted since the last click).
        const anchor = clipSelectionAnchorRef.current;
        const anchorClip = anchor ? findClip(currentSong, anchor) : null;
        if (anchorClip) {
          const trackOrder = currentSong.tracks.map((t) => t.id);
          const anchorTrackIdx = trackOrder.indexOf(anchorClip.trackId);
          const hitTrackIdx = trackOrder.indexOf(hitClip.trackId);
          const minTrackIdx = Math.min(anchorTrackIdx, hitTrackIdx);
          const maxTrackIdx = Math.max(anchorTrackIdx, hitTrackIdx);
          const anchorStart = anchorClip.timelineStartSeconds;
          const anchorEnd = anchorStart + anchorClip.durationSeconds;
          const hitStart = hitClip.timelineStartSeconds;
          const hitEnd = hitStart + hitClip.durationSeconds;
          const rectStart = Math.min(anchorStart, hitStart);
          const rectEnd = Math.max(anchorEnd, hitEnd);
          // A clip is in the rectangle when its track is between the
          // two endpoints AND its timeline span overlaps [rectStart,
          // rectEnd]. Overlap (not strict-inside) so a clip that
          // straddles either edge — typical for the freshly-cut left
          // fragment whose end is exactly the cursor — still gets
          // grabbed.
          const next = currentSong.clips
            .filter((clip) => {
              const trackIdx = trackOrder.indexOf(clip.trackId);
              if (trackIdx < minTrackIdx || trackIdx > maxTrackIdx) {
                return false;
              }
              const clipStart = clip.timelineStartSeconds;
              const clipEnd = clipStart + clip.durationSeconds;
              return clipEnd > rectStart && clipStart < rectEnd;
            })
            .map((clip) => clip.id);
          if (next.length > 0) {
            setSelectedClipIds(next);
          } else {
            selectClip(hitClip.id, track.id);
            clipSelectionAnchorRef.current = hitClip.id;
          }
        } else {
          selectClip(hitClip.id, track.id);
          clipSelectionAnchorRef.current = hitClip.id;
        }
      } else if (!currentSelection.includes(hitClip.id)) {
        selectClip(hitClip.id, track.id);
        clipSelectionAnchorRef.current = hitClip.id;
      } else {
        // Clicked on an already-selected clip while several were selected.
        // Keep the multi-selection FOR NOW so the drag can move the whole
        // group, but remember that we should collapse the selection down to
        // just this clip if the user releases without dragging. This is the
        // same pattern Ableton / Reaper / Finder use: mouseDown preserves
        // the group (so drag works), plain mouseUp resets to one.
        clipSelectionPendingCollapseRef.current =
          currentSelection.length > 1 ? hitClip.id : null;
      }

      setContextMenu(null);

      // Build the drag manifest from the *post-update* selection. When the
      // primary clip is part of a multi-selection (e.g. user kept a group
      // and started dragging one of them), every selected clip travels with
      // the same delta as the primary.
      const finalSelection = useTimelineUIStore.getState().selectedClipIds;
      const members: ClipDragMember[] = [];
      const previewSeed: Record<string, number> = {};
      if (currentSong && finalSelection.includes(hitClip.id)) {
        for (const clipId of finalSelection) {
          const clip = findClip(currentSong, clipId);
          if (!clip) continue;
          members.push({
            clipId: clip.id,
            originSeconds: clip.timelineStartSeconds,
            previewSeconds: clip.timelineStartSeconds,
          });
          previewSeed[clip.id] = clip.timelineStartSeconds;
        }
      }
      if (members.length === 0) {
        // Selection didn't include the primary (e.g. plain click during a
        // shift-range that ended elsewhere). Fall back to dragging just it.
        members.push({
          clipId: hitClip.id,
          originSeconds: hitClip.timelineStartSeconds,
          previewSeconds: hitClip.timelineStartSeconds,
        });
        previewSeed[hitClip.id] = hitClip.timelineStartSeconds;
      }

      const snapAnchors = currentSong
        ? buildClipSnapAnchors(currentSong, members, playheadAnchorSeconds)
        : [];

      clipDragRef.current = {
        clipId: hitClip.id,
        pointerId: 1,
        originSeconds: hitClip.timelineStartSeconds,
        previewSeconds: hitClip.timelineStartSeconds,
        clickSeekSeconds,
        startClientX: event.clientX,
        hasMoved: false,
        members,
        snapAnchors,
        activeSnapAnchor: null,
      };
      clipPreviewSecondsRef.current = previewSeed;
      return;
    }

    event.preventDefault();
    setContextMenu(null);
    const previewSeconds = normalizeTimelineSeekSeconds(
      rulerClientXToSeconds(
        event.clientX,
        event.currentTarget,
        getCameraX(),
        songRef.current?.durationSeconds ?? 0,
        livePixelsPerSecondRef.current,
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
      livePixelsPerSecondRef.current,
    );

    if (hitClip) {
      selectClip(hitClip.id, track.id);
      openMenu(event, clipDisplayName(hitClip), clipContextMenu(hitClip));
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

  function handleTrackHeadersEmptyAreaContextMenu(
    event: ReactMouseEvent<HTMLDivElement>,
  ) {
    if (!songRef.current) {
      return;
    }

    clearSelection();
    setSelectedRegionId(null);
    openMenu(
      event,
      t("transport.menu.tracksMenuTitle", { defaultValue: "Tracks" }),
      globalTrackListContextMenu(),
    );
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
            setStatus(
              t("transport.status.markerCursorSent", { name: section.name }),
            );
          });
        },
      },
      {
        label: t("common.rename"),
        disabled: !canEditMarker,
        onSelect: async () => {
          const nextName = window
            .prompt(t("transport.prompt.markerRename"), section.name)
            ?.trim();
          if (!nextName) {
            return;
          }
          await runAction(async () => {
            const nextSnapshot = await updateSectionMarker(
              section.id,
              nextName,
              section.startSeconds,
            );
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
            setStatus(
              t("transport.status.markerDeleted", { name: section.name }),
            );
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

  function handleToggleTopMenu(menuKey: "file") {
    setOpenTopMenu((currentMenu) => (currentMenu === menuKey ? null : menuKey));
  }

  function handleTopMenuAction(action: () => void) {
    setOpenTopMenu(null);
    action();
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

  function timeSignatureMarkerContextMenu(marker: TimeSignatureMarkerSummary) {
    return [
      {
        label: "Cambiar compas",
        onSelect: async () => {
          const nextSignature = window
            .prompt("Compas", marker.signature)
            ?.trim();
          if (!nextSignature) {
            return;
          }

          await runAction(async () => {
            const nextSnapshot = await upsertSongTimeSignatureMarker(
              marker.startSeconds,
              nextSignature,
            );
            applyPlaybackSnapshot(nextSnapshot);
            setTimeSignatureDraft(nextSignature);
            setStatus(`Compas actualizado a ${nextSignature}`);
          });
        },
      },
      {
        label: t("transport.menu.deleteMarker"),
        onSelect: async () => {
          await runAction(async () => {
            const nextSnapshot = await deleteSongTimeSignatureMarker(marker.id);
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(
              `Marca de compas eliminada en ${formatClock(marker.startSeconds)}`,
            );
          });
        },
      },
    ];
  }

  function handleTrackAudioToChange(trackId: string, nextAudioTo: string) {
    void runAction(async () => {
      const nextSnapshot = await commitTrackMixChange({
        trackId,
        audioTo: nextAudioTo,
      });
      applyPlaybackSnapshot(nextSnapshot);
      setStatus(
        t("transport.status.trackRoutingUpdated", {
          defaultValue: "Track routing updated.",
        }),
      );
    });
  }

  function handleDismissMissingMidiDeviceWarning() {
    setMissingMidiDeviceWarning(null);
  }

  function handleHideMissingMidiDeviceWarning() {
    setMissingMidiDeviceWarning(null);
    persistAudioSettings(
      {
        ...appSettings,
        suppressMissingMidiDeviceWarning: true,
      },
      t("transport.status.midiWarningHidden"),
    );
  }

  function resolveDraggedLibraryAsset(
    filePath: string,
    durationSeconds: number,
  ): LibraryAssetSummary {
    return (
      libraryAssets.find((asset) => asset.filePath === filePath) ?? {
        fileName: libraryAssetFileName(filePath),
        filePath,
        durationSeconds,
        isMissing: false,
        folderPath: null,
      }
    );
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

  function resolveLibraryPreviewTrackId(
    targetTrackId: string | null,
    layout: LibraryDropLayout,
    index: number,
  ) {
    if (layout === "horizontal" || !targetTrackId) {
      return targetTrackId;
    }

    const baseIndex = visibleTracks.findIndex(
      (track) => track.id === targetTrackId,
    );
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
      const asset = resolveDraggedLibraryAsset(
        item.file_path,
        item.durationSeconds,
      );
      const timelineStartSeconds =
        args.layout === "horizontal"
          ? args.timelineStartSeconds + accumulatedDurationSeconds
          : args.timelineStartSeconds;

      accumulatedDurationSeconds += asset.durationSeconds;

      return {
        trackId: resolveLibraryPreviewTrackId(
          args.targetTrackId,
          args.layout,
          index,
        ),
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

    return (
      rulerTrackRef.current?.getBoundingClientRect() ??
      element.getBoundingClientRect()
    );
  }

  function snapTimelineDropSeconds(rawSeconds: number) {
    const candidates = timelineGrid.markers
      .map((marker) => marker.seconds)
      .filter((seconds) => Number.isFinite(seconds));

    if (candidates.length > 0) {
      return candidates.reduce(
        (nearest, seconds) =>
          Math.abs(seconds - rawSeconds) < Math.abs(nearest - rawSeconds)
            ? seconds
            : nearest,
        candidates[0],
      );
    }

    const timingRegion = getSongTempoRegionAtPosition(song, rawSeconds);
    return snapToTimelineGrid(
      rawSeconds,
      timingRegion?.bpm ?? songBaseBpm,
      timingRegion?.timeSignature ?? songBaseTimeSignature,
      liveZoomLevelRef.current,
      livePixelsPerSecondRef.current,
      buildSongTempoRegions(song),
    );
  }

  function resolveLibraryDropSecondsAtClientX(
    clientX: number,
    element: HTMLElement,
  ) {
    const bounds = getLibraryDragViewportBounds(element);
    const viewportX = clamp(clientX - bounds.left, 0, bounds.width);
    const rawSeconds = screenXToSeconds(
      viewportX,
      getCameraX(),
      livePixelsPerSecondRef.current,
    );

    return snapEnabled ? snapTimelineDropSeconds(rawSeconds) : rawSeconds;
  }

  function resolveTimelineDropGeometryFromClientPoint(
    clientX: number,
    clientY: number,
  ): TimelineDropGeometry | null {
    const targetElement = resolveTimelineDropTargetAtClientPoint(
      clientX,
      clientY,
    );
    if (!targetElement) {
      return null;
    }

    const viewportBounds = getLibraryDragViewportBounds(targetElement);
    const viewportX = clamp(
      clientX - viewportBounds.left,
      0,
      viewportBounds.width,
    );
    const rawSeconds = screenXToSeconds(
      viewportX,
      getCameraX(),
      livePixelsPerSecondRef.current,
    );
    const snappedSeconds = snapTimelineDropSeconds(rawSeconds);
    const previewGeometry = buildTimelineDropPreviewGeometry({
      clientX,
      viewportLeft: viewportBounds.left,
      viewportWidth: viewportBounds.width,
      cameraX: getCameraX(),
      pixelsPerSecond: livePixelsPerSecondRef.current,
      snappedSeconds,
      snapEnabled,
    });

    return {
      targetElement,
      targetTrackId:
        targetElement
          .closest("[data-track-id]")
          ?.getAttribute("data-track-id") ?? null,
      viewportBounds,
      viewportX: previewGeometry.viewportX,
      rawSeconds: previewGeometry.rawSeconds,
      snappedSeconds: previewGeometry.snappedSeconds,
      dropSeconds: previewGeometry.dropSeconds,
      rawLeftPx: previewGeometry.rawLeftPx,
      rawClientX: previewGeometry.rawClientX,
      snappedLeftPx: previewGeometry.snappedLeftPx,
      snappedClientX: previewGeometry.snappedClientX,
      previewLeftPx: previewGeometry.previewLeftPx,
      previewClientX: previewGeometry.previewClientX,
      snapApplied: previewGeometry.snapApplied,
    };
  }

  function resolveLibraryGhostLeft(timelineStartSeconds: number) {
    return secondsToScreenX(
      timelineStartSeconds,
      getCameraX(),
      livePixelsPerSecondRef.current,
    );
  }

  function updateLibraryClipPreview(
    hoverState: LibraryDragHoverState,
    element: HTMLElement,
  ) {
    const layout = resolveLibraryDropLayout(
      hoverState.payload,
      hoverState.targetTrackId,
      hoverState.ctrlKey,
      hoverState.metaKey,
    );
    const timelineStartSeconds = resolveLibraryDropSecondsAtClientX(
      hoverState.clientX,
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

  function getClientElementAtPoint(clientX: number, clientY: number) {
    if (typeof document.elementFromPoint !== "function") {
      return null;
    }

    const target = document.elementFromPoint(clientX, clientY);
    return target instanceof HTMLElement ? target : null;
  }

  function resolveTimelineDropTargetAtClientPoint(
    clientX: number,
    clientY: number,
  ) {
    const target = getClientElementAtPoint(clientX, clientY);
    if (!(target instanceof HTMLElement)) {
      return null;
    }

    if (!timelineShellRef.current?.contains(target)) {
      return null;
    }

    return target.closest(
      ".lt-track-lane, .lt-track-list, .lt-track-list-dropzone",
    ) as HTMLDivElement | null;
  }

  function resolveTimelineDropFromClientPoint(
    clientX: number,
    clientY: number,
  ) {
    const geometry = resolveTimelineDropGeometryFromClientPoint(
      clientX,
      clientY,
    );
    if (!geometry) {
      return {
        isOverTimeline: false,
        dropSeconds: 0,
        targetTrackId: null,
        previewLeftPx: null,
        previewClientX: null,
        rawSeconds: null,
        snappedSeconds: null,
        snapApplied: snapEnabled,
      };
    }

    return {
      isOverTimeline: true,
      dropSeconds: geometry.dropSeconds,
      targetTrackId: geometry.targetTrackId,
      previewLeftPx: geometry.previewLeftPx,
      previewClientX: geometry.previewClientX,
      rawSeconds: geometry.rawSeconds,
      snappedSeconds: geometry.snappedSeconds,
      snapApplied: geometry.snapApplied,
    };
  }

  function scoreNativeDropCandidate(candidate: NativeDropCandidateDebug) {
    if (!candidate.isOverTimeline) {
      return 0;
    }

    let score = 100;
    if (candidate.elementFromPoint?.includes(".lt-track-lane")) {
      score += 200;
    } else if (
      candidate.elementFromPoint?.includes(".lt-track-list-dropzone")
    ) {
      score += 180;
    } else if (candidate.elementFromPoint?.includes(".lt-track-list")) {
      score += 140;
    }

    if (
      candidate.laneBounds &&
      candidate.clientX >= candidate.laneBounds.left &&
      candidate.clientX <= candidate.laneBounds.right
    ) {
      score += 40;
    }

    if (
      candidate.laneBounds &&
      candidate.clientY >= candidate.laneBounds.top &&
      candidate.clientY <= candidate.laneBounds.bottom
    ) {
      score += 20;
    }

    if (candidate.rawDeltaPx != null) {
      if (candidate.rawDeltaPx <= 2) {
        score += 300;
      } else if (candidate.rawDeltaPx <= 8) {
        score += 200;
      } else if (candidate.rawDeltaPx <= 24) {
        score += 80;
      } else {
        score -= Math.min(300, candidate.rawDeltaPx);
      }
    }

    return score;
  }

  function resolveNativeDropCandidate(
    candidate: NativeClientPointCandidate,
  ): NativeDropCandidateDebug {
    const rawElement = getClientElementAtPoint(
      candidate.clientX,
      candidate.clientY,
    );
    const geometry = resolveTimelineDropGeometryFromClientPoint(
      candidate.clientX,
      candidate.clientY,
    );
    const targetElement = geometry?.targetElement ?? null;
    const laneElement = targetElement?.classList.contains("lt-track-lane")
      ? targetElement
      : (targetElement?.closest(".lt-track-lane") as HTMLElement | null);
    const laneBounds = laneElement?.getBoundingClientRect() ?? null;
    const rulerBounds = rulerTrackRef.current?.getBoundingClientRect() ?? null;

    if (!geometry) {
      return {
        label: candidate.label,
        clientX: candidate.clientX,
        clientY: candidate.clientY,
        elementFromPoint: describeNativeDropElement(rawElement),
        laneBounds: toNativeDropDebugRect(laneBounds),
        rulerBounds: toNativeDropDebugRect(rulerBounds),
        dropSeconds: null,
        rawSeconds: null,
        snappedSeconds: null,
        rawLeftPx: null,
        rawClientX: null,
        snappedLeftPx: null,
        snappedClientX: null,
        previewLeftPx: null,
        previewClientX: null,
        rawDeltaPx: null,
        snapDeltaPx: null,
        snapApplied: snapEnabled,
        score: 0,
        isOverTimeline: false,
        targetTrackId: null,
      };
    }

    const rawDeltaPx = Math.abs(geometry.rawClientX - candidate.clientX);
    const snapDeltaPx = Math.abs(geometry.previewClientX - candidate.clientX);
    const debugCandidate: NativeDropCandidateDebug = {
      label: candidate.label,
      clientX: candidate.clientX,
      clientY: candidate.clientY,
      elementFromPoint: describeNativeDropElement(rawElement),
      laneBounds: toNativeDropDebugRect(laneBounds),
      rulerBounds: toNativeDropDebugRect(rulerBounds),
      dropSeconds: geometry.dropSeconds,
      rawSeconds: geometry.rawSeconds,
      snappedSeconds: geometry.snappedSeconds,
      rawLeftPx: geometry.rawLeftPx,
      rawClientX: geometry.rawClientX,
      snappedLeftPx: geometry.snappedLeftPx,
      snappedClientX: geometry.snappedClientX,
      previewLeftPx: geometry.previewLeftPx,
      previewClientX: geometry.previewClientX,
      rawDeltaPx,
      snapDeltaPx,
      snapApplied: geometry.snapApplied,
      score: 0,
      isOverTimeline: true,
      targetTrackId: geometry.targetTrackId,
    };
    debugCandidate.score = scoreNativeDropCandidate(debugCandidate);
    return debugCandidate;
  }

  function resolveTimelineDropFromNativePosition(position: {
    x: number;
    y: number;
  }) {
    const candidates = nativeClientPointCandidates(
      position,
      nativeWebviewPositionRef.current,
    ).map(resolveNativeDropCandidate);

    if (NATIVE_DND_DEBUG_ENABLED) {
      console.debug("[native-dnd] candidates", {
        nativePosition: position,
        webviewPosition: nativeWebviewPositionRef.current,
        cameraX: getCameraX(),
        pixelsPerSecond: livePixelsPerSecondRef.current,
        candidates,
      });
      setNativeDropDebugCandidates(candidates);
    }

    const selectedCandidate = selectNativeDropCandidate(candidates);

    nativeDropCoordinateModeRef.current = selectedCandidate?.label ?? null;

    if (selectedCandidate?.dropSeconds != null) {
      return {
        isOverTimeline: true,
        dropSeconds: selectedCandidate.dropSeconds,
        targetTrackId: selectedCandidate.targetTrackId,
        previewLeftPx: selectedCandidate.previewLeftPx,
        previewClientX: selectedCandidate.previewClientX,
        rawSeconds: selectedCandidate.rawSeconds,
        snappedSeconds: selectedCandidate.snappedSeconds,
        snapApplied: selectedCandidate.snapApplied,
        coordinateMode: selectedCandidate.label,
      };
    }

    return {
      isOverTimeline: false,
      dropSeconds: 0,
      targetTrackId: null,
      previewLeftPx: null,
      previewClientX: null,
      rawSeconds: null,
      snappedSeconds: null,
      snapApplied: snapEnabled,
      coordinateMode: null,
    };
  }

  function resolveLibraryFolderDropFromClientPoint(
    clientX: number,
    clientY: number,
  ) {
    if (typeof document.elementFromPoint !== "function") {
      return null;
    }

    const target = document.elementFromPoint(clientX, clientY);
    if (!(target instanceof HTMLElement)) {
      return null;
    }

    const folderSummary = target.closest(
      '[data-library-folder-drop-target="true"]',
    );
    if (!(folderSummary instanceof HTMLElement)) {
      return null;
    }

    const folderPath = folderSummary.getAttribute("data-library-folder-path");
    return {
      folderPath: folderPath && folderPath.length > 0 ? folderPath : null,
    };
  }

  function resolveLibraryAutoScrollVelocity(distancePx: number) {
    if (distancePx >= LIBRARY_DRAG_EDGE_BUFFER_PX) {
      return 0;
    }

    const intensity =
      (LIBRARY_DRAG_EDGE_BUFFER_PX - Math.max(0, distancePx)) /
      LIBRARY_DRAG_EDGE_BUFFER_PX;
    return Math.max(
      1,
      Math.round(intensity * intensity * LIBRARY_DRAG_MAX_SCROLL_SPEED_PX),
    );
  }

  function tickLibraryDragAutoScroll() {
    const autoScrollState = libraryDragAutoScrollRef.current;
    const laneArea = laneAreaRef.current;
    const verticalScrollViewport = timelineScrollViewportRef.current;
    const hoverState = libraryDragHoverRef.current;

    if (
      !hoverState ||
      (!autoScrollState.horizontalVelocity && !autoScrollState.verticalVelocity)
    ) {
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
        ? (laneArea?.querySelector(
            `[data-track-id="${hoverState.targetTrackId}"] .lt-track-lane`,
          ) as HTMLDivElement | null)
        : laneArea;
    if (hoverElement) {
      updateLibraryClipPreview(hoverState, hoverElement);
    }

    autoScrollState.frameId = window.requestAnimationFrame(
      tickLibraryDragAutoScroll,
    );
  }

  function updateLibraryDragAutoScrollAtClientPoint(
    clientX: number,
    clientY: number,
  ) {
    const autoScrollState = libraryDragAutoScrollRef.current;
    const horizontalBounds =
      rulerTrackRef.current?.getBoundingClientRect() ??
      timelineShellRef.current?.getBoundingClientRect();
    const verticalBounds =
      timelineScrollViewportRef.current?.getBoundingClientRect();

    let horizontalVelocity = 0;
    if (horizontalBounds) {
      const distanceToLeft = clientX - horizontalBounds.left;
      const distanceToRight = horizontalBounds.right - clientX;

      if (distanceToLeft < LIBRARY_DRAG_EDGE_BUFFER_PX) {
        horizontalVelocity = -resolveLibraryAutoScrollVelocity(distanceToLeft);
      } else if (distanceToRight < LIBRARY_DRAG_EDGE_BUFFER_PX) {
        horizontalVelocity = resolveLibraryAutoScrollVelocity(distanceToRight);
      }
    }

    let verticalVelocity = 0;
    if (verticalBounds) {
      const distanceToTop = clientY - verticalBounds.top;
      const distanceToBottom = verticalBounds.bottom - clientY;

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
      autoScrollState.frameId = window.requestAnimationFrame(
        tickLibraryDragAutoScroll,
      );
    }
  }

  function setInternalLibraryPointerDragState(
    next: InternalLibraryPointerDrag | null,
  ) {
    internalLibraryPointerDragRef.current = next;
    setInternalLibraryPointerDrag(next);
  }

  // Returns the region id of the compact song column under the given
  // viewport coordinates, or null if the point is over the compact
  // strip but not on a specific column (e.g. action buttons / empty
  // gutter), or undefined when the point isn't on the compact view at
  // all. Used by both the internal library drag pipeline and the
  // native OS drag pipeline to drive `compactDragPreview`.
  function resolveCompactRegionAtPoint(
    clientX: number,
    clientY: number,
  ): { hit: true; regionId: string | null } | { hit: false } {
    const element = document.elementFromPoint(clientX, clientY) as
      | HTMLElement
      | null;
    if (!element) return { hit: false };
    const column = element.closest(
      ".lt-compact-song-column[data-region-id]",
    ) as HTMLElement | null;
    if (column) {
      return { hit: true, regionId: column.getAttribute("data-region-id") };
    }
    // Anywhere over the song strip counts as "on the compact view" so
    // package drags can show the ghost column even outside a song.
    const strip = element.closest(".lt-compact-songs");
    if (strip) return { hit: true, regionId: null };
    return { hit: false };
  }

  function stopInternalLibraryPointerDragListeners() {
    const listeners = internalLibraryPointerDragListenersRef.current;
    if (!listeners) {
      return;
    }

    window.removeEventListener("pointermove", listeners.move);
    window.removeEventListener("pointerup", listeners.up);
    window.removeEventListener("pointercancel", listeners.cancel);
    window.removeEventListener("mousemove", listeners.mouseMove);
    window.removeEventListener("mouseup", listeners.mouseUp);
    internalLibraryPointerDragListenersRef.current = null;
  }

  function clearInternalLibraryPointerDrag() {
    stopInternalLibraryPointerDragListeners();
    clearLibraryDragPreview();
    clearActiveLibraryDragPayload();
    setInternalLibraryPointerDragState(null);
    setCompactDragPreview(null);
  }

  function updateInternalLibraryPointerDragHover(args: {
    drag: InternalLibraryPointerDrag;
    clientX: number;
    clientY: number;
    ctrlKey: boolean;
    metaKey: boolean;
  }): InternalLibraryPointerDrag {
    const libraryFolderTarget = resolveLibraryFolderDropFromClientPoint(
      args.clientX,
      args.clientY,
    );
    if (libraryFolderTarget) {
      clearLibraryDragPreview();
      return {
        ...args.drag,
        hover: {
          kind: "library-folder" as const,
          folderPath: libraryFolderTarget.folderPath,
        },
      };
    }

    const hit = resolveTimelineDropFromClientPoint(args.clientX, args.clientY);
    if (!hit.isOverTimeline) {
      clearLibraryDragPreview();
      return {
        ...args.drag,
        hover: null,
      };
    }

    const targetElement = resolveTimelineDropTargetAtClientPoint(
      args.clientX,
      args.clientY,
    );
    if (!targetElement) {
      clearLibraryDragPreview();
      return {
        ...args.drag,
        hover: null,
      };
    }

    libraryDragHoverRef.current = {
      clientX: args.clientX,
      clientY: args.clientY,
      ctrlKey: args.ctrlKey,
      metaKey: args.metaKey,
      payload: args.drag.payload,
      targetTrackId: hit.targetTrackId,
    };
    updateLibraryClipPreview(libraryDragHoverRef.current, targetElement);
    updateLibraryDragAutoScrollAtClientPoint(args.clientX, args.clientY);

    return {
      ...args.drag,
      hover: {
        kind: "timeline" as const,
        dropSeconds: hit.dropSeconds,
        targetTrackId: hit.targetTrackId,
        layout: resolveLibraryDropLayout(
          args.drag.payload,
          hit.targetTrackId,
          args.ctrlKey,
          args.metaKey,
        ),
      },
    };
  }

  function handleInternalLibraryPointerMove(event: PointerEvent) {
    const drag = internalLibraryPointerDragRef.current;
    if (!drag) {
      return;
    }

    const hasMoved =
      Math.hypot(
        event.clientX - drag.origin.x,
        event.clientY - drag.origin.y,
      ) >= DRAG_THRESHOLD_PX;
    let nextDrag: InternalLibraryPointerDrag = {
      ...drag,
      current: {
        x: event.clientX,
        y: event.clientY,
      },
      isDragging: drag.isDragging || hasMoved,
    };

    if (nextDrag.isDragging) {
      nextDrag = updateInternalLibraryPointerDragHover({
        drag: nextDrag,
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
      });

      // Compact-view drop preview: library items are never .ltpkg, so
      // we always emit isPackage=false and let the per-column handler
      // render `count` dashed placeholders.
      const hit = resolveCompactRegionAtPoint(event.clientX, event.clientY);
      if (hit.hit) {
        const count = nextDrag.payload.length;
        setCompactDragPreview({
          targetRegionId: hit.regionId,
          count,
          isPackage: false,
        });
      } else {
        setCompactDragPreview((current) => (current === null ? current : null));
      }
    }

    setInternalLibraryPointerDragState(nextDrag);
  }

  function handleInternalLibraryPointerUp(event: PointerEvent) {
    const drag = internalLibraryPointerDragRef.current;
    if (!drag) {
      return;
    }

    let nextDrag = drag;
    if (drag.isDragging) {
      nextDrag = updateInternalLibraryPointerDragHover({
        drag: {
          ...drag,
          current: {
            x: event.clientX,
            y: event.clientY,
          },
        },
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
      });
    }

    const hover = nextDrag.hover;
    clearInternalLibraryPointerDrag();

    if (!nextDrag.isDragging) {
      return;
    }

    // Compact-view drop targets aren't part of the timeline hit-test that
    // updateInternalLibraryPointerDragHover knows about, so we check for
    // them manually by walking the DOM under the pointer. A column carries
    // its region id via data-region-id so we can route the drop through
    // createClipsWithAutoTracks the same way the OS-file drop in step 5.6.B
    // does.
    const elementAtPointer = document.elementFromPoint(
      event.clientX,
      event.clientY,
    ) as HTMLElement | null;
    const compactColumn = elementAtPointer?.closest(
      ".lt-compact-song-column[data-region-id]",
    ) as HTMLElement | null;
    if (compactColumn) {
      const regionId = compactColumn.getAttribute("data-region-id");
      if (regionId) {
        const payload = nextDrag.payload.map((item) => ({
          filePath: item.file_path,
          durationSeconds: item.durationSeconds,
        }));
        handleCompactDropLibraryAssetsIntoSong(regionId, payload);
        return;
      }
    }

    if (!hover) {
      return;
    }

    if (hover.kind === "library-folder") {
      void handleMoveLibraryAssets(
        nextDrag.payload.map((item) => item.file_path),
        hover.folderPath,
      );
      return;
    }

    void runAction(async () => {
      await placeLibraryAssetsOnTimeline({
        payload: nextDrag.payload,
        timelineStartSeconds: hover.dropSeconds,
        targetTrackId: hover.targetTrackId,
        layout: hover.layout,
      });
    });
  }

  function startInternalLibraryPointerDrag(args: {
    payload: LibraryAssetDragPayload[];
    origin: { x: number; y: number };
    current: { x: number; y: number };
  }) {
    clearInternalLibraryPointerDrag();

    const nextDrag: InternalLibraryPointerDrag = {
      id:
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `library-pointer-drag-${Date.now()}`,
      payload: args.payload,
      origin: args.origin,
      current: args.current,
      isDragging: true,
      hover: null,
    };

    activeLibraryDragPayloadRef.current = args.payload;
    setInternalLibraryPointerDragState(nextDrag);

    const move = (event: PointerEvent) => {
      handleInternalLibraryPointerMove(event);
    };
    const up = (event: PointerEvent) => {
      handleInternalLibraryPointerUp(event);
    };
    const cancel = () => {
      clearInternalLibraryPointerDrag();
    };
    const mouseMove = (event: MouseEvent) => {
      handleInternalLibraryPointerMove(event as unknown as PointerEvent);
    };
    const mouseUp = (event: MouseEvent) => {
      handleInternalLibraryPointerUp(event as unknown as PointerEvent);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("mousemove", mouseMove);
    window.addEventListener("mouseup", mouseUp);
    internalLibraryPointerDragListenersRef.current = {
      move,
      up,
      cancel,
      mouseMove,
      mouseUp,
    };
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

    const optimisticOperationId = startOptimisticClipOperation(
      args.placements.map((placement, index) => ({
        id: `optimistic-clip-${Date.now()}-${index}`,
        trackId: placement.trackId,
        trackName:
          tracksByIdRef.current[placement.trackId]?.name ??
          humanizeLibraryTrackName(placement.asset.filePath),
        filePath: placement.asset.filePath,
        waveformKey: placement.asset.filePath,
        isMissing: placement.asset.isMissing,
        timelineStartSeconds: placement.timelineStartSeconds,
        sourceStartSeconds: 0,
        sourceWindowDurationSeconds: placement.asset.durationSeconds,
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
      completeOptimisticClipOperation(
        optimisticOperationId,
        clipSnapshot.projectRevision,
      );
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
    const assets = args.payload.map((item) =>
      resolveDraggedLibraryAsset(item.file_path, item.durationSeconds),
    );
    if (!assets.length) {
      return;
    }

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
          index === 0 && args.targetTrackId
            ? null
            : await createLibraryTrackForAsset(asset);
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

  async function handleDroppedSongPackagePath(
    packagePath: string,
    dropSeconds: number,
  ) {
    const result = await importSongPackage(packagePath, dropSeconds);
    applyPlaybackSnapshot(result.snapshot);
    mergeLibraryAssets(result.libraryAssets);
    await refreshLibraryState({ preserveAssets: result.libraryAssets });
    await refreshSongView();
    setStatus(
      t("transport.status.packageImportedAt", {
        time: formatClock(dropSeconds),
      }),
    );
  }

  async function createRealTracksAndClipsForImportedAssets(args: {
    importedAssets: LibraryAssetSummary[];
    dropSeconds: number;
  }) {
    const placements: Array<{
      asset: LibraryAssetSummary;
      trackId: string;
      timelineStartSeconds: number;
    }> = [];
    let pendingTrackSnapshot: TransportSnapshot | null = null;
    let selectedTrackId: string | null = null;

    for (const asset of args.importedAssets) {
      const createdTrack = await createLibraryTrackForAsset(asset);
      if (!createdTrack.trackId) {
        if (createdTrack.snapshot) {
          applyPlaybackSnapshot(createdTrack.snapshot);
        }
        continue;
      }

      pendingTrackSnapshot = createdTrack.snapshot;
      selectedTrackId = createdTrack.trackId;
      placements.push({
        asset,
        trackId: createdTrack.trackId,
        timelineStartSeconds: args.dropSeconds,
      });
    }

    await commitLibraryClipPlacements({
      placements,
      pendingTrackSnapshot,
    });

    if (selectedTrackId) {
      selectTrack([selectedTrackId]);
    }

    setSelectedSectionId(null);
  }

  async function startDroppedAudioImportJob(args: {
    files: File[];
    pendingImports: PendingAudioImport[];
    dropSeconds: number;
  }) {
    const { files, pendingImports, dropSeconds } = args;
    const pendingIds = pendingImports.map((item) => item.id);

    await nextPaint();

    try {
      const nativePayloads = isTauriApp
        ? resolveNativeAudioImportPayloads(files)
        : null;

      let importedAssets: LibraryAssetSummary[];
      if (nativePayloads) {
        useTransportStore
          .getState()
          .updatePendingAudioImportStatus(pendingIds, "importing");
        importedAssets = await importAudioFilesFromPaths(nativePayloads);
      } else {
        useTransportStore
          .getState()
          .updatePendingAudioImportStatus(pendingIds, "reading");

        const payloads = await Promise.all(
          files.map(async (file) => ({
            fileName: file.name,
            bytes: new Uint8Array(await file.arrayBuffer()),
          })),
        );

        useTransportStore
          .getState()
          .updatePendingAudioImportStatus(pendingIds, "importing");
        importedAssets = await importAudioFilesFromBytes(payloads);
      }

      useTransportStore
        .getState()
        .updatePendingAudioImportStatus(pendingIds, "metadata");
      mergeLibraryAssets(importedAssets);
      await refreshLibraryState({ preserveAssets: importedAssets });

      useTransportStore
        .getState()
        .updatePendingAudioImportStatus(pendingIds, "analyzing");
      await createRealTracksAndClipsForImportedAssets({
        importedAssets,
        dropSeconds,
      });

      useTransportStore.getState().removePendingAudioImports(pendingIds);
      setStatus(
        importedAssets.length === 1
          ? t("transport.status.clipAdded", {
              name: importedAssets[0].fileName,
            })
          : t("transport.status.clipsAdded", { count: importedAssets.length }),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not import audio files. Please check the files and try again.";

      useTransportStore
        .getState()
        .markPendingAudioImportsFailed(pendingIds, message);
      setStatus(message);
    }
  }

  function handleDroppedAudioFiles(files: File[], dropSeconds: number) {
    const pendingImports = createPendingAudioImports(files, dropSeconds);
    useTransportStore.getState().addPendingAudioImports(pendingImports);

    setStatus(
      files.length === 1
        ? `Importing ${files[0].name}...`
        : `Importing ${files.length} audio files...`,
    );

    void startDroppedAudioImportJob({
      files,
      pendingImports,
      dropSeconds,
    });
  }

  async function startDroppedAudioPathImportJob(args: {
    paths: string[];
    pendingImports: PendingAudioImport[];
    dropSeconds: number;
  }) {
    const pendingIds = args.pendingImports.map((item) => item.id);

    await nextPaint();

    try {
      useTransportStore
        .getState()
        .updatePendingAudioImportStatus(pendingIds, "importing");

      const importedAssets = await importAudioFilesFromPaths(
        args.paths.map((path) => ({
          fileName: libraryAssetFileName(path),
          sourcePath: path,
        })),
      );

      useTransportStore
        .getState()
        .updatePendingAudioImportStatus(pendingIds, "metadata");
      mergeLibraryAssets(importedAssets);
      await refreshLibraryState({ preserveAssets: importedAssets });

      useTransportStore
        .getState()
        .updatePendingAudioImportStatus(pendingIds, "analyzing");
      await createRealTracksAndClipsForImportedAssets({
        importedAssets,
        dropSeconds: args.dropSeconds,
      });

      useTransportStore.getState().removePendingAudioImports(pendingIds);
      setStatus(
        importedAssets.length === 1
          ? t("transport.status.clipAdded", {
              name: importedAssets[0].fileName,
            })
          : t("transport.status.clipsAdded", { count: importedAssets.length }),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not import audio files. Please check the files and try again.";

      useTransportStore
        .getState()
        .markPendingAudioImportsFailed(pendingIds, message);
      setStatus(message);
    }
  }

  function handleDroppedAudioPaths(paths: string[], dropSeconds: number) {
    const pendingImports = createPendingAudioImportsFromPaths(
      paths,
      dropSeconds,
    );
    useTransportStore.getState().addPendingAudioImports(pendingImports);

    setStatus(
      paths.length === 1
        ? `Importing ${libraryAssetFileName(paths[0])}...`
        : `Importing ${paths.length} audio files...`,
    );

    void startDroppedAudioPathImportJob({
      paths,
      pendingImports,
      dropSeconds,
    });
  }

  function rejectExternalDrop(kind: DroppedFileClassification["kind"]) {
    setStatus(
      kind === "mixed"
        ? t("transport.status.externalDropMixed")
        : t("transport.status.externalDropUnsupported"),
    );
  }

  function handleExternalTimelineDrop(
    classification: DroppedFileClassification,
    dropSeconds: number,
  ) {
    setExternalDropPreview(null);
    nativeDropKindRef.current = null;
    domExternalDropPreviewUntilRef.current = 0;
    lastNativeTimelineDropRef.current = null;

    if (
      classification.kind === "mixed" ||
      classification.kind === "unsupported"
    ) {
      rejectExternalDrop(classification.kind);
      return;
    }

    if (classification.kind === "package") {
      void runAction(
        async () => {
          const packagePath = (
            classification.packageFile as NativeDroppedFile | null
          )?.path?.trim();
          if (!packagePath) {
            rejectExternalDrop("unsupported");
            return;
          }

          await handleDroppedSongPackagePath(packagePath, dropSeconds);
        },
        { busy: true },
      );
      return;
    }

    handleDroppedAudioFiles(classification.audioFiles, dropSeconds);
  }

  function handleNativeExternalTimelineDrop(
    classification: NativeDroppedPathClassification,
    dropSeconds: number,
  ) {
    setExternalDropPreview(null);
    setCompactDragPreview(null);
    nativeExternalDropPathsRef.current = [];
    nativeDropKindRef.current = null;
    domExternalDropPreviewUntilRef.current = 0;
    lastNativeTimelineDropRef.current = null;
    nativeDropCoordinateModeRef.current = null;
    if (NATIVE_DND_DEBUG_ENABLED) {
      setNativeDropDebugCandidates([]);
    }

    if (
      classification.kind === "mixed" ||
      classification.kind === "unsupported"
    ) {
      rejectExternalDrop(classification.kind);
      return;
    }

    if (classification.kind === "package") {
      void runAction(
        async () => {
          await handleDroppedSongPackagePath(
            classification.packagePath,
            dropSeconds,
          );
        },
        { busy: true },
      );
      return;
    }

    handleDroppedAudioPaths(classification.audioPaths, dropSeconds);
  }

  function handleNativeFileDragOver(args: {
    paths?: string[];
    position: { x: number; y: number };
  }) {
    if (NATIVE_DND_DEBUG_ENABLED) {
      console.debug("[native-dnd] over", args);
    }

    if (args.paths?.length) {
      nativeExternalDropPathsRef.current = args.paths;
    }

    const paths = args.paths?.length
      ? args.paths
      : nativeExternalDropPathsRef.current;
    const kind = paths.length ? classifyDroppedPaths(paths).kind : "unknown";
    nativeDropKindRef.current = kind;

    // Compact-view preview branch. HTML5 dragover doesn't fire under
    // Tauri's native drop pipeline, so the strip and song columns rely
    // on this hook to know "something is being dragged over me". We
    // resolve which column the pointer is on, and for package drags we
    // emit a null regionId so the CompactView paints the strip-level
    // ghost instead of per-column placeholders.
    const compactHit = resolveCompactRegionAtPoint(
      args.position.x,
      args.position.y,
    );
    if (compactHit.hit) {
      // Decide what kind of preview to paint:
      //
      //   audio    → per-column dashed placeholders (one per file).
      //   package  → strip-level ghost column (.ltpkg lands at the end).
      //   unknown  → some Tauri builds don't send paths on dragover,
      //              only on drop. To still give immediate feedback we
      //              fall back to a ghost column when the pointer is
      //              NOT on a specific song column (i.e. over the
      //              action buttons / empty gutter — the natural
      //              landing zone for a .ltpkg). If the pointer is on
      //              a column we wait for the next event with paths
      //              before showing per-column placeholders, since
      //              showing them for what turns out to be a .txt
      //              would mislead.
      //   mixed/unsupported → never paint a preview; the drop will be
      //              rejected with a status toast.
      let isPackage: boolean;
      if (kind === "audio") {
        isPackage = false;
      } else if (kind === "package") {
        isPackage = true;
      } else if (kind === "unknown" && compactHit.regionId === null) {
        // Strip gutter / action buttons under the pointer + paths
        // unknown → assume package (the only thing that lands here).
        isPackage = true;
      } else {
        setCompactDragPreview((current) =>
          current === null ? current : null,
        );
        setExternalDropPreview(null);
        return;
      }
      const count = paths.length || 1;
      setCompactDragPreview({
        targetRegionId: isPackage ? null : compactHit.regionId,
        count,
        isPackage,
      });
      // Clear any lingering timeline preview so the two views don't
      // both light up while the pointer is over the compact strip.
      setExternalDropPreview(null);
      return;
    }
    setCompactDragPreview((current) => (current === null ? current : null));

    if (Date.now() < domExternalDropPreviewUntilRef.current) {
      setExternalDropPreview((current) => {
        if (!current) {
          return current;
        }

        lastNativeTimelineDropRef.current = {
          seconds: current.seconds,
          rawSeconds: current.rawSeconds ?? current.seconds,
          snappedSeconds: current.snappedSeconds ?? current.seconds,
          previewClientX: current.previewClientX ?? 0,
          snapApplied: current.snapApplied ?? false,
          coordinateMode: nativeDropCoordinateModeRef.current ?? "raw/dpr",
        };

        return {
          ...current,
          kind,
        };
      });
      return;
    }

    const hit = resolveTimelineDropFromNativePosition(args.position);
    if (NATIVE_DND_DEBUG_ENABLED) {
      console.debug("[native-dnd] over hit", hit);
    }
    if (!hit.isOverTimeline) {
      setExternalDropPreview(null);
      domExternalDropPreviewUntilRef.current = 0;
      lastNativeTimelineDropRef.current = null;
      return;
    }

    if (
      hit.rawSeconds != null &&
      hit.snappedSeconds != null &&
      hit.previewClientX != null &&
      hit.coordinateMode != null
    ) {
      lastNativeTimelineDropRef.current = {
        seconds: hit.dropSeconds,
        rawSeconds: hit.rawSeconds,
        snappedSeconds: hit.snappedSeconds,
        previewClientX: hit.previewClientX,
        snapApplied: hit.snapApplied,
        coordinateMode: hit.coordinateMode,
      };
    }

    setExternalDropPreview({
      kind,
      seconds: hit.dropSeconds,
      previewLeftPx: hit.previewLeftPx ?? undefined,
      previewClientX: hit.previewClientX ?? undefined,
      rawSeconds: hit.rawSeconds ?? undefined,
      snappedSeconds: hit.snappedSeconds ?? undefined,
      snapApplied: hit.snapApplied,
    });
  }

  function handleNativeFileDrop(args: {
    paths: string[];
    position: { x: number; y: number };
  }) {
    if (NATIVE_DND_DEBUG_ENABLED) {
      console.debug("[native-dnd] drop", args);
    }

    nativeExternalDropPathsRef.current = [];
    nativeDropKindRef.current = null;
    setCompactDragPreview(null);

    if (!args.paths.length) {
      domExternalDropPreviewUntilRef.current = 0;
      lastNativeTimelineDropRef.current = null;
      nativeDropCoordinateModeRef.current = null;
      setExternalDropPreview(null);
      if (NATIVE_DND_DEBUG_ENABLED) {
        setNativeDropDebugCandidates([]);
      }
      return;
    }

    // If the drop landed on the compact view, route through the
    // compact handlers instead of the timeline. Unknown / unsupported
    // / mixed kinds are rejected here so a .txt or a .ltpkg+audio mix
    // never reaches the importer.
    const compactHit = resolveCompactRegionAtPoint(
      args.position.x,
      args.position.y,
    );
    if (compactHit.hit) {
      const classification = classifyDroppedPaths(args.paths);
      if (classification.kind === "package") {
        void runAction(
          async () =>
            runCompactSongPackageImport(classification.packagePath),
          { busy: true },
        );
        return;
      }
      if (classification.kind === "audio" && compactHit.regionId) {
        // Route native paths straight through the same importer the
        // OS-File handler uses, but without round-tripping through a
        // synthetic File (which wouldn't carry the .path needed by
        // resolveNativeAudioImportPayloads under Tauri).
        const regionId = compactHit.regionId;
        const region = song?.regions.find((r) => r.id === regionId);
        if (!region) return;
        const dropSeconds = region.startSeconds;
        void runAction(async () => {
          const payloads = classification.audioPaths.map((path) => ({
            fileName: path.split(/[\\/]/).pop() ?? path,
            sourcePath: path,
          }));
          const importedAssets = await importAudioFilesFromPaths(payloads);
          mergeLibraryAssets(importedAssets);
          await refreshLibraryState({ preserveAssets: importedAssets });
          if (importedAssets.length === 0) return;
          // Auto-organise: drop the freshly imported assets into the
          // song's Library folder (creating it if needed).
          await assignAssetsToSongFolder(region.name, importedAssets);
          const snapshot = await createClipsWithAutoTracks(
            importedAssets.map((asset) => ({
              filePath: asset.filePath,
              timelineStartSeconds: dropSeconds,
            })),
          );
          applyPlaybackSnapshot(snapshot);
          setStatus(
            importedAssets.length === 1
              ? t("transport.status.clipAdded", {
                  name: importedAssets[0].fileName,
                })
              : t("transport.status.clipsAdded", {
                  count: importedAssets.length,
                }),
          );
        });
        return;
      }
      // mixed / unsupported / package-but-no-region (theoretically
      // impossible because the strip always has at least the action
      // buttons inside it) → reject with a status toast.
      setStatus(
        t("transport.status.unsupportedDrop", {
          defaultValue: "Tipo de archivo no admitido",
        }),
      );
      return;
    }

    const hit = resolveTimelineDropFromNativePosition(args.position);
    if (NATIVE_DND_DEBUG_ENABLED) {
      console.debug("[native-dnd] drop hit", hit);
    }
    if (
      !hit.isOverTimeline &&
      externalDropPreview === null &&
      lastNativeTimelineDropRef.current === null
    ) {
      lastNativeTimelineDropRef.current = null;
      nativeDropCoordinateModeRef.current = null;
      setExternalDropPreview(null);
      if (NATIVE_DND_DEBUG_ENABLED) {
        setNativeDropDebugCandidates([]);
      }
      return;
    }

    const dropSeconds =
      lastNativeTimelineDropRef.current?.seconds ??
      externalDropPreview?.seconds ??
      hit.dropSeconds;

    handleNativeExternalTimelineDrop(
      classifyDroppedPaths(args.paths),
      dropSeconds,
    );
  }

  function handleDomExternalDropPreviewChange(
    preview: ExternalDropPreview | null,
  ) {
    domExternalDropPreviewUntilRef.current =
      preview === null ? 0 : Date.now() + DOM_EXTERNAL_DROP_PREVIEW_TTL_MS;

    if (preview !== null) {
      lastNativeTimelineDropRef.current = {
        seconds: preview.seconds,
        rawSeconds: preview.rawSeconds ?? preview.seconds,
        snappedSeconds: preview.snappedSeconds ?? preview.seconds,
        previewClientX: preview.previewClientX ?? 0,
        snapApplied: preview.snapApplied ?? false,
        coordinateMode: nativeDropCoordinateModeRef.current ?? "raw/dpr",
      };
    }

    setExternalDropPreview(preview);
  }

  const audioBackendOptions = useMemo(
    () =>
      Array.from(
        new Set(
          audioDeviceDescriptors
            .map((device) => device.backend)
            // 'unknown' is a fallback for JUCE typenames Rust didn't recognise;
            // exposing it as a selectable backend would surface the same
            // devices under a misleading label. The Rust side logs the raw
            // typename so we can extend backend_from_str when new ones appear.
            .filter((backend) => backend !== "unknown"),
        ),
      ).sort((left, right) => left.localeCompare(right)),
    [audioDeviceDescriptors],
  );
  const selectedAudioBackend = appSettings.selectedAudioBackend ?? null;
  const audioDevicesForSelectedBackend = useMemo(
    () =>
      audioDeviceDescriptors.filter((device) =>
        isAudioDeviceVisibleForBackend(device, selectedAudioBackend),
      ),
    [audioDeviceDescriptors, selectedAudioBackend],
  );
  const selectedAudioOutputDevice = appSettings.selectedOutputDeviceId ?? "";
  const selectedAudioOutputDescriptor =
    audioDeviceDescriptors.find(
      (device) => device.stableId === appSettings.selectedOutputDeviceId,
    ) ??
    audioDeviceDescriptors.find(
      (device) =>
        device.backend === selectedAudioBackend &&
        device.name === appSettings.selectedOutputDevice,
    ) ??
    null;
  const previewAudioOutputDescriptor =
    selectedAudioOutputDescriptor ??
    audioDevicesForSelectedBackend.find((device) => device.isDefault) ??
    audioDevicesForSelectedBackend[0] ??
    null;
  const selectedMidiInputDevice = appSettings.selectedMidiDevice ?? "";
  const selectedLocale = appSettings.locale ?? "";
  const selectedOutputChannelCount = Math.max(
    1,
    Math.min(
      64,
      (previewAudioOutputDescriptor
        ? audioOutputChannelCounts[previewAudioOutputDescriptor.stableId]
        : undefined) ??
        audioOutputChannelCounts[appSettings.selectedOutputDevice ?? ""] ??
        (defaultAudioOutputDevice
          ? audioOutputChannelCounts[defaultAudioOutputDevice]
          : undefined) ??
        HARDWARE_OUTPUT_CHANNEL_COUNT,
    ),
  );
  selectedOutputChannelCountRef.current = selectedOutputChannelCount;
  audioDeviceDescriptorsRef.current = audioDeviceDescriptors;
  const effectiveEnabledOutputChannels = useMemo(
    () =>
      normalizeEnabledOutputChannelsForOutputCount(
        appSettings.enabledOutputChannels,
        selectedOutputChannelCount,
      ),
    [appSettings.enabledOutputChannels, selectedOutputChannelCount],
  );
  const enabledOutputChannelsDraftForDevice = useMemo(
    () =>
      filterOutputChannelsForOutputCount(
        enabledOutputChannelsDraft,
        selectedOutputChannelCount,
      ),
    [enabledOutputChannelsDraft, selectedOutputChannelCount],
  );
  const audioRoutingOptions = useMemo(
    () => buildAudioRoutingOptions(effectiveEnabledOutputChannels, t),
    [effectiveEnabledOutputChannels, t],
  );
  const enabledOutputChannelsDirty = useMemo(() => {
    if (
      effectiveEnabledOutputChannels.length !==
      enabledOutputChannelsDraftForDevice.length
    ) {
      return true;
    }
    for (let i = 0; i < effectiveEnabledOutputChannels.length; i += 1) {
      if (
        effectiveEnabledOutputChannels[i] !==
        enabledOutputChannelsDraftForDevice[i]
      ) {
        return true;
      }
    }
    return false;
  }, [effectiveEnabledOutputChannels, enabledOutputChannelsDraftForDevice]);
  const selectedAudioOutputDeviceMissing = Boolean(
    appSettings.selectedOutputDeviceId &&
    !audioDeviceDescriptors.some(
      (device) => device.stableId === appSettings.selectedOutputDeviceId,
    ),
  );
  const outputSampleRates =
    previewAudioOutputDescriptor?.supportedSampleRates ?? [];
  const outputSampleRateOptions = outputSampleRates.filter(
    (sampleRate, index, values) => values.indexOf(sampleRate) === index,
  );
  const autoOutputSampleRateLabel =
    previewAudioOutputDescriptor?.defaultSampleRate
      ? t("transport.settingsModal.sampleRateAutoWithDefault", {
          sampleRate: previewAudioOutputDescriptor.defaultSampleRate,
          defaultValue: "Auto - device default: {{sampleRate}} Hz",
        })
      : t("transport.settingsModal.sampleRateAuto", {
          defaultValue: "Auto - device default",
        });
  const outputBufferSizes =
    previewAudioOutputDescriptor?.supportedBufferSizes ?? [];
  const selectedMidiInputDeviceMissing = Boolean(
    appSettings.selectedMidiDevice &&
    !midiInputDevices.includes(appSettings.selectedMidiDevice),
  );
  const settingsTabs: Array<{ id: SettingsTab; label: string }> = [
    {
      id: "audio",
      label: t("transport.settingsModal.tabAudio", { defaultValue: "Audio" }),
    },
    {
      id: "metronome",
      label: t("transport.settingsModal.tabMetronome", {
        defaultValue: "Metronome",
      }),
    },
    {
      id: "general",
      label: t("transport.settingsModal.tabGeneral", {
        defaultValue: "General",
      }),
    },
    {
      id: "diagnostics",
      label: t("transport.settingsModal.tabDiagnostics", {
        defaultValue: "Diagnostics",
      }),
    },
    {
      id: "midi",
      label: t("transport.settingsModal.tabMidi", { defaultValue: "MIDI" }),
    },
    {
      id: "midiLearn",
      label: t("transport.settingsModal.tabMidiLearn", {
        defaultValue: "MIDI Learn",
      }),
    },
  ];

  return (
    <Profiler id="transport-panel" onRender={handlePanelRender}>
      <div
        className={`lt-daw-shell ${midiLearnMode !== null ? "is-midi-learn-active" : ""} ${isShellBusy ? "is-busy" : ""}`}
        ref={panelRef}
        onContextMenu={(event) => event.preventDefault()}
      >
        {isShellBusy ? (
          <div className="busy-overlay" aria-live="polite">
            <div className="busy-overlay-card">
              <div className="busy-overlay-heading">
                <span className="busy-overlay-spinner" aria-hidden="true" />
                <strong>{t("transport.shell.busyTitle")}</strong>
                {typeof busyFeedback?.percent === "number" ? (
                  <span className="busy-overlay-percent">
                    {Math.max(0, Math.min(100, Math.round(busyFeedback.percent)))}%
                  </span>
                ) : null}
              </div>
              <p>
                {busyFeedback?.message ?? t("transport.shell.busyDescription")}
              </p>
              {typeof busyFeedback?.percent === "number" ? (
                <div
                  className="busy-overlay-progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(busyFeedback.percent)}
                  aria-valuetext={busyFeedback.message}
                >
                  <span
                    style={{
                      width: `${Math.max(0, Math.min(100, busyFeedback.percent))}%`,
                    }}
                  />
                </div>
              ) : null}
              {busyFeedback?.detail ? (
                <small>{busyFeedback.detail}</small>
              ) : null}
            </div>
          </div>
        ) : null}

        {missingMidiDeviceWarning ? (
          <div className="lt-modal-backdrop">
            <section
              className="lt-settings-modal lt-settings-modal--compact"
              role="dialog"
              aria-modal="true"
              aria-labelledby="lt-missing-midi-warning-title"
              onClick={(event) => event.stopPropagation()}
            >
              <header className="lt-settings-modal-header">
                <div>
                  <span className="lt-settings-modal-eyebrow">
                    {t("transport.midiWarning.eyebrow")}
                  </span>
                  <h2 id="lt-missing-midi-warning-title">
                    {t("transport.midiWarning.title")}
                  </h2>
                  <p>{t("transport.midiWarning.description")}</p>
                  <p>
                    {t("transport.midiWarning.detail", {
                      name: missingMidiDeviceWarning,
                    })}
                  </p>
                </div>
              </header>
              <div className="lt-settings-modal-body">
                <div className="lt-inline-actions">
                  <button
                    type="button"
                    onClick={handleDismissMissingMidiDeviceWarning}
                  >
                    {t("transport.midiWarning.dismiss")}
                  </button>
                  <button
                    type="button"
                    className="is-primary"
                    onClick={handleHideMissingMidiDeviceWarning}
                  >
                    {t("transport.midiWarning.dontShowAgain")}
                  </button>
                </div>
              </div>
            </section>
          </div>
        ) : null}

        <TimelineTopbar
          openTopMenu={openTopMenu}
          menuBarRef={menuBarRef}
          canPersistProject={canPersistProject}
          isProjectEmpty={isProjectEmpty}
          tempoDraft={tempoDraft}
          timeSignatureDraft={timeSignatureDraft}
          tempoSourceLabel={tempoSourceLabel}
          displayedBpm={displayedBpm}
          displayedTimeSignature={displayedTimeSignature}
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
          onImportSong={handleImportSongClick}
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
          onToggleMetronome={() =>
            handleMetronomeEnabledChange(!appSettings.metronomeEnabled)
          }
          onTempoDraftChange={(next) => {
            tempoDraftDirtyRef.current = true;
            setTempoDraft(next);
          }}
          onTempoDraftFocus={() => {
            tempoDraftFocusedRef.current = true;
          }}
          onTapTempo={handleTapTempo}
          onTempoCommit={() => {
            tempoDraftFocusedRef.current = false;
            tempoDraftDirtyRef.current = false;
            const nextBpm = Number(tempoDraft);
            const tempoPositionSeconds = readoutPositionSeconds;
            const currentBpm = getEffectiveBpmAt(song, tempoPositionSeconds);
            const clampedBpm = Math.max(
              MIN_SESSION_BPM,
              Math.min(MAX_SESSION_BPM, nextBpm),
            );

            if (
              !song ||
              !Number.isFinite(clampedBpm) ||
              clampedBpm === currentBpm
            ) {
              setTempoDraft(formatBpmDraft(currentBpm));
              return;
            }

            void runAction(async () => {
              const tempoMarker = getEffectiveTempoMarkerAt(
                song,
                tempoPositionSeconds,
              );
              const nextSnapshot = tempoMarker
                ? await upsertSongTempoMarker(
                    tempoMarker.sourceStartSeconds ?? tempoMarker.startSeconds,
                    clampedBpm,
                  )
                : await updateSongTempo(clampedBpm);
              optimisticallyAppliedRevisionsRef.current.add(
                nextSnapshot.projectRevision,
              );
              await refreshSongView({ includeWaveforms: false, sync: true });
              applyPlaybackSnapshot(nextSnapshot);
              setStatus(
                t("transport.status.tempoUpdated", {
                  bpm: clampedBpm.toFixed(1),
                }),
              );
            });
          }}
          onTimeSignatureDraftChange={setTimeSignatureDraft}
          onTimeSignatureCommit={() => {
            const nextSignature = timeSignatureDraft.trim();
            const currentSignature = songBaseTimeSignature;

            if (!song || !nextSignature || nextSignature === currentSignature) {
              setTimeSignatureDraft(currentSignature);
              return;
            }

            void runAction(async () => {
              const positionSeconds = readoutPositionSeconds;
              const nextSnapshot =
                positionSeconds <= 0.0001
                  ? await updateSongTimeSignature(nextSignature)
                  : await upsertSongTimeSignatureMarker(
                      positionSeconds,
                      nextSignature,
                    );
              applyPlaybackSnapshot(nextSnapshot);
              setStatus(`Compas actualizado a ${nextSignature}`);
            });
          }}
          midiLearnMode={midiLearnMode}
          onMidiLearnTarget={handleMidiLearnTarget}
        />

        <div className={`lt-shell-body ${isShellBusy ? "is-hidden" : ""}`}>
          <SideNav
            activeSidebarTab={activeSidebarTab}
            isRemoteModalOpen={isRemoteModalOpen}
            isSettingsModalOpen={isSettingsModalOpen}
            onLibraryToggle={() => handleSidebarTabToggle("library")}
            onRemoteClick={handleRemoteButtonClick}
            onSettingsClick={handleSettingsButtonClick}
          />

          <div className="lt-workspace">
            <div className="lt-workspace-body">
              <LibraryPanel
                activeSidebarTab={activeSidebarTab}
                assets={visibleLibraryAssets}
                folders={libraryFolders}
                isLoading={isLibraryLoading}
                isImporting={isImportingLibrary}
                importProgress={libraryImportProgress}
                deletingFilePath={deletingLibraryFilePath}
                canImport={Boolean(playbackSongDir)}
                internalLibraryPointerDrag={internalLibraryPointerDrag}
                onLocateAsset={handleLocateMissingFile}
                onPointerDragStart={startInternalLibraryPointerDrag}
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
              {shouldShowEmptyState ? (
                <div className="lt-empty-state">
                  <div className="lt-empty-state-card">
                    <span className="lt-empty-state-eyebrow">
                      {t("transport.shell.emptyEyebrow")}
                    </span>
                    <h1>{t("transport.shell.emptyTitle")}</h1>
                    <p>{t("transport.shell.emptyDescription")}</p>
                    <div className="lt-empty-state-actions">
                      <button
                        type="button"
                        className="is-primary"
                        onClick={handleCreateSongClick}
                      >
                        {t("common.create")}
                      </button>
                      <button type="button" onClick={handleOpenProjectClick}>
                        {t("common.open")}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <section className="lt-main-stage">
                  <TimelineToolbar
                    snapEnabled={snapEnabled}
                    subdivisionPerBeat={timelineGrid.subdivisionPerBeat}
                    selectedRegion={selectedRegion}
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
                            trigger: translateJumpTrigger(
                              pendingMarkerJump.trigger,
                            ),
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
                    onSelectedRegionTransposeChange={
                      handleSelectedRegionTransposeChange
                    }
                    selectedRegionEffectiveBpm={selectedRegionEffectiveBpm}
                    onSelectedRegionWarpToggle={handleSelectedRegionWarpToggle}
                    onSelectedRegionMasterGainChange={
                      handleSelectedRegionMasterGainChange
                    }
                    onSelectedRegionMasterGainCommit={
                      handleSelectedRegionMasterGainCommit
                    }
                    viewMode={viewMode}
                    onToggleViewMode={toggleViewMode}
                    compactMixerFilterActiveSong={compactMixerFilterActiveSong}
                    onToggleCompactMixerFilterActiveSong={
                      toggleCompactMixerFilterActiveSong
                    }
                    compactMixerFilterAvailable={compactMixerFilterAvailable}
                    midiLearnMode={midiLearnMode}
                    onMidiLearnTarget={handleMidiLearnTarget}
                  />

                  {viewMode === "daw" ? (
                  <div
                    className="lt-timeline-shell"
                    ref={timelineShellRef}
                    style={{ position: "relative" }}
                  >
                    {NATIVE_DND_DEBUG_ENABLED &&
                    nativeDropDebugCandidates.length > 0 ? (
                      <div
                        aria-hidden="true"
                        style={{
                          position: "absolute",
                          inset: 0,
                          pointerEvents: "none",
                          zIndex: 30,
                          overflow: "hidden",
                        }}
                      >
                        {nativeDropDebugCandidates.map((candidate) => {
                          const shellBounds =
                            timelineShellRef.current?.getBoundingClientRect();
                          if (!shellBounds) {
                            return null;
                          }

                          const left = candidate.clientX - shellBounds.left;
                          const color =
                            nativeDropCoordinateModeRef.current ===
                            candidate.label
                              ? "#ff5d5d"
                              : candidate.isOverTimeline
                                ? "#19c37d"
                                : "#8a8f98";

                          return (
                            <div
                              key={candidate.label}
                              style={{
                                position: "absolute",
                                left,
                                top: 0,
                                bottom: 0,
                                width: 0,
                                borderLeft: `1px dashed ${color}`,
                              }}
                            >
                              <div
                                style={{
                                  position: "absolute",
                                  top: 6,
                                  left: 4,
                                  padding: "2px 6px",
                                  borderRadius: 999,
                                  background: "rgba(12, 18, 28, 0.85)",
                                  color,
                                  fontSize: 11,
                                  lineHeight: 1.2,
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {`${candidate.label} score=${candidate.score.toFixed(0)} raw\u0394=${
                                  candidate.rawDeltaPx?.toFixed(1) ?? "n/a"
                                } snap\u0394=${candidate.snapDeltaPx?.toFixed(1) ?? "n/a"} raw=${
                                  candidate.rawSeconds?.toFixed(2) ?? "n/a"
                                } snap=${candidate.snappedSeconds?.toFixed(2) ?? "n/a"} drop=${
                                  candidate.dropSeconds?.toFixed(2) ?? "n/a"
                                } snap=${candidate.snapApplied ? "on" : "off"}`}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                    <div
                      className="lt-timeline-scroll-viewport"
                      ref={timelineScrollViewportRef}
                      onDoubleClick={handleTimelineViewportDoubleClick}
                    >
                      <div className="lt-timeline-main-grid">
                        <TrackHeadersPane
                          song={song}
                          visibleTracks={visibleTracks}
                          selectedTrackIds={selectedTrackIds}
                          trackHeight={trackHeight}
                          collapsedFolders={collapsedFolders}
                          previewTrackDensityClass={previewTrackDensityClass}
                          libraryPreviewRows={libraryPreviewRows}
                          onHeadersWheel={handleTrackHeadersWheel}
                          getTrackChildCount={(trackId) =>
                            song ? trackChildrenCount(song, trackId) : 0
                          }
                          onSelectTrack={handleTrackHeaderSelect}
                          onOpenContextMenu={handleTrackHeaderContextMenu}
                          onEmptyAreaContextMenu={
                            handleTrackHeadersEmptyAreaContextMenu
                          }
                          onStartTrackDrag={handleTrackHeaderDragStart}
                          onToggleFolder={handleTrackHeaderFolderToggle}
                          onToggleMute={handleTrackHeaderMuteToggle}
                          onToggleSolo={handleTrackHeaderSoloToggle}
                          onToggleTranspose={handleTrackHeaderTransposeToggle}
                          onVolumeChange={handleTrackHeaderVolumeChange}
                          onCommitVolume={handleTrackHeaderVolumeCommit}
                          onPanChange={handleTrackHeaderPanChange}
                          onCommitPan={handleTrackHeaderPanCommit}
                          audioRoutingOptions={audioRoutingOptions}
                          onAudioToChange={handleTrackAudioToChange}
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
                          selectedClipIds={selectedClipIds}
                          selectedRegionId={selectedRegionId}
                          onSelectRegion={(regionId) => {
                            setSelectedRegionId(regionId);
                            setSelectedTimelineRange(null);
                          }}
                          selectedSectionId={selectedSectionId}
                          pendingMarkerJump={pendingMarkerJump}
                          activeVamp={activeVamp}
                          midiLearnMode={midiLearnMode}
                          onMidiLearnTarget={handleMidiLearnTarget}
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
                          externalDropPreview={externalDropPreview}
                          normalizePositionSeconds={(
                            positionSeconds,
                            options,
                          ) =>
                            normalizeTimelineSeekSeconds(
                              positionSeconds,
                              workspaceDurationSeconds,
                              { allowSnap: options?.allowSnap ?? true },
                            )
                          }
                          resolveLibraryGhostLeft={resolveLibraryGhostLeft}
                          clipDragSnapIndicatorSeconds={
                            clipDragSnapIndicatorSeconds
                          }
                          onSeekIntent={prewarmTimelinePosition}
                          onRulerMouseDown={(event) => {
                            if (
                              !song ||
                              event.button !== 0 ||
                              !rulerTrackRef.current
                            ) {
                              return;
                            }

                            event.preventDefault();
                            const seekStartSeconds = snappedRulerSeconds(
                              event,
                              workspaceDurationSeconds,
                            );
                            prewarmTimelinePosition(seekStartSeconds);
                            const startSeconds = snappedRulerSeconds(
                              event,
                              workspaceDurationSeconds,
                            );
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
                              const currentSeconds =
                                snappedRulerSecondsAtClientX(
                                  clientX,
                                  workspaceDurationSeconds,
                                );
                              setSelectedTimelineRange({
                                startSeconds: Math.min(
                                  startSeconds,
                                  currentSeconds,
                                ),
                                endSeconds: Math.max(
                                  startSeconds,
                                  currentSeconds,
                                ),
                              });
                            };

                            const tickRangeAutoScroll = () => {
                              if (!autoScrollVelocity) {
                                autoScrollFrameId = null;
                                return;
                              }

                              updateCameraX(
                                cameraXRef.current + autoScrollVelocity,
                                {
                                  commitToStore: false,
                                },
                              );
                              updateRangeSelection(latestClientX);
                              autoScrollFrameId =
                                window.requestAnimationFrame(
                                  tickRangeAutoScroll,
                                );
                            };

                            const updateRangeAutoScroll = (clientX: number) => {
                              const bounds =
                                rulerTrackRef.current?.getBoundingClientRect();
                              if (!bounds) {
                                stopRangeAutoScroll();
                                return;
                              }

                              const distanceToLeft = clientX - bounds.left;
                              const distanceToRight = bounds.right - clientX;
                              if (
                                distanceToLeft < LIBRARY_DRAG_EDGE_BUFFER_PX
                              ) {
                                autoScrollVelocity =
                                  -resolveLibraryAutoScrollVelocity(
                                    distanceToLeft,
                                  );
                              } else if (
                                distanceToRight < LIBRARY_DRAG_EDGE_BUFFER_PX
                              ) {
                                autoScrollVelocity =
                                  resolveLibraryAutoScrollVelocity(
                                    distanceToRight,
                                  );
                              } else {
                                autoScrollVelocity = 0;
                              }

                              if (!autoScrollVelocity) {
                                stopRangeAutoScroll();
                                return;
                              }

                              if (autoScrollFrameId === null) {
                                autoScrollFrameId =
                                  window.requestAnimationFrame(
                                    tickRangeAutoScroll,
                                  );
                              }
                            };

                            const onMouseMove = (windowEvent: MouseEvent) => {
                              const exceededThreshold =
                                Math.abs(windowEvent.clientX - startClientX) >
                                DRAG_THRESHOLD_PX;
                              if (!hasMoved && !exceededThreshold) {
                                return;
                              }

                              hasMoved = true;
                              latestClientX = windowEvent.clientX;
                              prewarmTimelinePosition(
                                snappedRulerSecondsAtClientX(
                                  windowEvent.clientX,
                                  workspaceDurationSeconds,
                                ),
                              );
                              updateRangeSelection(windowEvent.clientX);
                              updateRangeAutoScroll(windowEvent.clientX);
                            };

                            const onMouseUp = (windowEvent: MouseEvent) => {
                              if (windowEvent.button !== 0) {
                                return;
                              }

                              window.removeEventListener(
                                "mousemove",
                                onMouseMove,
                              );
                              window.removeEventListener("mouseup", onMouseUp);
                              stopRangeAutoScroll();

                              if (!hasMoved) {
                                setSelectedTimelineRange(null);
                                void runAction(async () => {
                                  await performSeek(seekStartSeconds);
                                });
                                return;
                              }

                              const endSeconds = snappedRulerSeconds(
                                windowEvent,
                                workspaceDurationSeconds,
                              );
                              const normalizedStartSeconds = Math.min(
                                startSeconds,
                                endSeconds,
                              );
                              const normalizedEndSeconds = Math.max(
                                startSeconds,
                                endSeconds,
                              );
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

                            const positionSeconds = snappedRulerSeconds(
                              event,
                              workspaceDurationSeconds,
                            );
                            clearSelection();
                            setSelectedRegionId(null);
                            const activeTimelineRange =
                              selectedTimelineRange &&
                              positionSeconds >=
                                selectedTimelineRange.startSeconds &&
                              positionSeconds <=
                                selectedTimelineRange.endSeconds
                                ? selectedTimelineRange
                                : null;
                            if (!activeTimelineRange) {
                              setSelectedTimelineRange(null);
                            }
                            openMenu(
                              event,
                              activeTimelineRange
                                ? t("transport.shell.contextSelectionTitle", {
                                    start: formatClock(
                                      activeTimelineRange.startSeconds,
                                    ),
                                    end: formatClock(
                                      activeTimelineRange.endSeconds,
                                    ),
                                  })
                                : t("transport.shell.contextTimelineTitle", {
                                    time: formatClock(positionSeconds),
                                  }),
                              rulerContextMenu(
                                positionSeconds,
                                activeTimelineRange,
                              ),
                            );
                          }}
                          onMarkerPrimaryAction={(sectionId) => {
                            const section = song?.sectionMarkers.find(
                              (candidate) => candidate.id === sectionId,
                            );
                            if (!section) {
                              return;
                            }

                            void runAction(async () => {
                              await handleMarkerPrimaryAction(section);
                            });
                          }}
                          onMarkerContextMenu={(event, sectionId) => {
                            const section = song?.sectionMarkers.find(
                              (candidate) => candidate.id === sectionId,
                            );
                            if (!section) {
                              return;
                            }

                            setSelectedRegionId(null);
                            selectSection(section.id);
                            openMenu(
                              event,
                              section.name,
                              sectionContextMenu(section),
                            );
                          }}
                          onTempoMarkerContextMenu={(event, markerId) => {
                            const marker = song?.tempoMarkers.find(
                              (candidate) => candidate.id === markerId,
                            );
                            if (!marker) {
                              return;
                            }

                            clearSelection();
                            setSelectedTimelineRange(null);
                            setSelectedRegionId(null);
                            openMenu(
                              event,
                              `${t("timelineTopbar.tempoReadout")} ${marker.bpm.toFixed(2)} BPM`,
                              tempoMarkerContextMenu(marker),
                            );
                          }}
                          onTimeSignatureMarkerContextMenu={(
                            event,
                            markerId,
                          ) => {
                            const marker = song?.timeSignatureMarkers.find(
                              (candidate) => candidate.id === markerId,
                            );
                            if (!marker) {
                              return;
                            }

                            clearSelection();
                            setSelectedTimelineRange(null);
                            setSelectedRegionId(null);
                            openMenu(
                              event,
                              `Compas ${marker.signature}`,
                              timeSignatureMarkerContextMenu(marker),
                            );
                          }}
                          onRegionContextMenu={(event, regionId) => {
                            const region = song?.regions.find(
                              (candidate) => candidate.id === regionId,
                            );
                            if (!region) {
                              return;
                            }

                            clearSelection();
                            setSelectedTimelineRange(null);
                            setSelectedRegionId(region.id);
                            openMenu(
                              event,
                              region.name,
                              songRegionContextMenu(region),
                            );
                          }}
                          onRegionResizeCommit={(
                            regionId,
                            startSeconds,
                            endSeconds,
                          ) => {
                            const region = song?.regions.find(
                              (candidate) => candidate.id === regionId,
                            );
                            if (!region) return;
                            // Commit through the same code path as the inline
                            // rename modal so the snapshot/event flow stays
                            // identical to other region edits.
                            void runAction(async () => {
                              const nextSnapshot = await updateSongRegion(
                                regionId,
                                region.name,
                                startSeconds,
                                endSeconds,
                              );
                              applyPlaybackSnapshot(nextSnapshot);
                            });
                          }}
                          onRegionMoveCommit={(regionId, deltaSeconds) => {
                            // Translates the entire song — region + clips +
                            // every marker inside it — by `deltaSeconds`.
                            // Goes through a dedicated backend command so
                            // the move is one atomic snapshot / one undo
                            // entry, instead of N independent region/
                            // marker/clip updates.
                            void runAction(async () => {
                              const nextSnapshot = await moveSongRegion(
                                regionId,
                                deltaSeconds,
                              );
                              applyPlaybackSnapshot(nextSnapshot);
                            });
                          }}
                          snapEnabled={snapEnabled}
                          canNativeZoom={Boolean(song)}
                          navigationScheme={appSettings.timelineNavigationScheme}
                          onNativeCameraXPreview={(nextCameraX) =>
                            updateCameraX(nextCameraX, {
                              commitToStore: false,
                              debounceStoreCommit: false,
                            })
                          }
                          onNativeCameraXCommit={commitCameraXToStore}
                          onNativeZoomPreview={(
                            nextZoomLevel,
                            anchorViewportX,
                          ) =>
                            previewZoom(nextZoomLevel, anchorViewportX, {
                              scheduleCommit: false,
                            })
                          }
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
                          onTrackLaneMouseDown={handleTrackLaneMouseDown}
                          onTrackLaneContextMenu={handleTrackLaneContextMenu}
                          onResolveTimelineDropFromClientPoint={
                            resolveTimelineDropFromClientPoint
                          }
                          nativeDropKindRef={nativeDropKindRef}
                          onExternalDropPreviewChange={
                            handleDomExternalDropPreviewChange
                          }
                          onExternalDrop={handleExternalTimelineDrop}
                        />
                      </div>
                    </div>
                    <div
                      className="lt-timeline-bottom-grid"
                      aria-hidden={!song}
                    >
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
                            style={{
                              width: laneViewportWidth + maxTimelineCameraX,
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  ) : null}

                  {/* Compact view replaces the DAW timeline when the user
                      toggles view mode (toolbar button or Tab key). The
                      backend snapshot powering both views is the same; the
                      two components are pure projections of song state. */}
                  {viewMode === "compact" && song ? (
                    <CompactView
                      regions={song.regions}
                      tracks={song.tracks}
                      playheadSeconds={
                        snapshotRef.current?.positionSeconds ?? 0
                      }
                      clipsByRegion={clipsByRegion}
                      audioRoutingOptions={audioRoutingOptions}
                      mixerHandlers={{
                        onToggleMute: handleTrackHeaderMuteToggle,
                        onToggleSolo: handleTrackHeaderSoloToggle,
                        onToggleTranspose: handleTrackHeaderTransposeToggle,
                        onVolumeChange: handleTrackHeaderVolumeChange,
                        onCommitVolume: handleTrackHeaderVolumeCommit,
                        onPanChange: handleTrackHeaderPanChange,
                        onCommitPan: handleTrackHeaderPanCommit,
                        onAudioToChange: handleTrackAudioToChange,
                      }}
                      onTrackContextMenu={handleTrackHeaderContextMenu}
                      onMasterGainChange={handleCompactMasterGainChange}
                      onMasterGainCommit={handleCompactMasterGainCommit}
                      onDropOsFilesIntoSong={handleCompactDropOsFilesIntoSong}
                      onDropLibraryAssetsIntoSong={
                        handleCompactDropLibraryAssetsIntoSong
                      }
                      onMoveClipToTrack={handleCompactMoveClipToTrack}
                      onDeleteClip={handleCompactDeleteClip}
                      onPlaySong={handleCompactPlaySong}
                      onRenameSong={handleCompactRenameSong}
                      onSetSongBpm={handleCompactSetSongBpm}
                      onDeleteSong={handleCompactDeleteSong}
                      onExportSong={handleCompactExportSong}
                      bpmByRegion={bpmByRegion}
                      onSnapshotApplied={applyPlaybackSnapshot}
                      onImportSongPackageFromDialog={
                        handleCompactImportSongPackageFromDialog
                      }
                      onImportSongPackageFromOsFile={
                        handleCompactImportSongPackageFromOsFile
                      }
                      dragPreview={compactDragPreview}
                      selectedTrackIds={selectedTrackIds}
                      onTrackSelect={handleTrackHeaderSelect}
                      onTrackDragStart={handleTrackHeaderDragStart}
                      selectedRegionId={selectedRegionId}
                      onSelectRegion={setSelectedRegionId}
                      compactMixerFilterActiveSong={
                        compactMixerFilterActiveSong
                      }
                    />
                  ) : null}
                </section>
              )}
            </div>

            <SettingsPanel
              isOpen={isSettingsModalOpen}
              onClose={() => setIsSettingsModalOpen(false)}
              activeTab={activeSettingsTab}
              onTabChange={setActiveSettingsTab}
              settingsTabs={settingsTabs}
              isLoading={isSettingsLoading}
              isSaving={isSettingsSaving}
              appSettings={appSettings}
              audioBackendOptions={audioBackendOptions}
              audioDevicesForSelectedBackend={audioDevicesForSelectedBackend}
              defaultAudioOutputDevice={defaultAudioOutputDevice}
              selectedAudioOutputDevice={selectedAudioOutputDevice}
              selectedAudioOutputDeviceMissing={
                selectedAudioOutputDeviceMissing
              }
              selectedOutputChannelCount={selectedOutputChannelCount}
              outputSampleRateOptions={outputSampleRateOptions}
              autoOutputSampleRateLabel={autoOutputSampleRateLabel}
              outputBufferSizes={outputBufferSizes}
              audioRoutingOptions={audioRoutingOptions}
              onAudioBackendChange={handleAudioBackendChange}
              onAudioOutputDeviceChange={handleAudioOutputDeviceChange}
              onRefreshAudioDevices={handleRefreshAudioDevices}
              onOutputSampleRateChange={handleOutputSampleRateChange}
              onOutputBufferSizeChange={handleOutputBufferSizeChange}
              onEnabledOutputChannelChange={handleEnabledOutputChannelChange}
              enabledOutputChannelsDraft={enabledOutputChannelsDraftForDevice}
              enabledOutputChannelsDirty={enabledOutputChannelsDirty}
              onCommitEnabledOutputChannels={handleCommitEnabledOutputChannels}
              onDiscardEnabledOutputChannels={
                handleDiscardEnabledOutputChannels
              }
              onSelectAllOutputChannels={handleSelectAllOutputChannels}
              onClearOutputChannels={handleClearOutputChannels}
              onAudioSafeModeChange={handleAudioSafeModeChange}
              metronomeVolumeDraft={metronomeVolumeDraft}
              onMetronomeEnabledChange={handleMetronomeEnabledChange}
              onMetronomeOutputChange={handleMetronomeOutputChange}
              onMetronomeVolumeDraftChange={handleMetronomeVolumeDraftChange}
              onCommitMetronomeVolume={commitMetronomeVolumeDraft}
              onMetronomeSoundChange={handleMetronomeSoundChange}
              midiInputDevices={midiInputDevices}
              isMidiInputRefreshing={isMidiInputRefreshing}
              selectedMidiInputDevice={selectedMidiInputDevice}
              selectedMidiInputDeviceMissing={selectedMidiInputDeviceMissing}
              onMidiInputDeviceChange={handleMidiInputDeviceChange}
              onRefreshMidiInputDevices={handleRefreshMidiInputDevices}
              selectedLocale={selectedLocale}
              onLocaleChange={handleLocaleChange}
              onTimelineNavigationSchemeChange={
                handleTimelineNavigationSchemeChange
              }
              midiLearnMode={midiLearnMode}
              midiLearnFeedback={midiLearnFeedback}
              midiLearnFeedbackCommand={midiLearnFeedbackCommand}
              midiLearnView={midiLearnView}
              onMidiLearnViewChange={setMidiLearnView}
              midiLearnMarkerRows={midiLearnMarkerRows}
              midiLearnSongRows={midiLearnSongRows}
              visibleMidiLearnRows={visibleMidiLearnRows}
              activeMidiLearnCommand={activeMidiLearnCommand}
              onMidiLearnToggle={handleMidiLearnToggle}
              onResetMidiMappings={handleResetMidiMappings}
              onMidiLearnCommandRelearn={handleMidiLearnCommandRelearn}
              onDynamicMidiLearnJump={handleDynamicMidiLearnJump}
              onMidiLearnTarget={handleMidiLearnTarget}
            />

            <RemotePanel
              isOpen={isRemoteModalOpen}
              onClose={() => setIsRemoteModalOpen(false)}
              remoteServerInfo={remoteServerInfo}
            />

            <ExportSongModal
              target={exportSongTarget}
              onCancel={() => setExportSongTarget(null)}
              onConfirm={handleConfirmExportSong}
            />

            <TimelineContextMenus
              contextMenu={contextMenu}
              onDismiss={() => setContextMenu(null)}
            />

            {colorPickerPopover ? (
              <TimelineColorPopover
                x={colorPickerPopover.x}
                y={colorPickerPopover.y}
                title={colorPickerPopover.title}
                initialColor={colorPickerPopover.initialColor}
                onApply={colorPickerPopover.onApply}
                onDismiss={() => setColorPickerPopover(null)}
              />
            ) : null}

            {missingFilePaths.length > 0 ? (
              <button
                type="button"
                className="lt-missing-files-indicator"
                onClick={() => setActiveSidebarTab("library")}
              >
                <span className="material-symbols-outlined" aria-hidden="true">
                  warning
                </span>
                Faltan archivos multimedia
              </button>
            ) : null}

            {pitchPrepareUiState.active || status !== "" ? (
              <div className="lt-status-overlay" aria-live="polite">
                <span>
                  {pitchPrepareUiState.active
                    ? `${pitchPrepareUiState.message}${
                        pitchPrepareUiState.error
                          ? `: ${pitchPrepareUiState.error}`
                          : ""
                      }`
                    : status}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </Profiler>
  );
}
