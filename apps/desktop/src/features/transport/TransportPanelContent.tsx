import {
  Profiler,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import {
  buildSongTempoRegions,
  getSongBaseBpm,
  getSongBaseTimeSignature,
  getSongTempoRegionAtPosition,
  type ClipSummary,
  type JumpTriggerLabel,
  type LibraryAssetSummary,
  type LibraryImportProgressEvent,
  type MidiBinding,
  type RemoteServerInfo,
  type SectionMarkerSummary,
  type SongView,
  type TrackSummary,
  type TransportSnapshot,
  type WaveformSummaryDto,
} from "@libretracks/shared/models";
import {
  assignSectionMarkerDigit,
  cancelMarkerJump,
  createClipsBatch,
  createTrack,
  getLibraryAssets,
  getLibraryWaveformSummaries,
  getSongView,
  getWaveformSummaries,
  importAudioFilesFromBytes,
  importAudioFilesFromPaths,
  importSongPackage,
  isTauriApp,
  listenToWaveformReady,
  pauseTransport,
  playTransport,
  prewarmTimelineSeek,
  reportUiRenderMetric,
  resolveMissingFile,
  seekTransport,
  stopTransport,
  updateSongRegionTranspose,
  updateSongTempo,
  updateSongTimeSignature,
  upsertSongTimeSignatureMarker,
  formatTransposeSemitones,
} from "./desktopApi";
import { getSystemLanguage } from "../../shared/i18n";
import { TimelineCanvasPane } from "./TimelineCanvasPane";
import { TimelineToolbar } from "./TimelineToolbar";
import { TimelineTopbar } from "./TimelineTopbar";
import { TrackHeadersPane } from "./TrackHeadersPane";
import { useTimelineGrid } from "./useTimelineGrid";
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
  useTransportStore,
  type OptimisticMixState,
} from "./store";
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
import { RemotePanel } from "./panels/RemotePanel";
import { LibraryPanel } from "./panels/LibraryPanel";
import { useAudioMeters } from "./hooks/useAudioMeters";
import { useLibraryActions } from "./hooks/useLibraryActions";
import { useMixController } from "./hooks/useMixController";
import { useSettingsController } from "./hooks/useSettingsController";
import { useSongStructureActions } from "./hooks/useSongStructureActions";
import { useSettingsPanelHandlers } from "./hooks/useSettingsPanelHandlers";
import { useArrangementActions } from "./hooks/useArrangementActions";
import { useLibraryDragGeometry } from "./hooks/useLibraryDragGeometry";
import { useLibraryAudioImport } from "./hooks/useLibraryAudioImport";
import { useLibraryDropEvents } from "./hooks/useLibraryDropEvents";
import { useCameraControls } from "./hooks/useCameraControls";
import { useTrackDragActions } from "./hooks/useTrackDragActions";
import { useMidiActions } from "./hooks/useMidiActions";
import { useTransportLifecycle } from "./hooks/useTransportLifecycle";
import { useTransportPolling } from "./hooks/useTransportPolling";
import { useProjectActions } from "./hooks/useProjectActions";
import { TimelineContextMenus } from "./timeline/TimelineContextMenus";
import { useTimelineActions } from "./timeline/useTimelineActions";
import { useTimelineKeyboardShortcuts } from "./timeline/TimelineKeyboardShortcuts";
import {
  buildTimelineDropPreviewGeometry,
  classifyDroppedPaths,
  type DroppedFileClassification,
  type ExternalDropKind,
  type ExternalDropPreview,
  type NativeDroppedPathClassification,
} from "./dragDrop";
import type {
  ClipDragState,
  ContextMenuAction,
  ContextMenuState,
  InternalLibraryPointerDrag,
  LibraryAssetDragPayload,
  LibraryClipPreviewState,
  LibraryDragAutoScrollState,
  LibraryDragHoverState,
  LibraryDropLayout,
  MidiLearnCommand,
  MidiLearnCommandRow,
  MidiLearnFeedback,
  NativeClientPointCandidate,
  NativeDropCandidateDebug,
  NativeDropCoordinateMode,
  NativeDropDebugRect,
  NativeDroppedFile,
  PlayheadDragState,
  SidebarTab,
  TimelineDropGeometry,
  TimelinePanState,
  TimelineRangeSelection,
  TrackDragState,
  TrackDropState,
  TransportAnchorMeta,
} from "./types";
import {
  DEFAULT_TIMELINE_VIEWPORT_WIDTH,
  DRAG_THRESHOLD_PX,
  DOM_EXTERNAL_DROP_PREVIEW_TTL_MS,
  HEADER_WIDTH,
  LIBRARY_DRAG_EDGE_BUFFER_PX,
  LIBRARY_DRAG_MAX_SCROLL_SPEED_PX,
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
  buildMemoizedClipsByTrack,
  buildVisibleTracks,
  clamp,
  describeNativeDropElement,
  findClip,
  findSection,
  formatClock,
  formatMusicalPosition,
  getNativeCandidatePointerDelta,
  humanizeLibraryTrackName,
  isTimelineZoomTarget,
  isTrackDescendant,
  isTrackInfoScrollTarget,
  libraryAssetFileName,
  mergeOptimisticClipsByTrack,
  nativeClientPointCandidates,
  resolveNativeAudioImportPayloads,
  rulerClientXToSeconds,
  rulerPointerToSeconds,
  selectNativeDropCandidate,
  toClientPointFromNativePosition,
  toNativeDropDebugRect,
  trackChildrenCount,
} from "./helpers";

// Backward-compatible re-exports (TransportPanelContent.test.ts imports these)
export {
  isAudioDeviceVisibleForBackend,
  selectNativeDropCandidate,
  getNativeCandidatePointerDelta,
} from "./helpers";
export type { NativeDropCandidateDebug, NativeDropCoordinateMode } from "./types";


export function TransportPanelContent() {
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
  const [status, setStatus] = useState(() =>
    t("transport.status.loadingSession"),
  );
  const [isBusy, setIsBusy] = useState(false);
  const [midiLearnFeedback, setMidiLearnFeedback] =
    useState<MidiLearnFeedback | null>(null);
  const [midiLearnView, setMidiLearnView] = useState<
    "core" | "markers" | "songs"
  >("core");
  const [tempoDraft, setTempoDraft] = useState("120");
  const [timeSignatureDraft, setTimeSignatureDraft] = useState("4/4");
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
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
  const [externalDropPreview, setExternalDropPreview] =
    useState<ExternalDropPreview | null>(null);
  const [nativeDropDebugCandidates, setNativeDropDebugCandidates] = useState<
    NativeDropCandidateDebug[]
  >([]);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  const selectedRegion = useMemo(
    () =>
      song?.regions.find((region) => region.id === selectedRegionId) ?? null,
    [selectedRegionId, song?.regions],
  );
  const [selectedTimelineRange, setSelectedTimelineRange] =
    useState<TimelineRangeSelection | null>(null);
  const [missingMidiDeviceWarning, setMissingMidiDeviceWarning] = useState<
    string | null
  >(null);
  const [timelineViewportWidth, setTimelineViewportWidth] = useState(
    DEFAULT_TIMELINE_VIEWPORT_WIDTH,
  );
  const hasShownMissingMidiDeviceWarningRef = useRef(false);
  const formatErrorStatus = useCallback(
    (error: unknown) => {
      return t("transport.status.error", { message: String(error) });
    },
    [t],
  );

  const runAction = useCallback(
    async (work: () => Promise<void>, options?: { busy?: boolean }) => {
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
    },
    [formatErrorStatus],
  );

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
    appSettings,
    setAppSettings,
    metronomeVolumeDraft,
    setMetronomeVolumeDraft,
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
    remoteServerInfo,
    appSettingsRef,
    persistAudioSettings,
    audioBackendOptions,
    selectedAudioBackend,
    audioDevicesForSelectedBackend,
    selectedAudioOutputDevice,
    selectedAudioOutputDescriptor,
    previewAudioOutputDescriptor,
    selectedMidiInputDevice,
    selectedLocale,
    audioRoutingOptions,
    selectedOutputChannelCount,
    selectedAudioOutputDeviceMissing,
    outputSampleRates,
    outputSampleRateOptions,
    autoOutputSampleRateLabel,
    outputBufferSizes,
    selectedMidiInputDeviceMissing,
    settingsTabs,
  } = useSettingsController({ i18n, t, runAction, setStatus, formatErrorStatus });

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

  const handleNativeFileDragOverRef = useRef<
    (args: { paths?: string[]; position: { x: number; y: number } }) => void
  >(() => {});
  const handleNativeFileDropRef = useRef<
    (args: { paths: string[]; position: { x: number; y: number } }) => void
  >(() => {});

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

        if (payload.type === "over") {
          const overPayload = payload as typeof payload & { paths?: string[] };
          handleNativeFileDragOverRef.current({
            paths: overPayload.paths,
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
  const tracksByIdRef = useRef<Record<string, TrackSummary>>({});
  const clipDragRef = useRef<ClipDragState>(null);
  const playheadDragRef = useRef<PlayheadDragState>(null);
  const trackDragRef = useRef<TrackDragState>(null);
  const timelinePanRef = useRef<TimelinePanState>(null);
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
    handleImportLibraryAssetsClick,
    handleDeleteLibraryAssets,
    handleCreateLibraryFolder,
    handleMoveLibraryAssets,
    handleRenameLibraryFolder,
    handleDeleteLibraryFolder,
  } = useLibraryActions({
    playbackSongDir,
    runAction,
    t,
    setStatus,
    setLibraryClipPreview,
  });
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

  const refreshSongView = useCallback(async () => {
    const nextSong = await getSongView();
    setSong(nextSong);
    return nextSong;
  }, []);

  const applyPlaybackSnapshot = useCallback(
    (nextSnapshot: TransportSnapshot | null) => {
      snapshotRef.current = nextSnapshot;
      useTransportStore.getState().setPlaybackState(nextSnapshot);
    },
    [],
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

  const {
    optimisticClipOperations,
    setOptimisticClipOperations,
    clipMoveLiveStatesRef,
    trackMixRequestIdsRef,
    trackMixLiveStatesRef,
    clipPreviewSecondsRef,
    getTrackOptimisticMix,
    setTrackOptimisticMix,
    patchTrackOptimisticMix,
    clearTrackOptimisticMixKeys,
    startOptimisticClipOperation,
    completeOptimisticClipOperation,
    discardOptimisticClipOperation,
    resolveTrackMix,
    nextTrackMixRequestId,
    persistTrackMix,
    flushTrackMixLiveUpdates,
    queueTrackMixLiveUpdate,
    flushClipMoveLiveUpdates,
    queueClipMoveLiveUpdate,
    waitForClipMoveLiveIdle,
  } = useMixController({
    songRef,
    clipDragRef,
    applyPlaybackSnapshot,
    formatErrorStatus,
    setStatus,
  });

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
  const songBaseBpm = getSongBaseBpm(song);
  const songBaseTimeSignature = getSongBaseTimeSignature(song);

  const {
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
  } = useCameraControls({
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
  });

  const {
    clearTrackDragVisuals,
    applyTrackDragVisuals,
    handleTrackDrop,
  } = useTrackDragActions({
    timelineShellRef,
    draggedTrackRowRef,
    draggedTrackRowsRef,
    draggedTrackHeadersRef,
    droppedTrackRowRef,
    trackDropStateRef,
    clipDragRef,
    trackDragRef,
    clipPreviewSecondsRef,
    suppressTrackClickRef,
    timelinePanRef,
    livePixelsPerSecondRef,
    liveZoomLevelRef,
    songRef,
    song,
    tracksById,
    snapEnabled,
    zoomLevel,
    runAction,
    applyPlaybackSnapshot,
    refreshSongView,
    performSeek,
    restoreConfirmedTransportVisual,
    queueClipMoveLiveUpdate,
    waitForClipMoveLiveIdle,
    setStatus,
    t,
  });

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

      const shouldPreserveVisualAnchor =
        !anchorMeta &&
        previousSnapshot?.playbackState === "playing" &&
        nextSnapshot.playbackState === "playing" &&
        previousSnapshot.projectRevision === nextSnapshot.projectRevision &&
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

  useTransportLifecycle({ applyPlaybackSnapshot, transportAnchorMetaRef, setStatus, t });

  useAudioMeters();

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

      void runAction(async () => {
        const nextSnapshot = await updateSongRegionTranspose(
          selectedRegion.id,
          clampedTransposeSemitones,
        );
        applyPlaybackSnapshot(nextSnapshot);
        setStatus(
          t("transport.status.regionTransposeUpdated", {
            name: selectedRegion.name,
            transpose: formatTransposeSemitones(clampedTransposeSemitones),
          }),
        );
      });
    },
    [applyPlaybackSnapshot, runAction, selectedRegion, setStatus, t],
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
    refreshLibraryState,
    t,
    setStatus,
    setActiveSidebarTab,
    snapshotRef,
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
    setStatus,
    t,
    handleSelectedRegionTransposeChange,
  });

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
    setTimeSignatureDraft(getSongBaseTimeSignature(song));
  }, [song, song?.projectRevision]);

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
      const nextPositionSeconds = anchor.anchorPositionSeconds + elapsedSeconds;

      syncLivePosition(nextPositionSeconds);
      animationFrameId = window.requestAnimationFrame(tick);
    };

    animationFrameId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [applyPlaybackSnapshot, playbackState]);

  useTransportPolling({ playbackState, applyPlaybackSnapshot });

  useEffect(() => {
    const closeMenu = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }
      if (
        event.target instanceof HTMLElement &&
        event.target.closest(".lt-context-menu")
      ) {
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
    selectedTrackIds,
    openTopMenu,
    setOpenTopMenu,
    setSelectedClipId,
    clearSelection,
    clearSelections,
    handleSaveProjectClick,
    handleSaveProjectAsClick,
    scheduleMarkerJumpWithGlobalMode,
    scheduleRegionJumpWithOptions,
    setStatus,
    t,
  });

  const workspaceDurationSeconds = getTimelineWorkspaceEndSeconds(
    song?.durationSeconds ?? 0,
    timelineContentEndSeconds,
  );
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
  const displayedBpm = readoutTempoRegion?.bpm ?? songBaseBpm;
  const displayedTimeSignature =
    readoutTempoRegion?.timeSignature ?? songBaseTimeSignature;
  const musicalPositionLabel = song
    ? formatMusicalPosition(readoutPositionSeconds, song)
    : "1.1.00";
  const tempoSourceLabel = readoutTempoRegion
    ? t("transport.tempoSource.at", {
        time: formatClock(readoutTempoRegion.startSeconds),
      })
    : t("transport.tempoSource.base");
  const {
    rulerContextMenu,
    songRegionContextMenu,
    tempoMarkerContextMenu,
    sectionContextMenu,
    timeSignatureMarkerContextMenu,
  } = useSongStructureActions({
    t,
    song,
    songBaseBpm,
    displayedTimeSignature,
    runAction,
    applyPlaybackSnapshot,
    setStatus,
    formatClock,
    clearSelection,
    setSelectedRegionId,
    setSelectedTimelineRange,
    setSelectedSectionId,
    setTempoDraft,
    setTimeSignatureDraft,
  });

  const {
    handleMidiLearnToggle,
    handleMidiLearnTarget,
    handleMidiLearnCommandRelearn,
    handleDynamicMidiLearnJump,
    handleResetMidiMappings,
    handleAudioOutputDeviceChange,
    handleAudioBackendChange,
    handleOutputSampleRateChange,
    handleOutputBufferSizeChange,
    handleAudioSafeModeChange,
    handleRefreshAudioDevices,
    handleEnabledOutputChannelChange,
    handleMetronomeOutputChange,
    handleTrackAudioToChange,
    handleMetronomeEnabledChange,
    handleMetronomeVolumeDraftChange,
    commitMetronomeVolumeDraft,
    handleGlobalJumpModeChange,
    handleGlobalJumpBarsChange,
    handleSongJumpTriggerChange,
    handleSongJumpBarsChange,
    handleSongTransitionModeChange,
    handleVampModeChange,
    handleVampBarsChange,
    handleMidiInputDeviceChange,
    handleRefreshMidiInputDevices,
    handleDismissMissingMidiDeviceWarning,
    handleHideMissingMidiDeviceWarning,
    handleLocaleChange,
  } = useSettingsPanelHandlers({
    t,
    i18n,
    midiLearnMode,
    appSettings,
    appSettingsRef,
    audioDeviceDescriptors,
    isMidiInputRefreshing,
    runAction,
    applyPlaybackSnapshot,
    setStatus,
    formatErrorStatus,
    persistAudioSettings,
    setMidiLearnMode,
    setMidiLearnFeedback,
    setMissingMidiDeviceWarning,
    setIsSettingsModalOpen,
    setIsRemoteModalOpen,
    setAppSettings,
    setMetronomeVolumeDraft,
    setAudioDeviceDescriptors,
    setAudioOutputChannelCounts,
    setDefaultAudioOutputDevice,
    setIsSettingsLoading,
    setMidiInputDevices,
    setIsMidiInputRefreshing,
  });

  const canPersistProject = Boolean(song);
  const isProjectEmpty = !song;
  const isProjectPending = Boolean(playbackProjectRevision > 0 && !song);
  const shouldShowEmptyState = !isProjectPending && !song;
  const timelineRowWidth = HEADER_WIDTH + laneViewportWidth;
  const visibleTracks = useMemo<TimelineTrackSummary[]>(() => {
    const realTracks = song ? buildVisibleTracks(song, collapsedFolders) : [];
    return [...realTracks, ...pendingAudioImports.map(toPendingTrack)];
  }, [collapsedFolders, pendingAudioImports, song]);
  const visibleLibraryAssets = useMemo<PendingLibraryAssetSummary[]>(
    () => [...libraryAssets, ...pendingAudioImports.map(toPendingLibraryAsset)],
    [libraryAssets, pendingAudioImports],
  );
  const shouldShowEmptyArrangementHint = Boolean(
    song && visibleTracks.length === 0,
  );
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

  const {
    resolveDraggedLibraryAsset,
    resolveLibraryDropLayout,
    resolveLibraryGhostLeft,
    updateLibraryClipPreview,
    resolveTimelineDropTargetAtClientPoint,
    resolveTimelineDropFromClientPoint,
    resolveTimelineDropFromNativePosition,
    resolveLibraryFolderDropFromClientPoint,
  } = useLibraryDragGeometry({
    libraryAssets,
    visibleTracks,
    timelineGrid,
    song,
    songBaseBpm,
    songBaseTimeSignature,
    snapEnabled,
    liveZoomLevelRef,
    livePixelsPerSecondRef,
    cameraXRef,
    rulerTrackRef,
    timelineShellRef,
    nativeWebviewPositionRef,
    nativeDropCoordinateModeRef,
    getCameraX,
    setLibraryClipPreview,
    setNativeDropDebugCandidates,
    t,
  });

  const {
    placeLibraryAssetsOnTimeline,
    handleDroppedSongPackagePath,
    handleDroppedAudioFiles,
    handleDroppedAudioPaths,
  } = useLibraryAudioImport({
    resolveDraggedLibraryAsset,
    applyPlaybackSnapshot,
    refreshLibraryState,
    mergeLibraryAssets,
    refreshSongView,
    startOptimisticClipOperation,
    completeOptimisticClipOperation,
    discardOptimisticClipOperation,
    tracksByIdRef,
    setSelectedSectionId,
    selectTrack,
    t,
    setStatus,
  });

  const {
    stopLibraryDragAutoScroll,
    clearLibraryDragPreview,
    clearActiveLibraryDragPayload,
    stopInternalLibraryPointerDragListeners,
    startInternalLibraryPointerDrag,
    handleExternalTimelineDrop,
    handleNativeFileDragOver,
    handleNativeFileDrop,
    handleDomExternalDropPreviewChange,
    resolveLibraryAutoScrollVelocity,
  } = useLibraryDropEvents({
    libraryDragHoverRef,
    activeLibraryDragPayloadRef,
    internalLibraryPointerDragRef,
    internalLibraryPointerDragListenersRef,
    libraryDragAutoScrollRef,
    nativeExternalDropPathsRef,
    nativeDropKindRef,
    domExternalDropPreviewUntilRef,
    lastNativeTimelineDropRef,
    laneAreaRef,
    timelineScrollViewportRef,
    rulerTrackRef,
    timelineShellRef,
    nativeDropCoordinateModeRef,
    cameraXRef,
    externalDropPreview,
    snapEnabled,
    setInternalLibraryPointerDrag,
    setExternalDropPreview,
    setNativeDropDebugCandidates,
    setLibraryClipPreview,
    updateCameraX,
    handleMoveLibraryAssets,
    placeLibraryAssetsOnTimeline,
    handleDroppedAudioFiles,
    handleDroppedAudioPaths,
    handleDroppedSongPackagePath,
    runAction,
    setStatus,
    t,
    updateLibraryClipPreview,
    resolveLibraryFolderDropFromClientPoint,
    resolveTimelineDropFromClientPoint,
    resolveTimelineDropTargetAtClientPoint,
    resolveLibraryDropLayout,
    resolveTimelineDropFromNativePosition,
  });

  useEffect(() => {
    handleNativeFileDragOverRef.current = handleNativeFileDragOver;
    handleNativeFileDropRef.current = handleNativeFileDrop;
  });

  const {
    handleTrackHeaderContextMenu,
    handleTrackHeaderDragStart,
    handleTrackHeaderFolderToggle,
    handleTrackHeaderMuteToggle,
    handleTrackHeaderSoloToggle,
    handleTrackHeaderVolumeChange,
    handleTrackHeaderVolumeCommit,
    handleTrackHeaderPanChange,
    handleTrackHeaderPanCommit,
    handleTrackHeaderTransposeToggle,
    handleTrackHeaderSelect,
    handleTrackLaneMouseDown,
    handleTrackLaneContextMenu,
    handleTrackListContextMenu,
  } = useArrangementActions({
    t,
    songRef,
    displayPositionSecondsRef,
    suppressTrackClickRef,
    trackDragRef,
    clipDragRef,
    clipPreviewSecondsRef,
    timelinePanRef,
    livePixelsPerSecondRef,
    visibleTracks,
    runAction,
    applyPlaybackSnapshot,
    setStatus,
    formatClock,
    setContextMenu,
    clearLibraryDragPreview,
    refreshSongView,
    selectTrack,
    selectClip,
    setSelectedClipId,
    clearSelection,
    setSelectedRegionId,
    setCollapsedFolders,
    patchTrackOptimisticMix,
    resolveTrackMix,
    queueTrackMixLiveUpdate,
    persistTrackMix,
    getCameraX,
    getTimelineScrollContainer,
    previewSeek,
    performSeek,
    restoreConfirmedTransportVisual,
    updateCameraX,
    normalizeSeek: normalizeTimelineSeekSeconds,
  });


  const {
    handleMarkerPrimaryAction,
  } = useMidiActions({
    songRef,
    snapshotRef,
    appSettingsRef,
    selectedRegionId,
    formatMidiLearnCommandLabel,
    runAction,
    applyPlaybackSnapshot,
    setAppSettings,
    setMidiLearnMode,
    setMidiLearnFeedback,
    setSelectedRegionId,
    setContextMenu,
    setStatus,
    selectSection,
    handleSelectedRegionTransposeChange,
    scheduleMarkerJumpWithGlobalMode,
    t,
  });

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

  return (
    <Profiler id="transport-panel" onRender={handlePanelRender}>
      <div
        className={`lt-daw-shell ${midiLearnMode !== null ? "is-midi-learn-active" : ""} ${isBusy ? "is-busy" : ""}`}
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
          onTempoDraftChange={setTempoDraft}
          onTempoCommit={() => {
            const nextBpm = Number(tempoDraft);
            const currentBpm = songBaseBpm;
            const clampedBpm = Math.max(20, Math.min(300, nextBpm));

            if (
              !song ||
              !Number.isFinite(clampedBpm) ||
              clampedBpm === currentBpm
            ) {
              setTempoDraft(String(currentBpm));
              return;
            }

            void runAction(async () => {
              const nextSnapshot = await updateSongTempo(clampedBpm);
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

        <div className={`lt-shell-body ${isBusy ? "is-hidden" : ""}`}>
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
                onImport={() => { void handleImportLibraryAssetsClick(); }}
                onCreateFolder={() => { void handleCreateLibraryFolder(); }}
                onMoveAssetsToFolder={(filePaths, folderPath) => { void handleMoveLibraryAssets(filePaths, folderPath); }}
                onRenameFolder={(folderPath) => { void handleRenameLibraryFolder(folderPath); }}
                onDeleteFolder={(folderPath) => { void handleDeleteLibraryFolder(folderPath); }}
                onDeleteRequested={(assets) => { void handleDeleteLibraryAssets(assets); }}
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
                    midiLearnMode={midiLearnMode}
                    onMidiLearnTarget={handleMidiLearnTarget}
                  />

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
                          shouldShowEmptyArrangementHint={
                            shouldShowEmptyArrangementHint
                          }
                          onHeadersWheel={handleTrackHeadersWheel}
                          getTrackChildCount={(trackId) =>
                            song ? trackChildrenCount(song, trackId) : 0
                          }
                          onSelectTrack={handleTrackHeaderSelect}
                          onOpenContextMenu={handleTrackHeaderContextMenu}
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
                          shouldShowEmptyArrangementHint={
                            shouldShowEmptyArrangementHint
                          }
                          normalizePositionSeconds={(positionSeconds) =>
                            normalizeTimelineSeekSeconds(
                              positionSeconds,
                              workspaceDurationSeconds,
                            )
                          }
                          resolveLibraryGhostLeft={resolveLibraryGhostLeft}
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
                          canNativeZoom={Boolean(song)}
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
              selectedAudioOutputDeviceMissing={selectedAudioOutputDeviceMissing}
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
              onAudioSafeModeChange={handleAudioSafeModeChange}
              metronomeVolumeDraft={metronomeVolumeDraft}
              onMetronomeEnabledChange={handleMetronomeEnabledChange}
              onMetronomeOutputChange={handleMetronomeOutputChange}
              onMetronomeVolumeDraftChange={handleMetronomeVolumeDraftChange}
              onCommitMetronomeVolume={commitMetronomeVolumeDraft}
              midiInputDevices={midiInputDevices}
              isMidiInputRefreshing={isMidiInputRefreshing}
              selectedMidiInputDevice={selectedMidiInputDevice}
              selectedMidiInputDeviceMissing={selectedMidiInputDeviceMissing}
              onMidiInputDeviceChange={handleMidiInputDeviceChange}
              onRefreshMidiInputDevices={handleRefreshMidiInputDevices}
              selectedLocale={selectedLocale}
              onLocaleChange={handleLocaleChange}
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

            <TimelineContextMenus
              contextMenu={contextMenu}
              onDismiss={() => setContextMenu(null)}
            />

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

            <div className="lt-status-overlay" aria-live="polite">
              <span>{status}</span>
            </div>
          </div>
        </div>
      </div>
    </Profiler>
  );
}
