import {
  Profiler,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { flushSync } from "react-dom";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { confirmDialog, promptDialog } from "../../shared/dialog/dialogService";
import {
  DEFAULT_APP_SETTINGS,
  buildSongTempoRegions,
  getEffectiveBpmAt,
  getPrimarySongRegion,
  getSongBaseBpm,
  getSongBaseTimeSignature,
  getSongTempoRegionAtPosition,
  getSongRegionAtPosition,
  regionPadKey,
  normalizeAppSettings,
  type AppSettings,
  type AudioBackendKind,
  type AudioDeviceDescriptor,
  type AudioMeterLevel,
  type AutomationActionSummary,
  type AutomationCueSummary,
  type AutomationJumpTargetSummary,
  type MixSceneSummary,
  type ClipSummary,
  type JumpTriggerLabel,
  type LibraryAssetSummary,
  type LibraryImportProgressEvent,
  type MarkerKind,
  type MidiBinding,
  type PendingJumpSummary,
  type PitchPrepareSummary,
  type RemoteServerInfo,
  type SectionMarkerSummary,
  type SongRegionSummary,
  type SongView,
  type SourceReadinessSummary,
  type TempoMarkerSummary,
  type TimeSignatureMarkerSummary,
  type TrackKind,
  type TrackSummary,
  type TransportSnapshot,
  type WaveformSummaryDto,
} from "@libretracks/shared/models";
import {
  TRACK_FADER_SCALE,
  positionToGain,
} from "@libretracks/shared/faderScale";
import {
  assignSectionMarkerDigit,
  cancelMarkerJump,
  createAudioTracksWithClips,
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
  deleteAutomationCue,
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
  pickLibraryFiles,
  importAudioFilesFromBytes,
  importAudioFilesFromPaths,
  importStagedAudioFiles,
  importSongPackageFromPathWithProgress,
  importExternalProjectFromPathWithProgress,
  isAndroidApp,
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
  setVoiceGuideConfigRealtime,
  setPadConfigRealtime,
  loadPadKey,
  getPadsCatalog,
  downloadPad,
  deletePad,
  listenToPadDownloadProgress,
  splitClip,
  splitClips,
  splitSongRegion,
  setSectionMarkerKind,
  setSectionMarkerColor,
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
  updateSongRegionKey,
  updateSongTempo,
  updateSongTimeSignature,
  updateTrack,
  updateTrackColor,
  updateTrackMixRealtime,
  commitTrackMixChange,
  updateTrackTransposeEnabled,
  upsertSongTempoMarker,
  upsertSongTimeSignatureMarker,
  upsertAutomationCue,
  upsertMixScene,
  deleteMixScene,
  addAutomationTrack,
  removeAutomationTrack,
  setAutomationTrackPosition,
  formatTransposeSemitones,
  listSessionTemplates,
  SONG_KEY_OPTIONS,
} from "./desktopApi";
import type { SessionTemplateSummary } from "./desktopApi";
import { getSystemLanguage } from "../../shared/i18n";
import {
  MARKER_KINDS as SECTION_KINDS,
  markerColor,
  markerKindCategory,
  markerKindColor,
  markerKindLabel,
  markerKindVariants,
  availableCueKinds,
} from "./markerKinds";
import { TimelineCanvasPane } from "./timeline/TimelineCanvasPane";
import { HorizontalScrollbar } from "./timeline/HorizontalScrollbar";
import { useRenderCounter } from "./perf/useRenderCounter";
import { CompactView } from "./compact/CompactView";
import { TimelineToolbar } from "./timeline/TimelineToolbar";
import { TimelineTopbar } from "./timeline/TimelineTopbar";
import { PadsPopover } from "./panels/PadsPopover";
import { MetronomePopover } from "./panels/MetronomePopover";
import { VoiceGuidePopover } from "./panels/VoiceGuidePopover";
import { TrackHeadersPane } from "./tracks/TrackHeadersPane";
import { buildClipSnapAnchors, findSnappedGroupDelta } from "./timeline/clipSnapping";
import {
  clampGroupRowDelta,
  resolveMemberTargetTrackId,
} from "./timeline/clipVerticalDrag";
import { snapToTimelineGrid, useTimelineGrid } from "./timeline/useTimelineGrid";
import {
  BASE_PIXELS_PER_SECOND,
  clampCameraX,
  clientXToLocalX,
  getElementScaleX,
  getElementScaleY,
  getCumulativeMusicalPosition,
  getFollowPlayheadCameraX,
  getMaxCameraX,
  getTimelineWorkspaceEndSeconds,
  getZoomLevelDelta,
  nextDownbeatAfter,
  screenXToSeconds,
  secondsToScreenX,
  TIMELINE_ZOOM_MULTIPLIER,
  zoomCameraAtViewportX,
} from "./timeline/timelineMath";
import { useTransportStore, type OptimisticMixState } from "./store";
import {
  createPendingAudioImports,
  createPendingAudioImportsFromPaths,
  mergeLibraryAssetsByFilePath,
  mergePendingClipsByTrack,
  nextPaint,
  toAutomationTrack,
  toPendingLibraryAsset,
  toPendingTrack,
  AUTOMATION_TRACK_ID,
  type PendingAudioImport,
  type PendingLibraryAssetSummary,
  type TimelineClipSummary,
  type TimelineTrackSummary,
} from "./library/pendingAudioImports";
import { TIMELINE_DEFAULT_TRACK_HEIGHT, useTimelineUIStore } from "./uiStore";
import { SideNav } from "./shell/SideNav";
import { SettingsPanel } from "./panels/SettingsPanel";
import {
  ExportSongModal,
  type ExportSongTarget,
} from "./panels/ExportSongModal";
import { ExportSessionModal } from "./panels/ExportSessionModal";
import {
  AutomationCueModal,
  type AutomationCueDraft,
} from "./panels/AutomationCueModal";
import { MixSceneModal } from "./panels/MixSceneModal";
import { RemotePanel } from "./panels/RemotePanel";
import { MobileLanding } from "./compact/MobileLanding";
import {
  LANDING_RECENT_SESSIONS_LIMIT,
  loadRecentSessions,
  type RecentSessionEntry,
} from "./recentSessions";
import { pickFilesViaWebView, stageFileForImport } from "./library/mobileFilePicker";
import { LibraryPanel } from "./panels/LibraryPanel";
import { useAudioMeters } from "./hooks/useAudioMeters";
import { useRegionMeters } from "./hooks/useRegionMeters";
import { useLibraryActions } from "./hooks/useLibraryActions";
import { useSettingsState } from "./hooks/useSettingsState";
import {
  UI_ZOOM_STATUS_EVENT,
  clientToZoomedCoords,
  getUiZoom,
} from "../../shared/uiZoom";
import { useTransportLifecycle } from "./hooks/useTransportLifecycle";
import { useTransportPolling } from "./hooks/useTransportPolling";
import {
  activateFromSources,
  deriveSourcesPreparing,
  nextSourcesPrepareUiState,
  SOURCES_PREPARE_INITIAL,
  SOURCES_SHOW_DELAY_MS,
  type SourcesPrepareUiState,
} from "./sourcesPrepare";
import { useProjectActions } from "./hooks/useProjectActions";
import { TimelineContextMenus } from "./timeline/TimelineContextMenus";
import { useTimelineActions } from "./timeline/useTimelineActions";
import { useTimelineKeyboardShortcuts } from "./timeline/TimelineKeyboardShortcuts";
import { useShortcutHint } from "./keyboard/shortcutHint";
import {
  buildTimelineDropPreviewGeometry,
  classifyDroppedPaths,
  isAcceptedDroppedFileName,
  type DroppedFileClassification,
  type ExternalDropKind,
  type ExternalDropPreview,
  type NativeDroppedPathClassification,
} from "./library/dragDrop";
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
import { runAudioImportPipeline } from "./library/importPipeline";
import {
  createLibraryDragDrop,
  type LibraryDragDropDeps,
} from "./library/libraryDragDrop";
import { createColorHandlers } from "./colors/colorHandlers";
import {
  TIMELINE_COLOR_PRESETS,
  loadRecentColors,
  normalizeTimelineColorInput,
  pushRecentColor,
} from "./colors/timelineColors";
import {
  automationTargetLabel,
  createAutomationCueId,
  createTimelineMenus,
  type TimelineMenuDeps,
} from "./menus/timelineMenus";
import { createTrackHandlers } from "./tracks/trackHandlers";
import { createTrackHeaderHandlers } from "./tracks/trackHeaderHandlers";
import { createCompactSongHandlers } from "./compact/compactSongHandlers";
import { useLibraryState } from "./hooks/useLibraryState";
import { useSongWaveforms } from "./hooks/useSongWaveforms";
import { useMidiRawMessages } from "./hooks/useMidiRawMessages";
import { createMidiLearnHandlers } from "./midi/midiLearnHandlers";
import { createTapTempoHandler } from "./tempo/tapTempoHandler";

const MIN_SESSION_BPM = 20;
const MAX_SESSION_BPM = 300;
/** Max linear gain a track fader reaches (+10 dB ≈ 3.162). The fader is a dB
 * scale now, so track volume must clamp to this headroom, not to unity (1.0). */
const MAX_TRACK_GAIN = positionToGain(1, TRACK_FADER_SCALE);
const WAVEFORM_REQUEST_BATCH_SIZE = 4;
/**
 * Keep a floating overlay (context menu, colour popover) fully on-screen.
 *
 * The desired `{x, y}` is where the pointer opened it. Once mounted we measure
 * the element and, if it would spill past the right/bottom viewport edge, shift
 * it back inside (flipping above/left of the anchor when there is no room
 * below/right). Runs in a layout effect so the corrected position paints before
 * the user sees a clipped frame. Returns the clamped style to spread onto the
 * element. The ref must be attached to the same element.
 */
function useClampedOverlayPosition(
  ref: React.RefObject<HTMLDivElement | null>,
  x: number,
  y: number,
) {
  const [position, setPosition] = useState<{
    left: number;
    top: number;
    maxHeight?: number;
  }>({ left: x, top: y });

  useLayoutEffect(() => {
    setPosition({ left: x, top: y });
    const element = ref.current;
    if (!element || typeof window === "undefined") {
      return;
    }
    // `x`/`y` are in the zoomed element's coordinate space (clientX / uiZoom),
    // but getBoundingClientRect()/innerWidth report real viewport pixels.
    // Reason in viewport space, then convert the result back by dividing by the
    // same zoom factor. Flip left/up when there is more room there, and cap the
    // height to the available space (the body scrolls) so it never spills off.
    const zoom = getUiZoom() || 1;
    const margin = 8;
    const rect = element.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const anchorViewportX = x * zoom;
    const anchorViewportY = y * zoom;

    let leftViewport = anchorViewportX;
    if (leftViewport + rect.width + margin > viewportW) {
      leftViewport = Math.max(margin, anchorViewportX - rect.width);
    }
    leftViewport = Math.max(
      margin,
      Math.min(leftViewport, viewportW - rect.width - margin),
    );

    const roomBelow = viewportH - anchorViewportY - margin;
    const roomAbove = anchorViewportY - margin;
    let topViewport: number;
    let maxHeight: number;
    if (rect.height <= roomBelow || roomBelow >= roomAbove) {
      topViewport = anchorViewportY;
      maxHeight = roomBelow;
    } else {
      maxHeight = roomAbove;
      topViewport = Math.max(
        margin,
        anchorViewportY - Math.min(rect.height, roomAbove),
      );
    }

    setPosition({
      left: leftViewport / zoom,
      top: topViewport / zoom,
      maxHeight: maxHeight / zoom,
    });
  }, [ref, x, y]);

  return position;
}

type TimelineColorPopoverProps = {
  x: number;
  y: number;
  title: string;
  initialColor: string;
  recentColors: string[];
  onApply: (color: string) => Promise<void>;
  onDismiss: () => void;
};

function TimelineColorPopover({
  x,
  y,
  title,
  initialColor,
  recentColors,
  onApply,
  onDismiss,
}: TimelineColorPopoverProps) {
  const [draftColor, setDraftColor] = useState(initialColor);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const position = useClampedOverlayPosition(popoverRef, x, y);

  useEffect(() => {
    setDraftColor(initialColor);
  }, [initialColor]);

  const normalizedColor = normalizeTimelineColorInput(draftColor) ?? "#3CDDC7";

  return (
    <div
      ref={popoverRef}
      className="lt-color-popover"
      style={{
        left: position.left,
        top: position.top,
        maxHeight: position.maxHeight,
      }}
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
      {recentColors.length > 0 ? (
        <>
          <span className="lt-color-popover-recents-title">Recientes</span>
          <div className="lt-color-popover-recents">
            {recentColors.map((color) => (
              <button
                key={color}
                type="button"
                className="lt-color-popover-swatch"
                style={{ background: color }}
                aria-label={color}
                title={color}
                onClick={() => setDraftColor(color)}
              />
            ))}
          </div>
        </>
      ) : null}
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
  useEffect(() => {
    const onUiZoomStatus = (event: Event) => {
      const zoom = (event as CustomEvent<{ zoom?: number }>).detail?.zoom;
      if (!Number.isFinite(zoom)) return;
      setStatus(
        t("transport.status.interfaceZoomChanged", {
          percent: Math.round((zoom ?? 1) * 100),
          defaultValue: "Interface size: {{percent}}%",
        }),
      );
    };

    window.addEventListener(UI_ZOOM_STATUS_EVENT, onUiZoomStatus);
    return () =>
      window.removeEventListener(UI_ZOOM_STATUS_EVENT, onUiZoomStatus);
  }, [setStatus, t]);
  const [pitchPrepareUiState, setPitchPrepareUiState] = useState<{
    active: boolean;
    message: string;
    error?: string;
    startedAt?: number;
  }>({ active: false, message: "" });
  // Global "Preparing audio…" indicator. `sourcesPrepareUiState.active` is
  // debounced (see sourcesPrepare.ts) so cache-warm projects never flash it.
  // `sourcesPreparing` is the UNdebounced flag that speeds up the snapshot poll.
  const [sourcesPrepareUiState, setSourcesPrepareUiState] =
    useState<SourcesPrepareUiState>(SOURCES_PREPARE_INITIAL);
  const [sourcesPreparing, setSourcesPreparing] = useState(false);
  // Non-modal "Descomprimiendo paquete…" indicator for the non-blocking .ltpkg
  // import (same style as the "Preparing audio…" indicator). The import no
  // longer raises the shell overlay, so without this the user sees nothing
  // happen while a large package decompresses and thinks the import failed.
  // `active` is owned by handleDroppedSongPackagePath (the common entry point);
  // `percent` is fed by the project:load-progress listener.
  const [packageUnpackUiState, setPackageUnpackUiState] = useState<{
    active: boolean;
    percent: number;
  }>({ active: false, percent: 0 });
  // Non-modal progress while a whole-session .ltset export runs (can be slow for
  // a large full export). `message` carries the live backend status.
  const [sessionExportUiState, setSessionExportUiState] = useState<{
    active: boolean;
    percent: number;
    message: string;
  }>({ active: false, percent: 0, message: "" });
  const sourcesShowTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (sourcesShowTimerRef.current !== null) {
        window.clearTimeout(sourcesShowTimerRef.current);
        sourcesShowTimerRef.current = null;
      }
    },
    [],
  );
  const [isBusy, setIsBusy] = useState(false);
  const [isProjectViewHydrating, setIsProjectViewHydrating] = useState(false);
  const [busyFeedback, setBusyFeedback] = useState<{
    message: string;
    percent?: number;
    detail?: string;
  } | null>(null);
  // Smoothed value the overlay actually renders. Loading/import progress from
  // the backend can jump (e.g. a fully-cached .ltpkg goes 18 -> 100 because
  // there's no slow decode to report), which reads as a frozen-then-snap bar.
  // We ease the displayed percent toward the real target each frame so the bar
  // always glides, without slowing the actual work. Null = no bar yet.
  const [displayPercent, setDisplayPercent] = useState<number | null>(null);
  const displayPercentRef = useRef<number | null>(null);
  const displayPercentRafRef = useRef<number | null>(null);
  const targetPercent =
    typeof busyFeedback?.percent === "number" ? busyFeedback.percent : null;
  useEffect(() => {
    // No bar requested: drop any in-flight animation and clear the display.
    if (targetPercent === null) {
      if (displayPercentRafRef.current !== null) {
        cancelAnimationFrame(displayPercentRafRef.current);
        displayPercentRafRef.current = null;
      }
      displayPercentRef.current = null;
      setDisplayPercent(null);
      return;
    }
    // First sample for this overlay: snap (don't ease up from 0, which would
    // look like a stutter when the very first event already reports e.g. 18%).
    if (displayPercentRef.current === null) {
      displayPercentRef.current = targetPercent;
      setDisplayPercent(targetPercent);
      return;
    }
    const step = () => {
      const current = displayPercentRef.current ?? targetPercent;
      const delta = targetPercent - current;
      // Close enough: settle exactly on the target and stop animating.
      if (Math.abs(delta) < 0.5) {
        displayPercentRef.current = targetPercent;
        setDisplayPercent(targetPercent);
        displayPercentRafRef.current = null;
        return;
      }
      // Ease ~15% of the remaining gap per frame, with a small floor so big
      // jumps (18 -> 100) still glide visibly instead of snapping.
      const next = current + Math.sign(delta) * Math.max(Math.abs(delta) * 0.15, 0.75);
      displayPercentRef.current = next;
      setDisplayPercent(next);
      displayPercentRafRef.current = requestAnimationFrame(step);
    };
    if (displayPercentRafRef.current !== null) {
      cancelAnimationFrame(displayPercentRafRef.current);
    }
    displayPercentRafRef.current = requestAnimationFrame(step);
    return () => {
      if (displayPercentRafRef.current !== null) {
        cancelAnimationFrame(displayPercentRafRef.current);
        displayPercentRafRef.current = null;
      }
    };
  }, [targetPercent]);
  const [remoteServerInfo, setRemoteServerInfo] =
    useState<RemoteServerInfo | null>(null);
  const [tempoDraft, setTempoDraft] = useState("120");
  const [timeSignatureDraft, setTimeSignatureDraft] = useState("4/4");
  // Re-render trigger when the playhead crosses into a different tempo region.
  // displayPositionSecondsRef is updated per-frame without re-rendering, so the
  // tempo input would otherwise stay frozen at the last region's BPM.
  const [activeTempoRegionKey, setActiveTempoRegionKey] = useState<string>("");
  // Id of the SONG region under the playhead. Distinct from the tempo region
  // above (tempo regions subdivide on BPM changes). Bumped when the playhead
  // crosses a song boundary so the "pad follows song key" effect re-evaluates
  // the tonic. Updated per-frame via a ref to avoid a render on every frame.
  const [activeSongRegionId, setActiveSongRegionId] = useState<string>("");
  const activeSongRegionIdRef = useRef("");
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
  const [recentColors, setRecentColors] = useState<string[]>(() =>
    loadRecentColors(),
  );
  const recordRecentColor = useCallback((color: string | null) => {
    if (!color) {
      return;
    }
    setRecentColors((previous) => pushRecentColor(previous, color));
  }, []);
  const [openTopMenu, setOpenTopMenu] = useState<"file" | null>(null);
  // Android: file-actions submenu (import song / export session) toggled from
  // its side-rail button.
  const [isMobileFileActionsOpen, setIsMobileFileActionsOpen] = useState(false);
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
  // True while the whole-session export-mode chooser (Light / Full) is shown.
  const [isExportSessionModalOpen, setIsExportSessionModalOpen] =
    useState(false);
  // Android: in-app sessions modal (create by name / open from list) that
  // replaces the dialog-based New/Open entries of the FILE menu.
  const [isMobileSessionsModalOpen, setIsMobileSessionsModalOpen] =
    useState(false);
  // Android: with touch, a tap meant for a marker flag that lands a few px
  // off seeks the transport instead — fatal mid-performance. This lock
  // disables plain tap-to-seek on the ruler; marker/region flags keep
  // working (they're separate overlays with their own handlers).
  const [rulerSeekLocked, setRulerSeekLocked] = useState(
    () =>
      typeof window !== "undefined" &&
      window.localStorage.getItem("libretracks.android.rulerSeekLocked") ===
        "1",
  );
  const toggleRulerSeekLock = () => {
    setRulerSeekLocked((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(
          "libretracks.android.rulerSeekLocked",
          next ? "1" : "0",
        );
      } catch {
        // Private mode → just lose persistence.
      }
      return next;
    });
  };
  const [automationCueDraft, setAutomationCueDraft] =
    useState<AutomationCueDraft | null>(null);
  const [isMixSceneModalOpen, setIsMixSceneModalOpen] = useState(false);
  const [isPadsPopoverOpen, setIsPadsPopoverOpen] = useState(false);
  const padButtonRef = useRef<HTMLButtonElement | null>(null);
  const [isMetronomePopoverOpen, setIsMetronomePopoverOpen] = useState(false);
  const metronomeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [isVoiceGuidePopoverOpen, setIsVoiceGuidePopoverOpen] = useState(false);
  const voiceGuideButtonRef = useRef<HTMLButtonElement | null>(null);
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
  // Visible height of the scroll viewport, observed reactively. The track
  // canvas paints its background grid up to a pixel height; if that height
  // is shorter than the viewport (which happens with few tracks, where the
  // tracks don't reach the bottom), an unpainted black gap appears below the
  // last lane. We feed this value into the canvas height so it always fills
  // the visible area. Kept reactive via the ResizeObserver below — reading
  // clientHeight inline during render goes stale on window/panel resize.
  const [timelineViewportHeight, setTimelineViewportHeight] = useState(0);
  // Mirrors `selectedOutputChannelCount` (derived far below in render) so the
  // settings handler factory — instantiated near the top — can read the current
  // value without depending on render-order of the derived memo.
  const selectedOutputChannelCountRef = useRef(1);
  // Mirrors `enabledOutputChannelsDraft` so the commit handler reads the live
  // draft the user just edited, not the previously-persisted value. Without
  // this, committing re-saved the stale settings value and silently reverted
  // multichannel selections back to stereo (Out 1/2).
  const enabledOutputChannelsDraftRef = useRef<number[]>([]);
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
    isAudioRefreshing,
    setIsAudioRefreshing,
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
  // Maps an action id to its current display shortcut, for showing keys next to
  // context-menu items (Reaper-style).
  const shortcutHint = useShortcutHint();
  const followPlayheadEnabled = useTimelineUIStore(
    (state) => state.followPlayheadEnabled,
  );
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

  // Mirror the persisted metronome volume into the slider draft so the
  // settings UI reflects external changes (remote, another window).
  useEffect(() => {
    setMetronomeVolumeDraft(appSettings.metronomeVolume);
  }, [appSettings.metronomeVolume]);

  // Same mirror for the output-channel checkboxes.
  useEffect(() => {
    setEnabledOutputChannelsDraft(appSettings.enabledOutputChannels);
  }, [appSettings.enabledOutputChannels]);

  // Re-seed the channel draft each time Settings opens, so a cancelled
  // edit never leaks into the next visit.
  useEffect(() => {
    if (isSettingsModalOpen) {
      setEnabledOutputChannelsDraft(
        appSettingsRef.current.enabledOutputChannels,
      );
    }
  }, [isSettingsModalOpen]);

  // One-shot: fetch the remote-server address for the Remote panel.
  useEffect(() => {
    // No remote server on Android — the command exists but always errors, so
    // skip the call instead of logging a guaranteed failure on every boot.
    if (!isTauriApp || isAndroidApp) {
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

  // Mirrored so the native-drop listener effect (below) always calls the
  // latest handler. Seeded null and filled by the sync effect after the first
  // render commit — the handlers are created lower in the body (destructured
  // from libraryDragDrop), so they aren't in scope yet at this line.
  const handleNativeFileDragOverRef = useRef<
    ((args: { paths?: string[]; position: { x: number; y: number } }) => void) | null
  >(null);
  const handleNativeFileDropRef = useRef<
    ((args: { paths: string[]; position: { x: number; y: number } }) => void) | null
  >(null);

  // Tauri native drag&drop bridge. Registers ONE webview-level listener and
  // fans `enter`/`over`/`drop`/`leave` out to the handler refs above (the real
  // handlers live further down the body). Also caches the webview position so
  // screen coords can be translated to client coords.
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
          handleNativeFileDragOverRef.current?.({
            paths: positionalPaths,
            position: payload.position,
          });
          return;
        }

        if (payload.type === "drop") {
          handleNativeFileDropRef.current?.({
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

  // Teardown: make sure a library pointer-drag never outlives the panel.
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
  const toggleFollowPlayheadEnabled = useTimelineUIStore(
    (state) => state.toggleFollowPlayheadEnabled,
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
  // Clamp a persisted track height that predates the current minimum.
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
  // Latest timeline grid snap interval, kept in a ref so the Arrow-key nudge
  // callback (declared before the grid is computed) can read it. Populated by
  // an effect once timelineGrid exists.
  const timelineGridSnapRef = useRef({
    snapIntervalSeconds: 0,
    beatDurationSeconds: 0,
  });
  const followPlayheadEnabledRef = useRef(followPlayheadEnabled);
  const viewModeRef = useRef(viewMode);
  const laneViewportWidthRef = useRef(320);
  const timelineContentEndSecondsRef = useRef(0);
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
  const inFlightWaveformKeysRef = useRef(new Set<string>());
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
  // Per-clip destination track override during a vertical clip drag. Read
  // inside the canvas rAF loop (like clipPreviewSecondsRef) so dragging a clip
  // onto another lane re-paints it there without a React re-render.
  const clipPreviewTrackIdRef = useRef<Record<string, string>>({});
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
    key: (event: KeyboardEvent) => void;
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
  const pendingAutomationCueSignature = useTransportStore((state) => {
    const pendingCue = state.playback?.pendingAutomationCue;
    if (!pendingCue) {
      return "";
    }

    return [
      pendingCue.cueId,
      pendingCue.cueName,
      pendingCue.executeAtSeconds.toFixed(6),
      JSON.stringify(pendingCue.target),
    ].join("|");
  });
  // Ids of cues that have used up their per-session run limit, taken from the
  // live snapshot so the lane greys them out during playback without a refetch.
  const exhaustedCueSignature = useTransportStore((state) =>
    (state.playback?.automationCues ?? [])
      .filter((cue) => cue.exhausted)
      .map((cue) => cue.id)
      .join("|"),
  );
  const exhaustedCueIds = useMemo(
    () => new Set(exhaustedCueSignature ? exhaustedCueSignature.split("|") : []),
    [exhaustedCueSignature],
  );
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
      // Feed the non-modal unpack indicator while a non-blocking package import
      // is in flight (the modal overlay isn't shown for those). Only updates the
      // percent when active; visibility is owned by handleDroppedSongPackagePath.
      setPackageUnpackUiState((prev) =>
        prev.active
          ? { active: true, percent: Math.max(prev.percent, event.percent) }
          : prev,
      );
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

  // Settings changed elsewhere (remote, second window) -> adopt them here.
  // Keeps appSettingsRef in sync for the ref-reading handler factories.
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

  // Raw MIDI input (learn + mapped region actions).
  // See ./hooks/useMidiRawMessages. The two region actions go through refs
  // because their originals are function declarations further down the body.
  const midiSelectRegionRef = useRef<((direction: -1 | 1) => void) | null>(
    null,
  );
  const midiRegionTransposeRef = useRef<
    | ((
        mappedKey:
          | "action:region_transpose_up"
          | "action:region_transpose_down"
          | "action:region_transpose_reset",
      ) => void)
    | null
  >(null);
  useMidiRawMessages({
    appSettingsRef,
    setAppSettings,
    setMidiLearnMode,
    setMidiLearnFeedback,
    setStatus,
    runAction,
    formatMidiLearnCommandLabel,
    t,
    onSelectRegionRef: midiSelectRegionRef,
    onRegionTransposeRef: midiRegionTransposeRef,
  });

  // Register the project load-progress listener for the unpack overlay.
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
        getEnabledOutputChannelsDraft: () =>
          enabledOutputChannelsDraftRef.current,
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
    handleLowLatencyOutputChange,
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
    handleTimelinePlayheadFollowModeChange,
    handleLocaleChange,
  } = settingsHandlers;

  // Metronome realtime + audio-device/MIDI refresh handlers. Like
  // settingsHandlers, instantiated once with stable deps so SettingsPanel's
  // handler props stay referentially stable. `isMidiInputRefreshing` is read
  // through a getter so the guard sees the live flag without re-creating the
  // factory. See ./settings/metronomeDeviceHandlers.
  const isMidiInputRefreshingRef = useRef(isMidiInputRefreshing);
  isMidiInputRefreshingRef.current = isMidiInputRefreshing;
  const isAudioRefreshingRef = useRef(isAudioRefreshing);
  isAudioRefreshingRef.current = isAudioRefreshing;
  const metronomeDeviceHandlers = useMemo(
    () =>
      createMetronomeDeviceHandlers({
        appSettingsRef,
        persistAudioSettings,
        setAppSettings,
        setMetronomeVolumeDraft,
        setIsSettingsLoading,
        setIsMidiInputRefreshing,
        setIsAudioRefreshing,
        setAudioDeviceDescriptors,
        setAudioOutputChannelCounts,
        setDefaultAudioOutputDevice,
        setMidiInputDevices,
        metronomeLiveRequestIdRef,
        isTauriApp,
        isMidiInputRefreshing: () => isMidiInputRefreshingRef.current,
        isAudioRefreshing: () => isAudioRefreshingRef.current,
        runAction,
        setStatus,
        formatErrorStatus,
        t,
        getAudioOutputDevices,
        getMidiInputs,
        setMetronomeSoundRealtime,
        setMetronomeEnabledRealtime,
        setMetronomeVolumeRealtime,
        setVoiceGuideConfigRealtime,
        setPadConfigRealtime,
        loadPadKey,
        saveSettings,
      }),
    [persistAudioSettings, runAction, setStatus, formatErrorStatus, t],
  );
  const {
    handleRefreshAudioDevices,
    handleMetronomeSoundChange,
    handleVoiceGuideChange,
    handleMetronomeEnabledChange,
    handleVoiceGuideEnabledChange,
    handlePadChange,
    handlePadEnabledChange,
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
        confirm: (message) => confirmDialog(message),
        prompt: (message, defaultValue) => promptDialog(message, defaultValue),
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

  const applySourcesSnapshot = useCallback(
    (sources: SourceReadinessSummary | null | undefined) => {
      const preparing = deriveSourcesPreparing(sources);
      // Drive the fast-poll flag immediately (not debounced) so the indicator's
      // numbers update smoothly while preparing.
      setSourcesPreparing(preparing);

      if (!preparing) {
        if (sourcesShowTimerRef.current !== null) {
          window.clearTimeout(sourcesShowTimerRef.current);
          sourcesShowTimerRef.current = null;
        }
        setSourcesPrepareUiState((prev) =>
          nextSourcesPrepareUiState(prev, sources),
        );
        return;
      }

      // Preparing: if already visible, refresh live numbers now.
      setSourcesPrepareUiState((prev) =>
        prev.active ? nextSourcesPrepareUiState(prev, sources) : prev,
      );
      // Not visible yet: arm the show-delay. When it fires, only show if prep is
      // STILL in flight (reads the latest snapshot), so sub-180ms preps never
      // flash the indicator.
      if (sourcesShowTimerRef.current === null) {
        sourcesShowTimerRef.current = window.setTimeout(() => {
          sourcesShowTimerRef.current = null;
          const next = activateFromSources(snapshotRef.current?.sources);
          if (next) {
            setSourcesPrepareUiState(next);
          }
        }, SOURCES_SHOW_DELAY_MS);
      }
    },
    [],
  );

  const applyPlaybackSnapshot = useCallback(
    (nextSnapshot: TransportSnapshot | null) => {
      useTransportStore.getState().setPlaybackState(nextSnapshot);
      snapshotRef.current = nextSnapshot;
      applyPitchPrepareSnapshot(nextSnapshot?.pitch);
      applySourcesSnapshot(nextSnapshot?.sources);
    },
    [applyPitchPrepareSnapshot, applySourcesSnapshot],
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
        volume: clamp(optimisticMix.volume ?? track.volume, 0, MAX_TRACK_GAIN),
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
        prompt: (message, defaultValue) => promptDialog(message, defaultValue),
        setAutomationTrackPosition,
        getVisibleTrackIds: () =>
          visibleTracksRef.current.map((track) => track.id),
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
        prompt: (message) => promptDialog(message),
      }),
    [setMidiLearnMode, t],
  );

  const applyTrackDragVisuals = useCallback(
    (dragState: NonNullable<TrackDragState>, dropState: TrackDropState) => {
      const isCompact = dragState.originSurface === "compact";
      const deltaY =
        (dragState.currentClientY - dragState.startClientY) /
        dragState.pointerScaleY;
      const deltaX =
        (dragState.currentClientX - dragState.startClientX) /
        dragState.pointerScaleX;

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

  // Publishes every transport snapshot: updates snapshotRef, re-anchors the
  // visual playhead and drives syncLivePosition. Hot path - see the 60fps
  // note on displayPositionSecondsRef.
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

  // Boot: pull audio settings and, if the voice guide was left enabled,
  // push its config now so it works without opening Settings.
  useEffect(() => {
    let active = true;

    void refreshAudioSettings()
      .then((settings) => {
        // If the voice guide was left enabled in a previous session, push the
        // config + load the clip bank now so it works without re-opening the
        // settings panel. set_voice_guide_config_realtime loads the bank.
        if (active && settings?.voiceGuideEnabled) {
          void setVoiceGuideConfigRealtime(settings).catch(() => {});
        }
      })
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

  // Audio devices + MIDI inputs are only enumerated while Settings/Remote is
  // open - the scan is expensive (see the open_device notes).
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

  // Backend waveform-ready events -> merge peaks into the waveform cache.
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

      inFlightWaveformKeysRef.current.delete(event.waveformKey);

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

  // Compact-view song/clip context-menu handlers + the library-folder rename
  // sync. See ./compact/compactSongHandlers. Reactive state is read through
  // getters so the factory stays referentially stable across renders.
  const {
    syncSongLibraryFolderAfterRename,
    handleCompactMoveClipToTrack,
    handleCompactDeleteClip,
    handleCompactRenameSong,
    handleCompactSetSongBpm,
    handleCompactDeleteSong,
    handleCompactExportSong,
    handleCompactSetSongKey,
    handleConfirmExportSong,
  } = useMemo(
    () =>
      createCompactSongHandlers({
        getSong: () => songRef.current,
        runAction,
        applyPlaybackSnapshot,
        setStatus,
        setSelectedRegionId,
        setExportSongTarget,
        setLibraryAssets,
        setLibraryFolders,
        loadLibraryState,
        prompt: (message, defaultValue) => promptDialog(message, defaultValue),
        confirm: (message) => confirmDialog(message),
        t,
        getEffectiveBpmAt,
        moveClipToTrack,
        deleteClip,
        updateSongRegion,
        updateSongRegionKey,
        upsertSongTempoMarker,
        deleteSongRegion,
        exportRegionAsPackage,
        renameLibraryFolder,
        moveLibraryAsset,
        deleteLibraryFolder,
      }),
    [
      applyPlaybackSnapshot,
      loadLibraryState,
      runAction,
      setExportSongTarget,
      setLibraryAssets,
      setLibraryFolders,
      setSelectedRegionId,
      setStatus,
      t,
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

  // Android: bulk "take these to the timeline". Touch can't pointer-drag
  // from the library across panels, so the library's selection action bar
  // (and the post-import prompt) call this instead: every asset lands on
  // its own auto-created track at the current playhead — the same pipeline
  // as dropping N files onto the timeline on desktop.
  const handleAddLibraryAssetsAtPlayhead = useCallback(
    (payload: Array<{ filePath: string }>) => {
      if (payload.length === 0) return;
      const startSeconds = displayPositionSecondsRef.current;
      void runAction(async () => {
        const snapshot = await createClipsWithAutoTracks(
          payload.map((item) => ({
            filePath: item.filePath,
            timelineStartSeconds: startSeconds,
          })),
        );
        applyPlaybackSnapshot(snapshot);
        setStatus(
          t("library.addedToTimeline", {
            count: payload.length,
            defaultValue: "{{count}} audios añadidos al timeline",
          }),
        );
      });
    },
    [applyPlaybackSnapshot, runAction, setStatus, t],
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
  //
  // Non-blocking: NO `busy: true`. The package import (decompression +
  // structure persist) runs off the session lock and reports progress through
  // the load-progress events; raising the blocking shell overlay here would
  // freeze the whole UI behind a "Descomprimiendo…" screen for the duration of
  // a large package, which is exactly what we want to avoid. Mirrors
  // handleImportSongClick (the file-menu entry point).
  const handleCompactImportSongPackageFromDialog = useCallback(() => {
    void runAction(async () => {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "LibreTracks Package", extensions: ["ltpkg"] }],
      });
      const path = typeof picked === "string" ? picked : null;
      if (!path) return;
      await runCompactSongPackageImport(path);
    });
  }, [runAction, runCompactSongPackageImport]);

  // OS-drag of a .ltpkg dropped anywhere over the compact song strip.
  // When running under Tauri we can resolve the absolute path; in the
  // browser fallback we'd have no path to feed import_song_package, so
  // we silently no-op there.
  //
  // Non-blocking (no `busy: true`) for the same reason as
  // handleCompactImportSongPackageFromDialog — the import runs off the session
  // lock and must not raise the freezing shell overlay.
  const handleCompactImportSongPackageFromOsFile = useCallback(
    (file: File) => {
      void runAction(async () => {
        const payloads = isTauriApp
          ? resolveNativeAudioImportPayloads([file])
          : null;
        const nativePath = payloads?.[0]?.sourcePath;
        if (!nativePath) return;
        await runCompactSongPackageImport(nativePath);
      });
    },
    [runAction, runCompactSongPackageImport],
  );

  const {
    handleSaveProjectClick,
    handleSaveProjectAsClick,
    handleCreateSongClick,
    handleCreateSongNamed,
    handleOpenProjectClick,
    handleOpenProjectFromPath,
    handleImportSongClick,
    handleImportSessionClick,
    handleExportSessionConfirm,
    handleImportExternalProjectClick,
    handleImportExternalProjectWizardClick,
    handleSaveAsTemplateClick,
    handleCreateSongFromTemplate,
    handleCreateSongFromTemplateNamed,
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
    setPackageUnpackUiState,
    setSessionExportUiState,
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

  // Warn once when the configured MIDI device is absent at boot.
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

  // Measure the lane viewport from the scroll viewport minus the headers
  // column. NOT from the ruler track: its content is sized from
  // laneViewportWidth, so measuring it would never converge.
  useEffect(() => {
    const shell = timelineShellRef.current;
    if (!shell) {
      return;
    }

    const updateViewportWidth = () => {
      // Measure the lane area from the *scrolling viewport*, which clips to the
      // available space, minus the fixed track-headers column. We deliberately
      // do NOT measure `rulerTrackRef`: its content (`.lt-ruler-content`) is
      // sized to the current `laneViewportWidth` with `overflow: visible`, so
      // its `clientWidth` just echoes back the width we last computed. That
      // self-reference means the observer never converges on a *new* viewport
      // width after a window/zoom resize — the lane stays frozen at the stale
      // value and playhead centering drifts off-centre (toward ~75%).
      const measuredViewport =
        timelineScrollViewportRef.current?.clientWidth ??
        shell.clientWidth ??
        DEFAULT_TIMELINE_VIEWPORT_WIDTH;
      const laneWidth = Math.max(320, measuredViewport - HEADER_WIDTH);
      setTimelineViewportWidth(laneWidth);

      const viewportHeight =
        timelineScrollViewportRef.current?.clientHeight ?? 0;
      setTimelineViewportHeight(viewportHeight);
    };

    updateViewportWidth();

    if (typeof ResizeObserver !== "undefined") {
      // Observe only the elements that clip to the available space (the shell
      // and the scrolling viewport). Observing the ruler track / lane area
      // would re-fire on every `laneViewportWidth` change — their widths track
      // that value — which is noise now that we no longer measure from them.
      const observer = new ResizeObserver(updateViewportWidth);
      observer.observe(shell);
      if (timelineScrollViewportRef.current) {
        observer.observe(timelineScrollViewportRef.current);
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

  // Project revision bumped -> refetch the SongView, unless this revision
  // came from a local optimistic mutation (then there is nothing to learn).
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
        inFlightWaveformKeysRef.current.clear();
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

  // Project identity changed (different session or song) -> reset all
  // project-scoped state so nothing leaks across projects.
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
      inFlightWaveformKeysRef.current.clear();
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

  // Session library: asset/folder loading + waveform pre-warm.
  // See ./hooks/useLibraryState.
  useLibraryState({
    playbackSongDir,
    songId: song?.id ?? null,
    libraryAssets,
    waveformCache,
    loadLibraryState,
    setLibraryAssets,
    setLibraryFolders,
    setLibraryClipPreview,
    setIsLibraryLoading,
    setWaveformCache,
    setStatus,
    formatErrorStatus,
    libraryStateRequestIdRef,
    inFlightWaveformKeysRef,
  });

  // Drop the waveform cache only when the song closes - it stays valid
  // across revisions of the same project.
  useEffect(() => {
    if (!song) {
      setWaveformCache({});
    }
    // Mantenemos la caché viva entre revisiones del mismo proyecto.
    // Solo se limpia si cerramos la canción (!song) o cambiamos de proyecto.
  }, [song?.id]);

  // Retire optimistic clip operations once the server revision catches up.
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

  // Mirror the effective BPM into the tempo input, unless the user is
  // editing it (never yank the value out from under them).
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

  // "Pad follows song key": when enabled, drive the pad's key from the tonic of
  // the song region under the playhead, re-evaluating when the playhead crosses
  // into another song (activeSongRegionId) or when that region's key/transpose
  // is edited (song?.projectRevision). A pad is a tonal drone, so only the
  // tonic matters — regionPadKey ignores major/minor. We push the change only
  // when the tonic actually differs from the current padKey to avoid redundant
  // decodes, and leave the manual key untouched when the song has no set key.
  useEffect(() => {
    if (!appSettings.padFollowSongKey || !appSettings.padEnabled) {
      return;
    }
    const region = getSongRegionAtPosition(
      songRef.current,
      displayPositionSecondsRef.current,
    );
    const tonic = regionPadKey(region);
    if (tonic === null || tonic === appSettingsRef.current.padKey) {
      return;
    }
    handlePadChange({ padKey: tonic });
  }, [
    appSettings.padFollowSongKey,
    appSettings.padEnabled,
    appSettings.padKey,
    activeSongRegionId,
    song?.projectRevision,
    handlePadChange,
  ]);

  // Waveforms for the song's clips (batched + polling).
  // See ./hooks/useSongWaveforms.
  useSongWaveforms({ song, setWaveformCache });

  // Clear the meters when playback stops so they don't freeze mid-level.
  useEffect(() => {
    if (playbackState === "playing") {
      return;
    }

    useTransportStore.getState().setMeters({});
  }, [playbackState, song?.projectRevision]);

  // Derive the clips-by-track and tracks-by-id lookup maps from the song.
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

  // Any structural change invalidates an in-flight library drag preview.
  useEffect(() => {
    libraryDragHoverRef.current = null;
    activeLibraryDragPayloadRef.current = null;
    stopLibraryDragAutoScroll();
    setLibraryClipPreview([]);
  }, [song?.projectRevision, song?.tracks.length, song?.clips.length]);

  // Mirror song duration into a ref for the non-React render path.
  useEffect(() => {
    songDurationSecondsRef.current = song?.durationSeconds ?? 0;
  }, [song?.durationSeconds]);

  // Duration changed -> re-anchor the transport visual so the playhead
  // keeps matching the (possibly resized) timeline.
  useEffect(() => {
    const songDurationSeconds = song?.durationSeconds ?? 0;
    songDurationSecondsRef.current = songDurationSeconds;

    if (!snapshotRef.current) {
      return;
    }

    applyTransportVisualAnchor(snapshotRef.current);
  }, [song?.durationSeconds]);

  // Retire optimistic mix values once the song reflects them.
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

  // Teardown for the render-metric timer.
  useEffect(() => {
    return () => {
      if (renderMetricTimeoutRef.current !== null) {
        window.clearTimeout(renderMetricTimeoutRef.current);
      }
    };
  }, []);

  // The 60fps playhead loop. Runs only while playing; writes through refs
  // and does NOT setState per frame - that is what keeps the panel from
  // re-rendering 60 times a second. Touch with care.
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
      maybeFollowPlayhead(nextPositionSeconds);
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
    sourcesPreparing,
  });

  // Android long-press opens context menus while the finger is still down;
  // the WebView then fires a synthesized pointer/mouse event on RELEASE,
  // which the outside-click closer below read as "clicked outside" and the
  // menu vanished before it could be used. Ignore dismissals in the first
  // instants after opening (touch only — desktop right-click is instant).
  const contextMenuOpenedAtRef = useRef(0);
  // Timestamp the context menu opening (Android long-press guard below).
  useEffect(() => {
    if (contextMenu) {
      contextMenuOpenedAtRef.current = Date.now();
    }
  }, [contextMenu]);

  // Close the context menu on outside click, ignoring the tap that opened
  // it on Android.
  useEffect(() => {
    const closeMenu = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }
      if (
        isAndroidApp &&
        Date.now() - contextMenuOpenedAtRef.current < 500
      ) {
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

  // Close the top menu bar on outside click / Escape.
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

  // Split a specific song region at the current playhead. Shared by the song
  // context menu and the Shift+S keyboard shortcut. No-op (returns false) if the
  // cursor isn't strictly inside the region.
  const splitSongRegionAtCursor = useCallback(
    async (regionId: string, regionStart: number, regionEnd: number) => {
      const cursorSeconds = displayPositionSecondsRef.current;
      if (cursorSeconds <= regionStart || cursorSeconds >= regionEnd) {
        return false;
      }
      await runAction(async () => {
        const nextSnapshot = await splitSongRegion(regionId, cursorSeconds);
        applyPlaybackSnapshot(nextSnapshot);
        await refreshSongView({ sync: true });
        setStatus(
          t("transport.status.songSplitAt", {
            time: formatClock(cursorSeconds),
            defaultValue: "Canción partida en {{time}}.",
          }),
        );
      });
      return true;
    },
    [runAction, applyPlaybackSnapshot, refreshSongView, setStatus, t],
  );

  // Find the song under the playhead and split it there (Shift+S).
  const splitSongUnderCursor = useCallback(async () => {
    const cursorSeconds = displayPositionSecondsRef.current;
    const region = (song?.regions ?? []).find(
      (candidate) =>
        cursorSeconds > candidate.startSeconds &&
        cursorSeconds < candidate.endSeconds,
    );
    if (!region) {
      return;
    }
    await splitSongRegionAtCursor(
      region.id,
      region.startSeconds,
      region.endSeconds,
    );
  }, [song, splitSongRegionAtCursor]);

  // Split the selected clip(s) at the playhead (S shortcut). Mirrors the clip
  // context-menu "Split at cursor" action: only clips whose span contains the
  // cursor are split, batched into one command. No-op when nothing qualifies.
  const splitSelectedClipsUnderCursor = useCallback(async () => {
    const cursorSeconds = displayPositionSecondsRef.current;
    const splittable = selectedClipSummaries.filter(
      (clip) =>
        cursorSeconds > clip.timelineStartSeconds &&
        cursorSeconds < clip.timelineStartSeconds + clip.durationSeconds,
    );
    if (!splittable.length) {
      return false;
    }
    await runAction(async () => {
      const ids = splittable.map((clip) => clip.id);
      const nextSnapshot =
        ids.length > 1
          ? await splitClips(ids, cursorSeconds)
          : await splitClip(ids[0], cursorSeconds);
      applyPlaybackSnapshot(nextSnapshot);
      setStatus(
        ids.length > 1
          ? t("transport.status.clipsSplitAt", {
              count: ids.length,
              time: formatClock(cursorSeconds),
              defaultValue: "Split {{count}} clips at {{time}}.",
            })
          : t("transport.status.clipSplitAt", {
              time: formatClock(cursorSeconds),
            }),
      );
    });
    return true;
  }, [selectedClipSummaries, runAction, applyPlaybackSnapshot, setStatus, t]);

  // Select every clip in the project (Ctrl+A). Returns false when empty so the
  // dispatcher can skip the status message.
  const selectAllClips = useCallback(() => {
    const clips = songRef.current?.clips ?? [];
    if (!clips.length) {
      return false;
    }
    setSelectedClipIds(clips.map((clip) => clip.id));
    return true;
  }, [setSelectedClipIds]);

  // Nudge the selected clip(s) left (-1) or right (+1) by one snap subdivision
  // (Arrow keys). Reads the live grid snap interval from a ref (the grid itself
  // is computed further down), falling back to the beat duration when there's
  // no sub-beat subdivision. Clamps to 0 so a clip can't be pushed before the
  // timeline start. No-op when nothing is selected.
  const nudgeSelectedClips = useCallback(
    async (direction: -1 | 1) => {
      if (!selectedClipSummaries.length) {
        return false;
      }
      const grid = timelineGridSnapRef.current;
      const step =
        grid.snapIntervalSeconds > 0
          ? grid.snapIntervalSeconds
          : grid.beatDurationSeconds;
      if (!(step > 0)) {
        return false;
      }
      const delta = step * direction;
      const moves = selectedClipSummaries.map((clip) => ({
        clipId: clip.id,
        timelineStartSeconds: Math.max(0, clip.timelineStartSeconds + delta),
      }));
      await runAction(async () => {
        const nextSnapshot = await moveClipsBatch(moves);
        applyPlaybackSnapshot(nextSnapshot);
      });
      return true;
    },
    [selectedClipSummaries, runAction, applyPlaybackSnapshot],
  );

  // Delete the currently selected song region via the Delete shortcut. Reuses
  // the same confirm-when-not-empty flow as the region context menu and the
  // compact view's delete-song button.
  const deleteSelectedRegion = useCallback(async () => {
    if (!selectedRegionId) {
      return;
    }
    await handleCompactDeleteSong(selectedRegionId);
  }, [selectedRegionId, handleCompactDeleteSong]);

  // Rename whatever is selected (F2). Priority: song → track → marker — the
  // three selectable things that have a rename command (clips inherit their
  // asset name and have no rename backend). Each branch mirrors the same
  // prompt + command its context-menu "Renombrar" entry uses.
  const renameSelected = useCallback(async () => {
    if (selectedRegionId) {
      await handleCompactRenameSong(selectedRegionId);
      return;
    }

    const currentSong = songRef.current;
    if (!currentSong) {
      return;
    }

    if (selectedTrackIds.length === 1) {
      const track = currentSong.tracks.find(
        (candidate) => candidate.id === selectedTrackIds[0],
      );
      if (!track) {
        return;
      }
      const nextName = (
        await promptDialog(t("transport.prompt.trackRename"), track.name)
      )?.trim();
      if (!nextName || nextName === track.name) {
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
      return;
    }

    if (selectedSectionId) {
      const section = currentSong.sectionMarkers.find(
        (candidate) => candidate.id === selectedSectionId,
      );
      if (!section) {
        return;
      }
      const nextName = (
        await promptDialog(t("transport.prompt.markerRename"), section.name)
      )?.trim();
      if (!nextName || nextName === section.name) {
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
    }
  }, [
    selectedRegionId,
    selectedTrackIds,
    selectedSectionId,
    handleCompactRenameSong,
    runAction,
    applyPlaybackSnapshot,
    setStatus,
    t,
  ]);

  useTimelineKeyboardShortcuts({
    runAction,
    applyPlaybackSnapshot,
    snapshotRef,
    song,
    selectedClipId,
    selectedClipIds,
    selectedTrackIds,
    selectedRegionId,
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
    splitSongUnderCursor,
    splitSelectedClipsUnderCursor,
    selectAllClips,
    nudgeSelectedClips,
    deleteSelectedRegion,
    renameSelected,
    setStatus,
    t,
    toggleViewMode,
  });

  // Global mouse listeners for clip drag + track drag. This is the hot
  // path: it writes destinations into clipPreviewTrackIdRef so the canvas
  // paints the ghost WITHOUT a React re-render. Its deps must stay
  // referentially stable or the listeners get torn down mid-drag.
  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      const clipDrag = clipDragRef.current;
      const effectSong = songRef.current;
      if (clipDrag && effectSong) {
        const effectPixelsPerSecond = livePixelsPerSecondRef.current;
        const deltaClientX = event.clientX - clipDrag.startClientX;
        const deltaClientY = event.clientY - clipDrag.startClientY;
        const deltaLocalX = deltaClientX / clipDrag.pointerScaleX;
        const deltaLocalY = deltaClientY / clipDrag.pointerScaleY;
        const exceededThreshold =
          Math.abs(deltaLocalX) > DRAG_THRESHOLD_PX ||
          Math.abs(deltaLocalY) > DRAG_THRESHOLD_PX;
        if (!clipDrag.hasMoved && exceededThreshold) {
          restoreConfirmedTransportVisual();
        }

        // Vertical axis: convert the cursor's Y travel into a whole-row delta
        // (tracks share a uniform height) and clamp it so every dragged member
        // stays on a droppable lane. The resulting per-clip destination tracks
        // are written to clipPreviewTrackIdRef, which the canvas reads to paint
        // the ghost on the target lane without a React re-render.
        const liveTrackHeight = Math.max(
          1,
          useTimelineUIStore.getState().trackHeight,
        );
        const desiredRowDelta = Math.round(
          deltaLocalY / liveTrackHeight,
        );
        const trackRowDelta = clampGroupRowDelta(
          clipDrag.members,
          desiredRowDelta,
          visibleTracksRef.current,
        );
        const nextPreviewTrackIds: Record<string, string> = {};
        if (trackRowDelta !== 0) {
          for (const member of clipDrag.members) {
            const targetTrackId = resolveMemberTargetTrackId(
              member,
              trackRowDelta,
              visibleTracksRef.current,
            );
            if (targetTrackId) {
              nextPreviewTrackIds[member.clipId] = targetTrackId;
            }
          }
        }
        const rawDeltaSeconds = deltaLocalX / effectPixelsPerSecond;

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
          trackRowDelta,
          activeSnapAnchor,
        };
        clipDragRef.current = nextDrag;
        clipPreviewSecondsRef.current = nextPreviewSeed;
        clipPreviewTrackIdRef.current = nextPreviewTrackIds;
        setClipDragSnapIndicatorSeconds(
          activeSnapAnchor ? activeSnapAnchor.seconds : null,
        );
      }

      const trackDrag = trackDragRef.current;
      if (trackDrag && songRef.current) {
        const deltaLocalX =
          (event.clientX - trackDrag.startClientX) / trackDrag.pointerScaleX;
        const deltaLocalY =
          (event.clientY - trackDrag.startClientY) / trackDrag.pointerScaleY;
        const exceededThreshold =
          Math.abs(deltaLocalX) > DRAG_THRESHOLD_PX ||
          Math.abs(deltaLocalY) > DRAG_THRESHOLD_PX;
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
        const deltaLocalX =
          (event.clientX - activeClipDrag.startClientX) /
          activeClipDrag.pointerScaleX;
        const deltaLocalY =
          (event.clientY - activeClipDrag.startClientY) /
          activeClipDrag.pointerScaleY;
        // Destination tracks captured from the live preview (final clamped
        // row delta). A clip changed lane only when it has an entry here.
        const previewTrackIds = clipPreviewTrackIdRef.current;
        const changedTrack = activeClipDrag.trackRowDelta !== 0;
        const movedEnough =
          activeClipDrag.hasMoved ||
          changedTrack ||
          Math.abs(deltaLocalX) > DRAG_THRESHOLD_PX ||
          Math.abs(deltaLocalY) > DRAG_THRESHOLD_PX;
        // Any track reassignment routes through the batch path so position +
        // track commit in a single operation (one undo, one revision), even
        // for a single clip.
        const useBatch =
          movedEnough &&
          (activeClipDrag.members.length > 1 || changedTrack);
        if (useBatch) {
          // Multi-clip drag: commit all positions in one batch so the engine
          // rebuilds the timeline window once, the history records a single
          // entry, and only one project_revision bumps.
          const batchMoves: ClipMoveRequest[] = activeClipDrag.members.map(
            (member) => ({
              clipId: member.clipId,
              timelineStartSeconds: member.previewSeconds,
              ...(previewTrackIds[member.clipId]
                ? { targetTrackId: previewTrackIds[member.clipId] }
                : {}),
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
                clipPreviewTrackIdRef.current = {};
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
                clipPreviewTrackIdRef.current = {};
              }
            }
          });
        } else {
          clipPreviewSecondsRef.current = {};
          clipPreviewTrackIdRef.current = {};
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
        clipPreviewTrackIdRef.current = {};
      }
      clipSelectionPendingCollapseRef.current = null;

      const activeTrackDrag = trackDragRef.current;
      if (activeTrackDrag) {
        const currentSong = songRef.current;
        const deltaLocalX =
          (event.clientX - activeTrackDrag.startClientX) /
          activeTrackDrag.pointerScaleX;
        const deltaLocalY =
          (event.clientY - activeTrackDrag.startClientY) /
          activeTrackDrag.pointerScaleY;
        const movedEnough =
          Math.abs(deltaLocalX) > DRAG_THRESHOLD_PX ||
          Math.abs(deltaLocalY) > DRAG_THRESHOLD_PX;
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
    snapEnabled,
    waitForClipMoveLiveIdle,
    // NOTE: selectedClipIds / toggleClipSelection / zoomLevel are deliberately
    // NOT deps. They were listed but never referenced in the body — the effect
    // reads the live zoom through liveZoomLevelRef/livePixelsPerSecondRef and
    // the selection through useTimelineUIStore.getState(), exactly so it does
    // not have to re-subscribe. Listing them tore down and re-registered the
    // global mousemove/mouseup listeners mid-drag every time the zoom changed
    // or the selection moved.
  ]);

  // Teardown: clear any leftover track-drag visuals.
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

    // Track the song region under the playhead so the "pad follows song key"
    // effect can react when the playhead crosses into a song with a different
    // tonic. Only re-renders on an actual boundary crossing.
    const nextSongRegionId =
      getSongRegionAtPosition(songRef.current, clampedPosition)?.id ?? "";
    if (nextSongRegionId !== activeSongRegionIdRef.current) {
      activeSongRegionIdRef.current = nextSongRegionId;
      setActiveSongRegionId(nextSongRegionId);
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

  function maybeFollowPlayhead(positionSeconds: number) {
    if (
      !followPlayheadEnabledRef.current ||
      viewModeRef.current !== "daw" ||
      playheadDragRef.current
    ) {
      return;
    }

    const effectivePixelsPerSecond = livePixelsPerSecondRef.current;
    const viewportWidth = laneViewportWidthRef.current;
    const durationSeconds = songRef.current?.durationSeconds ?? 0;
    const nextCameraX = getFollowPlayheadCameraX({
      playheadSeconds: positionSeconds,
      cameraX: cameraXRef.current,
      pixelsPerSecond: effectivePixelsPerSecond,
      viewportWidth,
      durationSeconds,
      contentEndSeconds: timelineContentEndSecondsRef.current,
      followMode: appSettingsRef.current.timelinePlayheadFollowMode,
    });

    if (nextCameraX === null) {
      return;
    }

    updateCameraX(nextCameraX, {
      durationSeconds,
      contentEndSeconds: timelineContentEndSecondsRef.current,
      pixelsPerSecond: effectivePixelsPerSecond,
      viewportWidth,
      syncPlayhead: false,
      commitToStore: false,
    });
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
    // The custom horizontal scrollbar reads cameraXRef directly each frame, so
    // it needs no imperative scrollLeft sync here.

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
  // Mirror follow-playhead / view mode / viewport metrics into refs for
  // the non-React camera path.
  useEffect(() => {
    followPlayheadEnabledRef.current = followPlayheadEnabled;
    viewModeRef.current = viewMode;
    laneViewportWidthRef.current = laneViewportWidth;
    timelineContentEndSecondsRef.current = timelineContentEndSeconds;
  }, [
    followPlayheadEnabled,
    laneViewportWidth,
    timelineContentEndSeconds,
    viewMode,
  ]);
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
  const pendingAutomationCue = pendingAutomationCueSignature
    ? (snapshotRef.current?.pendingAutomationCue ?? null)
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
  // Context-menu builders. Instantiated once; they read a fresh deps snapshot
  // from timelineMenuDepsRef on every invocation (synced after each render),
  // so their identities stay referentially stable without capturing stale
  // state. Synced in an effect (not during render) because the deps include
  // handlers declared lower in the body (e.g. clearLibraryDragPreview from
  // libraryDragDrop); menu builders only run from user-event handlers, well
  // after the first commit, so the deferred sync is safe. See ./menus/timelineMenus.
  const timelineMenuDepsRef = useRef<TimelineMenuDeps | null>(null);
  // Deferred deps snapshot for the context-menu builders. Deferred on
  // purpose: its deps include values declared lower in the body.
  useEffect(() => {
    timelineMenuDepsRef.current = {
      t,
      shortcutHint,
      song,
      songBaseBpm,
      displayedTimeSignature,
      appSettings,
      selectedClipIds,
      selectedClipSummaries,
      songRef,
      displayPositionSecondsRef,
      contextMenuPositionRef,
      optimisticallyAppliedRevisionsRef,
      tempoDraftDirtyRef,
      runAction,
      applyPlaybackSnapshot,
      refreshSongView,
      setStatus,
      setContextMenu,
      setColorPickerPopover,
      setTempoDraft,
      setTimeSignatureDraft,
      setSelectedRegionId,
      setSelectedTimelineRange,
      setSelectedClipId,
      setSelectedSectionId,
      setExportSongTarget,
      setAutomationCueDraft,
      setIsMixSceneModalOpen,
      clearSelection,
      selectTrack,
      recordRecentColor,
      splitSongRegionAtCursor,
      duplicateClipGroup,
      syncSongLibraryFolderAfterRename,
      clearLibraryDragPreview,
      handleCreateTrack,
      handleSetTrackColor,
      handleSetTrackColors,
      handleSetClipColor,
    };
  });
  const timelineMenus = useMemo(
    () =>
      createTimelineMenus(() => {
        const deps = timelineMenuDepsRef.current;
        if (!deps) {
          throw new Error("timeline menus invoked before first render commit");
        }
        return deps;
      }),
    [],
  );
  const {
    openMenu,
    createAutomationCueAt,
    editAutomationCue,
    automationCueContextMenu,
    rulerContextMenu,
    songRegionContextMenu,
    tempoMarkerContextMenu,
    timeSignatureMarkerContextMenu,
    sectionContextMenu,
    trackContextMenu,
    globalTrackListContextMenu,
    handleTrackHeaderContextMenu,
    clipContextMenu,
  } = timelineMenus;

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
  // Reusable templates discovered in the default templates folder, offered on
  // the empty-state landing. Refreshed whenever the landing becomes visible so
  // a template just saved from a session shows up next time you land here.
  const [sessionTemplates, setSessionTemplates] = useState<
    SessionTemplateSummary[]
  >([]);
  const [templateFilter, setTemplateFilter] = useState("");
  // Whether the first template scan has resolved yet. Starts true so we render
  // a loading placeholder instead of flashing the "no templates" empty message
  // during the brief window before listSessionTemplates() resolves on load.
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [recentSessions, setRecentSessions] = useState<RecentSessionEntry[]>(
    [],
  );
  // Empty state: load recent sessions + templates for the landing panel.
  useEffect(() => {
    if (!shouldShowEmptyState) {
      return;
    }
    setRecentSessions(loadRecentSessions());
    let cancelled = false;
    setTemplatesLoading(true);
    void listSessionTemplates()
      .then((templates) => {
        if (!cancelled) {
          setSessionTemplates(templates);
          // Drop any stale filter each time the list is (re)loaded.
          setTemplateFilter("");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSessionTemplates([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setTemplatesLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [shouldShowEmptyState]);
  // Show the search box only once the list is long enough that scanning it by
  // eye gets tedious; below that a filter would just be visual noise.
  const TEMPLATE_FILTER_THRESHOLD = 8;
  const filteredTemplates = useMemo(() => {
    const query = templateFilter.trim().toLowerCase();
    if (!query) {
      return sessionTemplates;
    }
    return sessionTemplates.filter((template) =>
      template.name.toLowerCase().includes(query),
    );
  }, [sessionTemplates, templateFilter]);
  const timelineRowWidth = HEADER_WIDTH + laneViewportWidth;
  const visibleTracks = useMemo<TimelineTrackSummary[]>(() => {
    const realTracks: TimelineTrackSummary[] = song
      ? buildVisibleTracks(song, collapsedFolders)
      : [];

    // Inject the synthetic automation lane (if the user added it) at the saved
    // position: after the track whose id is `afterTrackId`, or first when null.
    // It is not a real song track — see toAutomationTrack().
    if (song?.automationTrack) {
      const afterId = song.automationTrack.afterTrackId ?? null;
      const automationRow = toAutomationTrack(
        t("transport.automation.trackName"),
      );
      if (afterId === null) {
        realTracks.unshift(automationRow);
      } else {
        const anchorIndex = realTracks.findIndex(
          (track) => track.id === afterId,
        );
        if (anchorIndex >= 0) {
          realTracks.splice(anchorIndex + 1, 0, automationRow);
        } else {
          // Anchor track no longer visible/exists: fall back to the top.
          realTracks.unshift(automationRow);
        }
      }
    }

    return [
      ...realTracks,
      ...pendingAudioImports
        .filter((pendingImport) => pendingImport.showInTimeline)
        .map(toPendingTrack),
    ];
  }, [collapsedFolders, pendingAudioImports, song, t]);
  // Mirror the visible-track order into a ref so the global mouse handlers
  // (which intentionally don't re-bind on every track/zoom change) can map a
  // cursor Y to a destination track during a vertical clip drag.
  const visibleTracksRef = useRef<TimelineTrackSummary[]>(visibleTracks);
  visibleTracksRef.current = visibleTracks;
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

  // Mirror the workspace duration into a ref for the camera math.
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

  // Keep the latest grid snap interval in a ref so nudgeSelectedClips (defined
  // earlier, before the keyboard hook) can read it without a declaration-order
  // problem. The callback only fires in response to a keystroke (post-render),
  // by which point the ref is populated.
  useEffect(() => {
    timelineGridSnapRef.current = {
      snapIntervalSeconds: timelineGrid.snapIntervalSeconds,
      beatDurationSeconds: timelineGrid.beatDurationSeconds,
    };
  }, [timelineGrid.snapIntervalSeconds, timelineGrid.beatDurationSeconds]);

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

  // Point the MIDI listener's refs at the two declarations above. No dep array:
  // both close over per-render values (selectedRegionId), so the refs must
  // track the latest version on every render.
  useEffect(() => {
    midiSelectRegionRef.current = handleSelectRegionFromMidi;
    midiRegionTransposeRef.current = handleRegionTransposeFromMidi;
  });

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

  // Clamp the zoom level when the minimum changes (viewport resize).
  useEffect(() => {
    setZoomLevel((current) =>
      current < effectiveZoomMin ? effectiveZoomMin : current,
    );
  }, [effectiveZoomMin]);

  // Fit-to-window on first load of a song that has clips.
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

  // Mirror zoom + pixels-per-second into refs for the render path.
  useEffect(() => {
    liveZoomLevelRef.current = zoomLevel;
    livePixelsPerSecondRef.current = pixelsPerSecond;
  }, [pixelsPerSecond, zoomLevel]);

  // Adopt an external cameraX unless a zoom debounce owns it right now.
  useEffect(() => {
    if (
      zoomDebounceTimerRef.current === null ||
      Math.abs(cameraXRef.current - cameraX) <= 0.5
    ) {
      cameraXRef.current = cameraX;
    }
  }, [cameraX]);

  // Teardown for the scroll/zoom debounce timers.
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

  // Re-clamp the camera after any viewport/zoom/duration change.
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

  // Re-sync the live playhead after anything that changes its mapping
  // to pixels (zoom, tempo, duration).
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

  // Commit the modal's result: create or update the cue, then refresh.
  const handleConfirmAutomationCue = useCallback(
    (result: { actions: AutomationActionSummary[]; maxRuns: number | null }) => {
      const draft = automationCueDraft;
      const currentSong = songRef.current;
      if (!draft || !currentSong) {
        return;
      }
      setAutomationCueDraft(null);

      void runAction(async () => {
        const jump = result.actions.find((a) => a.type === "jump");
        const label =
          jump && jump.type === "jump"
            ? t("transport.automation.labelJumpTo", {
                target: automationTargetLabel(currentSong, jump.target, t),
              })
            : t("transport.automation.labelActionsCount", {
                count: result.actions.length,
              });
        const nextSnapshot = await upsertAutomationCue({
          id: draft.cueId ?? createAutomationCueId(),
          name: draft.name ?? label,
          atSeconds: draft.atSeconds,
          enabled: true,
          maxRuns: result.maxRuns,
          actions: result.actions,
        });
        applyPlaybackSnapshot(nextSnapshot);
        await refreshSongView({ includeWaveforms: false, sync: true });
        setStatus(
          draft.cueId
            ? t("transport.automation.statusCueUpdated", { label })
            : t("transport.automation.statusCueCreated", {
                time: formatClock(draft.atSeconds),
                label,
              }),
        );
      });
    },
    [automationCueDraft, runAction, applyPlaybackSnapshot, refreshSongView, t],
  );

  // Mix scene create/edit — the modal calls these; backend commands already
  // exist. Refresh so the new/changed scene is available to applyScene actions.
  const handleUpsertMixScene = useCallback(
    async (scene: MixSceneSummary) => {
      await runAction(async () => {
        const nextSnapshot = await upsertMixScene(scene);
        applyPlaybackSnapshot(nextSnapshot);
        await refreshSongView({ includeWaveforms: false, sync: true });
      });
    },
    [runAction, applyPlaybackSnapshot, refreshSongView],
  );

  const handleDeleteMixScene = useCallback(
    async (sceneId: string) => {
      await runAction(async () => {
        const nextSnapshot = await deleteMixScene(sceneId);
        applyPlaybackSnapshot(nextSnapshot);
        await refreshSongView({ includeWaveforms: false, sync: true });
      });
    },
    [runAction, applyPlaybackSnapshot, refreshSongView],
  );

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

  // Double-click on the timeline viewport (native listener: React's
  // synthetic dblclick doesn't reach the canvas reliably).
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

  // Track-header controls (selection, drag start, folder collapse, mute/solo/
  // volume/pan/transpose). See ./tracks/trackHeaderHandlers. Reactive state is
  // read through getters and refs so the factory stays referentially stable.
  const {
    handleTrackHeaderSelect,
    handleTrackHeaderDragStart,
    handleTrackHeaderFolderToggle,
    handleTrackHeaderMuteToggle,
    handleTrackHeaderSoloToggle,
    handleTrackHeaderVolumeChange,
    handleTrackHeaderVolumeCommit,
    handleTrackHeaderPanChange,
    handleTrackHeaderPanCommit,
    handleTrackHeaderTransposeToggle,
  } = useMemo(
    () =>
      createTrackHeaderHandlers({
        findTrack: (trackId) => findTrack(songRef.current, trackId),
        getVisibleTrackIds: () =>
          visibleTracksRef.current.map((track) => track.id),
        getSelectedTrackIds: () =>
          useTimelineUIStore.getState().selectedTrackIds,
        selectTrack,
        resolveTrackMix,
        patchTrackOptimisticMix,
        queueTrackMixLiveUpdate,
        persistTrackMix,
        runAction,
        applyPlaybackSnapshot,
        optimisticallyAppliedRevisionsRef,
        setSong,
        setCollapsedFolders,
        setContextMenu,
        setPitchPrepareUiState,
        setStatus,
        t,
        updateTrackTransposeEnabled,
        suppressTrackClickRef,
        trackSelectionAnchorRef,
        trackDragRef,
        clamp,
        getElementScaleX,
        getElementScaleY,
        maxTrackGain: MAX_TRACK_GAIN,
      }),
    [
      applyPlaybackSnapshot,
      patchTrackOptimisticMix,
      persistTrackMix,
      queueTrackMixLiveUpdate,
      resolveTrackMix,
      runAction,
      selectTrack,
      setStatus,
      t,
    ],
  );

  function beginTimelineSeekOrPan(event: ReactMouseEvent<HTMLElement>) {
    event.preventDefault();
    setContextMenu(null);
    // Clamp the seek to the full timeline workspace (song + the empty
    // 1-hour tail), not to the song's end. Clicking in the empty space
    // past the last region should drop the playhead where the cursor is,
    // not snap it back to the end of the song. timelineDurationSecondsRef
    // mirrors workspaceDurationSeconds (= max(song, content) + tail).
    const seekLimitSeconds =
      timelineDurationSecondsRef.current || songRef.current?.durationSeconds || 0;
    const previewSeconds = normalizeTimelineSeekSeconds(
      rulerClientXToSeconds(
        event.clientX,
        event.currentTarget,
        getCameraX(),
        seekLimitSeconds,
        livePixelsPerSecondRef.current,
      ),
      seekLimitSeconds,
    );
    previewSeek(previewSeconds);

    const activePan: NonNullable<TimelinePanState> = {
      pointerId: 1,
      startClientX: event.clientX,
      pointerScaleX: getElementScaleX(
        event.currentTarget.getBoundingClientRect(),
        event.currentTarget.offsetWidth,
      ),
      originCameraX: getCameraX(),
      previewSeconds,
      hasMoved: false,
    };
    timelinePanRef.current = activePan;

    const onMouseMove = (windowEvent: MouseEvent) => {
      const deltaX =
        (activePan.startClientX - windowEvent.clientX) /
        activePan.pointerScaleX;
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
            originTrackId: clip.trackId,
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
          originTrackId: hitClip.trackId,
        });
        previewSeed[hitClip.id] = hitClip.timelineStartSeconds;
      }

      const snapAnchors = currentSong
        ? buildClipSnapAnchors(currentSong, members, playheadAnchorSeconds)
        : [];
      const dragBounds = event.currentTarget.getBoundingClientRect();

      clipDragRef.current = {
        clipId: hitClip.id,
        pointerId: 1,
        originSeconds: hitClip.timelineStartSeconds,
        previewSeconds: hitClip.timelineStartSeconds,
        clickSeekSeconds,
        startClientX: event.clientX,
        startClientY: event.clientY,
        pointerScaleX: getElementScaleX(dragBounds, event.currentTarget.offsetWidth),
        pointerScaleY: getElementScaleY(dragBounds, event.currentTarget.offsetHeight),
        trackRowDelta: 0,
        hasMoved: false,
        members,
        snapAnchors,
        activeSnapAnchor: null,
      };
      clipPreviewSecondsRef.current = previewSeed;
      clipPreviewTrackIdRef.current = {};
      return;
    }

    beginTimelineSeekOrPan(event);
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
    openMenu(
      event,
      t("transport.menu.tracksMenuTitle", { defaultValue: "Tracks" }),
      globalTrackListContextMenu(),
    );
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

  // Library drag&drop + external-file-drop pipeline. Instantiated once; reads a
  // fresh deps snapshot from libraryDragDropDepsRef so handler identities stay
  // referentially stable without capturing stale state. The ref is populated
  // synchronously during render (NOT in an effect) because some of these
  // handlers run from other effects' mount/cleanup phases (e.g. the native-drop
  // listener teardown, the drag-reset effect) which commit before this
  // component's own sync effect would — an effect-based sync would leave the
  // ref null on that first pass. See ./library/libraryDragDrop.
  const libraryDragDropDepsRef = useRef<LibraryDragDropDeps | null>(null);
  libraryDragDropDepsRef.current = {
      t,
      song,
      songBaseBpm,
      songBaseTimeSignature,
      snapEnabled,
      libraryAssets,
      visibleTracks,
      timelineGrid,
      externalDropPreview,
      rulerTrackRef,
      laneAreaRef,
      timelineShellRef,
      timelineScrollViewportRef,
      cameraXRef,
      liveZoomLevelRef,
      livePixelsPerSecondRef,
      nativeWebviewPositionRef,
      nativeDropCoordinateModeRef,
      nativeDropKindRef,
      nativeExternalDropPathsRef,
      domExternalDropPreviewUntilRef,
      lastNativeTimelineDropRef,
      internalLibraryPointerDragRef,
      internalLibraryPointerDragListenersRef,
      libraryDragHoverRef,
      activeLibraryDragPayloadRef,
      libraryDragAutoScrollRef,
      tracksByIdRef,
      displayPositionSecondsRef,
      playbackSongDirRef,
      setLibraryClipPreview,
      setInternalLibraryPointerDrag,
      setCompactDragPreview,
      setNativeDropDebugCandidates,
      setPackageUnpackUiState,
      setExternalDropPreview,
      setSelectedSectionId,
      setStatus,
      getCameraX,
      updateCameraX,
      runAction,
      applyPlaybackSnapshot,
      refreshSongView,
      formatErrorStatus,
      selectTrack,
      mergeLibraryAssets,
      refreshLibraryState,
      startOptimisticClipOperation,
      completeOptimisticClipOperation,
      discardOptimisticClipOperation,
      handleCompactDropLibraryAssetsIntoSong,
      handleMoveLibraryAssets,
      runCompactSongPackageImport,
      assignAssetsToSongFolder,
  };
  const libraryDragDrop = useMemo(
    () =>
      createLibraryDragDrop(() => {
        const value = libraryDragDropDepsRef.current;
        if (!value) {
          throw new Error(
            "library drag&drop invoked before first render commit",
          );
        }
        return value;
      }),
    [],
  );
  const {
    resolveDraggedLibraryAsset,
    resolveLibraryGhostLeft,
    resolveTimelineDropFromClientPoint,
    resolveLibraryAutoScrollVelocity,
    stopLibraryDragAutoScroll,
    clearLibraryDragPreview,
    clearActiveLibraryDragPayload,
    stopInternalLibraryPointerDragListeners,
    startInternalLibraryPointerDrag,
    handleDroppedSongPackagePath,
    handleImportLibraryFromDialog,
    handleExternalTimelineDrop,
    handleNativeFileDragOver,
    handleNativeFileDrop,
    handleDomExternalDropPreviewChange,
  } = libraryDragDrop;

  // Keep the native-drop listener's handler refs pointed at the latest
  // destructured handlers (they're created just above; the refs were seeded
  // null near the top of the body).
  useEffect(() => {
    handleNativeFileDragOverRef.current = handleNativeFileDragOver;
    handleNativeFileDropRef.current = handleNativeFileDrop;
  });

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
  enabledOutputChannelsDraftRef.current = enabledOutputChannelsDraft;
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
  // Keyboard shortcuts and MIDI make no sense on a phone/tablet: no physical
  // keyboard by default, and midir has no Android backend (the MIDI tabs
  // would only ever show an empty device list).
  const androidHiddenSettingsTabs: SettingsTab[] = [
    "shortcuts",
    "midi",
    "midiLearn",
  ];
  const allSettingsTabs: Array<{ id: SettingsTab; label: string }> = [
    {
      id: "audio",
      label: t("transport.settingsModal.tabAudio", { defaultValue: "Audio" }),
    },
    {
      id: "general",
      label: t("transport.settingsModal.tabGeneral", {
        defaultValue: "General",
      }),
    },
    {
      id: "shortcuts",
      label: t("transport.settingsModal.tabShortcuts", {
        defaultValue: "Atajos",
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
  const settingsTabs = isAndroidApp
    ? allSettingsTabs.filter(
        (tab) => !androidHiddenSettingsTabs.includes(tab.id),
      )
    : allSettingsTabs;

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
                {typeof displayPercent === "number" ? (
                  <span className="busy-overlay-percent">
                    {Math.max(0, Math.min(100, Math.round(displayPercent)))}%
                  </span>
                ) : null}
              </div>
              <p>
                {busyFeedback?.message ?? t("transport.shell.busyDescription")}
              </p>
              {typeof displayPercent === "number" ? (
                <div
                  className="busy-overlay-progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(displayPercent)}
                  aria-valuetext={busyFeedback?.message}
                >
                  <span
                    style={{
                      width: `${Math.max(0, Math.min(100, displayPercent))}%`,
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
          onCreateSongFromTemplate={() => handleCreateSongFromTemplate()}
          onOpenProject={handleOpenProjectClick}
          onOpenRecentSession={handleOpenProjectFromPath}
          onOpenMobileSessions={() => setIsMobileSessionsModalOpen(true)}
          onImportSong={handleImportSongClick}
          onImportSession={handleImportSessionClick}
          onExportSession={() => setIsExportSessionModalOpen(true)}
          onImportExternalProject={handleImportExternalProjectClick}
          onSaveProject={handleSaveProjectClick}
          onSaveProjectAs={handleSaveProjectAsClick}
          onSaveAsTemplate={handleSaveAsTemplateClick}
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
          metronomeButtonRef={metronomeButtonRef}
          onOpenMetronome={() => setIsMetronomePopoverOpen((open) => !open)}
          isMetronomePopoverOpen={isMetronomePopoverOpen}
          voiceGuideEnabled={appSettings.voiceGuideEnabled}
          onToggleVoiceGuide={() =>
            handleVoiceGuideEnabledChange(!appSettings.voiceGuideEnabled)
          }
          voiceGuideButtonRef={voiceGuideButtonRef}
          onOpenVoiceGuide={() => setIsVoiceGuidePopoverOpen((open) => !open)}
          isVoiceGuidePopoverOpen={isVoiceGuidePopoverOpen}
          padEnabled={appSettings.padEnabled}
          padButtonRef={padButtonRef}
          onTogglePads={() =>
            handlePadEnabledChange(!appSettings.padEnabled)
          }
          onOpenPads={() => setIsPadsPopoverOpen((open) => !open)}
          isPadsPopoverOpen={isPadsPopoverOpen}
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

        <MetronomePopover
          open={isMetronomePopoverOpen}
          anchorRef={metronomeButtonRef}
          settings={appSettings}
          routeOptions={audioRoutingOptions}
          volumeDraft={metronomeVolumeDraft}
          midiLearnMode={midiLearnMode}
          onClose={() => setIsMetronomePopoverOpen(false)}
          onEnabledChange={handleMetronomeEnabledChange}
          onOutputChange={handleMetronomeOutputChange}
          onVolumeDraftChange={handleMetronomeVolumeDraftChange}
          onCommitVolume={commitMetronomeVolumeDraft}
          onSoundChange={handleMetronomeSoundChange}
          onMidiLearnTarget={handleMidiLearnTarget}
        />

        <VoiceGuidePopover
          open={isVoiceGuidePopoverOpen}
          anchorRef={voiceGuideButtonRef}
          settings={appSettings}
          routeOptions={audioRoutingOptions}
          onClose={() => setIsVoiceGuidePopoverOpen(false)}
          onChange={handleVoiceGuideChange}
        />

        <PadsPopover
          open={isPadsPopoverOpen}
          anchorRef={padButtonRef}
          settings={appSettings}
          routeOptions={audioRoutingOptions}
          onClose={() => setIsPadsPopoverOpen(false)}
          onToggleEnabled={handlePadEnabledChange}
          onPadChange={handlePadChange}
        />

        <div className={`lt-shell-body ${isShellBusy ? "is-hidden" : ""}`}>
          <SideNav
            activeSidebarTab={activeSidebarTab}
            isRemoteModalOpen={isRemoteModalOpen}
            isSettingsModalOpen={isSettingsModalOpen}
            onLibraryToggle={() => handleSidebarTabToggle("library")}
            onRemoteClick={handleRemoteButtonClick}
            onSettingsClick={handleSettingsButtonClick}
            onSessionsClick={() => setIsMobileSessionsModalOpen(true)}
            onSaveClick={handleSaveProjectClick}
            canSave={canPersistProject}
            onFileActionsClick={() =>
              setIsMobileFileActionsOpen((current) => !current)
            }
            isFileActionsOpen={isMobileFileActionsOpen}
          />

          {/* Android: file-actions submenu anchored to the side rail. Import
              session lives on the landing screen (like desktop); these are the
              in-session actions. */}
          {isMobileFileActionsOpen ? (
            <div
              className="lt-mobile-file-menu-backdrop"
              onClick={() => setIsMobileFileActionsOpen(false)}
            >
              <div
                className="lt-mobile-file-menu"
                role="menu"
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setIsMobileFileActionsOpen(false);
                    handleImportSongClick();
                  }}
                >
                  <span className="material-symbols-outlined">library_add</span>
                  {t("timelineTopbar.importSong")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!song}
                  onClick={() => {
                    setIsMobileFileActionsOpen(false);
                    setIsExportSessionModalOpen(true);
                  }}
                >
                  <span className="material-symbols-outlined">ios_share</span>
                  {t("timelineTopbar.exportSession", {
                    defaultValue: "Exportar sesión…",
                  })}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!song}
                  onClick={() => {
                    setIsMobileFileActionsOpen(false);
                    handleSaveAsTemplateClick();
                  }}
                >
                  <span className="material-symbols-outlined">bookmark_add</span>
                  {t("timelineTopbar.saveAsTemplate", {
                    defaultValue: "Guardar como plantilla…",
                  })}
                </button>
              </div>
            </div>
          ) : null}

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
                  void handleImportLibraryFromDialog();
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
                onAddSelectionToTimeline={(assets) => {
                  handleAddLibraryAssetsAtPlayhead(
                    assets.map((asset) => ({ filePath: asset.filePath })),
                  );
                }}
              />
              {shouldShowEmptyState ? (
                isAndroidApp ? (
                  <MobileLanding
                    onCreateSession={handleCreateSongNamed}
                    onCreateSessionFromTemplate={
                      handleCreateSongFromTemplateNamed
                    }
                    onOpenSessionFromPicker={handleOpenProjectClick}
                    onOpenSessionFromPath={handleOpenProjectFromPath}
                    onImportSession={handleImportSessionClick}
                  />
                ) : (
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
                      <button type="button" onClick={handleImportSessionClick}>
                        {t("transport.shell.importSession", {
                          defaultValue: "Importar sesión",
                        })}
                      </button>
                      <button
                        type="button"
                        onClick={handleImportExternalProjectWizardClick}
                      >
                        {t("timelineTopbar.importExternalProject")}
                      </button>
                    </div>
                    <div className="lt-empty-state-columns">
                    <div className="lt-empty-state-templates">
                      <div className="lt-empty-state-templates-header">
                        <span>
                          {t("transport.shell.templatesHeading", {
                            defaultValue: "Plantillas",
                          })}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleCreateSongFromTemplate()}
                        >
                          {t("transport.shell.useTemplateFile", {
                            defaultValue: "Usar plantilla de archivo…",
                          })}
                        </button>
                      </div>
                      {sessionTemplates.length > 0 ? (
                        <>
                          {sessionTemplates.length >=
                          TEMPLATE_FILTER_THRESHOLD ? (
                            <input
                              type="search"
                              className="lt-empty-state-template-filter"
                              value={templateFilter}
                              onChange={(event) =>
                                setTemplateFilter(event.target.value)
                              }
                              placeholder={t(
                                "transport.shell.filterTemplates",
                                { defaultValue: "Buscar plantilla…" },
                              )}
                              aria-label={t("transport.shell.filterTemplates", {
                                defaultValue: "Buscar plantilla…",
                              })}
                            />
                          ) : null}
                          {filteredTemplates.length > 0 ? (
                            <ul className="lt-empty-state-template-list">
                              {filteredTemplates.map((template) => (
                                <li key={template.path}>
                                  <button
                                    type="button"
                                    title={template.path}
                                    onClick={() =>
                                      handleCreateSongFromTemplate(template.path)
                                    }
                                  >
                                    {template.name}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="lt-empty-state-templates-empty">
                              {t("transport.shell.noTemplateMatches", {
                                defaultValue:
                                  "Ninguna plantilla coincide con la búsqueda.",
                              })}
                            </p>
                          )}
                        </>
                      ) : templatesLoading ? (
                        <p className="lt-empty-state-templates-empty">
                          {t("transport.shell.templatesLoading", {
                            defaultValue: "Cargando plantillas…",
                          })}
                        </p>
                      ) : (
                        <p className="lt-empty-state-templates-empty">
                          {t("transport.shell.noTemplates", {
                            defaultValue:
                              "Aún no tienes plantillas. Guarda una desde una sesión con “Guardar como plantilla…”.",
                          })}
                        </p>
                      )}
                    </div>
                    <div className="lt-empty-state-templates lt-empty-state-recents">
                      <div className="lt-empty-state-templates-header">
                        <span>
                          {t("transport.shell.recentsHeading", {
                            defaultValue: "Recientes",
                          })}
                        </span>
                      </div>
                      {recentSessions.length > 0 ? (
                        <ul className="lt-empty-state-template-list">
                          {recentSessions
                            .slice(0, LANDING_RECENT_SESSIONS_LIMIT)
                            .map((entry) => (
                              <li key={entry.path}>
                                <button
                                  type="button"
                                  title={entry.path}
                                  onClick={() =>
                                    handleOpenProjectFromPath(entry.path)
                                  }
                                >
                                  {entry.name}
                                </button>
                              </li>
                            ))}
                        </ul>
                      ) : (
                        <p className="lt-empty-state-templates-empty">
                          {t("transport.shell.noRecents", {
                            defaultValue:
                              "Aún no hay sesiones recientes. Las sesiones que abras o crees aparecerán aquí.",
                          })}
                        </p>
                      )}
                    </div>
                    </div>
                  </div>
                </div>
                )
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
                    followPlayheadEnabled={followPlayheadEnabled}
                    onToggleSnap={toggleSnapEnabled}
                    onToggleFollowPlayhead={toggleFollowPlayheadEnabled}
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

                          const left = clientXToLocalX(
                            candidate.clientX,
                            shellBounds,
                            timelineShellRef.current?.offsetWidth,
                          );
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
                          headerActions={
                            isAndroidApp ? (
                              <>
                                <button
                                  type="button"
                                  className="lt-icon-button"
                                  aria-label={t(
                                    "timelineToolbar.trackHeightDecrease",
                                    { defaultValue: "Pistas más bajas" },
                                  )}
                                  onClick={() =>
                                    applyTrackHeight(
                                      trackHeight - TRACK_HEIGHT_STEP,
                                    )
                                  }
                                >
                                  <span className="material-symbols-outlined">
                                    unfold_less
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  className="lt-icon-button"
                                  aria-label={t(
                                    "timelineToolbar.trackHeightIncrease",
                                    { defaultValue: "Pistas más altas" },
                                  )}
                                  onClick={() =>
                                    applyTrackHeight(
                                      trackHeight + TRACK_HEIGHT_STEP,
                                    )
                                  }
                                >
                                  <span className="material-symbols-outlined">
                                    unfold_more
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  className={`lt-icon-button ${rulerSeekLocked ? "is-active" : ""}`}
                                  aria-label={t(
                                    "timelineToolbar.rulerSeekLock",
                                    {
                                      defaultValue:
                                        "Bloquear salto al tocar el ruler",
                                    },
                                  )}
                                  aria-pressed={rulerSeekLocked}
                                  onClick={toggleRulerSeekLock}
                                >
                                  <span className="material-symbols-outlined">
                                    {rulerSeekLocked ? "lock" : "lock_open"}
                                  </span>
                                </button>
                              </>
                            ) : undefined
                          }
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
                          viewportHeight={timelineViewportHeight}
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
                          pendingAutomationCue={pendingAutomationCue}
                          exhaustedCueIds={exhaustedCueIds}
                          activeVamp={activeVamp}
                          midiLearnMode={midiLearnMode}
                          onMidiLearnTarget={handleMidiLearnTarget}
                          displayPositionSecondsRef={displayPositionSecondsRef}
                          playheadDragRef={playheadDragRef}
                          clipPreviewSecondsRef={clipPreviewSecondsRef}
                          clipPreviewTrackIdRef={clipPreviewTrackIdRef}
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
                              !rulerTrackRef.current ||
                              // Android seek lock: plain ruler taps neither
                              // seek nor range-select; marker/region flags
                              // are separate overlays and keep working.
                              rulerSeekLocked ||
                              // Android long-press: releasing the finger after
                              // the context menu opened fires a synthesized
                              // mousedown HERE, which seeked ("cursor moved")
                              // and closed the fresh menu. Same grace window
                              // as the global outside-click closer.
                              (isAndroidApp &&
                                Date.now() - contextMenuOpenedAtRef.current <
                                  600)
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
                            const pressStartedAt = Date.now();
                            const pointerScaleX = getElementScaleX(
                              event.currentTarget.getBoundingClientRect(),
                              event.currentTarget.offsetWidth,
                            );
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
                                Math.abs(
                                  (windowEvent.clientX - startClientX) /
                                    pointerScaleX,
                                ) > DRAG_THRESHOLD_PX;
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

                              // Android long-press: the context menu opened
                              // DURING this very press (mousedown fires when
                              // the finger lands, the menu ~600 ms later).
                              // Releasing the finger must neither seek away
                              // ("cursor moved") nor disturb the fresh menu.
                              if (
                                isAndroidApp &&
                                contextMenuOpenedAtRef.current >= pressStartedAt
                              ) {
                                setSelectedTimelineRange(null);
                                return;
                              }

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
                          onAutomationCueContextMenu={(event, cueId) => {
                            const cue = song?.automationCues?.find(
                              (candidate) => candidate.id === cueId,
                            );
                            if (!cue) {
                              return;
                            }

                            clearSelection();
                            setSelectedTimelineRange(null);
                            setSelectedRegionId(null);
                            openMenu(
                              event,
                              cue.name,
                              automationCueContextMenu(cue),
                            );
                          }}
                          onAutomationCueEdit={(cueId) => {
                            const cue = song?.automationCues?.find(
                              (candidate) => candidate.id === cueId,
                            );
                            if (cue) {
                              editAutomationCue(cue);
                            }
                          }}
                          onAutomationLaneContextMenu={(event) => {
                            if (!song) {
                              return;
                            }
                            const positionSeconds = snappedRulerSeconds(
                              event,
                              workspaceDurationSeconds,
                            );
                            clearSelection();
                            setSelectedRegionId(null);
                            // If the right-click landed near an existing cue's
                            // diamond, open that cue's menu instead of the
                            // create menu — so a near-miss on the small hotspot
                            // still edits the cue rather than offering to create.
                            // Use the RAW (unsnapped) click seconds so grid snap
                            // doesn't skew the proximity test.
                            const pps = livePixelsPerSecondRef.current;
                            const rawSeconds = rulerClientXToSeconds(
                              event.clientX,
                              rulerTrackRef.current as HTMLElement,
                              getCameraX(),
                              workspaceDurationSeconds,
                              pps,
                            );
                            const nearCue = (song.automationCues ?? []).find(
                              (cue) =>
                                Math.abs((cue.atSeconds - rawSeconds) * pps) <=
                                12,
                            );
                            if (nearCue) {
                              openMenu(
                                event,
                                nearCue.name,
                                automationCueContextMenu(nearCue),
                              );
                              return;
                            }
                            openMenu(event, t("transport.automation.menuTitle"), [
                              {
                                label: t("transport.automation.createCue"),
                                disabled:
                                  (song?.regions.length ?? 0) === 0 &&
                                  (song?.sectionMarkers.length ?? 0) === 0,
                                onSelect: () =>
                                  createAutomationCueAt(positionSeconds),
                              },
                            ]);
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
                          onMarkerMoveCommit={(markerId, startSeconds) => {
                            const section = song?.sectionMarkers.find(
                              (candidate) => candidate.id === markerId,
                            );
                            if (!section) {
                              return;
                            }
                            void runAction(async () => {
                              const nextSnapshot = await updateSectionMarker(
                                section.id,
                                section.name,
                                startSeconds,
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
                          onPlayheadEdgeAutoScroll={(deltaPx) => {
                            updateCameraX(cameraXRef.current + deltaPx, {
                              commitToStore: false,
                            });
                            return cameraXRef.current;
                          }}
                          onTrackListContextMenu={handleTrackListContextMenu}
                          onTrackLaneMouseDown={handleTrackLaneMouseDown}
                          onTimelineBackgroundMouseDown={(event) => {
                            if (
                              event.button !== 0 ||
                              isInteractiveTimelineTarget(event.target)
                            ) {
                              return;
                            }
                            beginTimelineSeekOrPan(event);
                          }}
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
                        <HorizontalScrollbar
                          ariaLabel={t("transport.shell.horizontalScroll")}
                          cameraXRef={cameraXRef}
                          maxCameraX={maxTimelineCameraX}
                          onScrollTo={(nextCameraX) => {
                            updateCameraX(nextCameraX, {
                              commitToStore: false,
                            });
                          }}
                        />
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
                      onSetSongKey={handleCompactSetSongKey}
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
              isAudioRefreshing={isAudioRefreshing}
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
              onLowLatencyOutputChange={handleLowLatencyOutputChange}
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
              onTimelinePlayheadFollowModeChange={
                handleTimelinePlayheadFollowModeChange
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

            {isMobileSessionsModalOpen ? (
              <div
                className="lt-modal-backdrop"
                onClick={() => setIsMobileSessionsModalOpen(false)}
              >
                <section
                  className="lt-settings-modal"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="lt-mobile-sessions-title"
                  onClick={(event) => event.stopPropagation()}
                >
                  <header className="lt-settings-modal-header">
                    <div>
                      <h2 id="lt-mobile-sessions-title">
                        {t("timelineTopbar.mobileSessions", {
                          defaultValue: "Sesiones…",
                        })}
                      </h2>
                    </div>
                    <button
                      type="button"
                      className="lt-settings-modal-close"
                      onClick={() => setIsMobileSessionsModalOpen(false)}
                    >
                      <span className="material-symbols-outlined">close</span>
                      {t("common.close")}
                    </button>
                  </header>
                  <div className="lt-settings-modal-body">
                    <MobileLanding
                      embedded
                      onCreateSession={(name, parentDir) => {
                        setIsMobileSessionsModalOpen(false);
                        handleCreateSongNamed(name, parentDir);
                      }}
                      onCreateSessionFromTemplate={(
                        templatePath,
                        name,
                        parentDir,
                      ) => {
                        setIsMobileSessionsModalOpen(false);
                        handleCreateSongFromTemplateNamed(
                          templatePath,
                          name,
                          parentDir,
                        );
                      }}
                      onOpenSessionFromPicker={() => {
                        setIsMobileSessionsModalOpen(false);
                        handleOpenProjectClick();
                      }}
                      onOpenSessionFromPath={(path) => {
                        setIsMobileSessionsModalOpen(false);
                        handleOpenProjectFromPath(path);
                      }}
                      onImportSession={() => {
                        setIsMobileSessionsModalOpen(false);
                        handleImportSessionClick();
                      }}
                    />
                  </div>
                </section>
              </div>
            ) : null}

            <ExportSongModal
              target={exportSongTarget}
              onCancel={() => setExportSongTarget(null)}
              onConfirm={handleConfirmExportSong}
            />

            <ExportSessionModal
              isOpen={isExportSessionModalOpen}
              sessionTitle={song?.title ?? ""}
              onCancel={() => setIsExportSessionModalOpen(false)}
              onConfirm={(includeAudio) => {
                setIsExportSessionModalOpen(false);
                handleExportSessionConfirm(includeAudio);
              }}
            />

            {automationCueDraft ? (
              <AutomationCueModal
                draft={automationCueDraft}
                song={song}
                appSettings={appSettings}
                padRouteOptions={audioRoutingOptions}
                onCancel={() => setAutomationCueDraft(null)}
                onConfirm={handleConfirmAutomationCue}
              />
            ) : null}

            <MixSceneModal
              open={isMixSceneModalOpen}
              song={song}
              onCancel={() => setIsMixSceneModalOpen(false)}
              onUpsert={handleUpsertMixScene}
              onDelete={handleDeleteMixScene}
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
                recentColors={recentColors}
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

            {packageUnpackUiState.active ? (
              <div
                className="lt-source-prep-indicator"
                aria-live="polite"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(packageUnpackUiState.percent)}
              >
                <div className="lt-source-prep-line">
                  <span className="lt-source-prep-label">
                    {t("transport.status.unpackingPackage")}
                  </span>
                  <span className="lt-source-prep-detail">
                    {Math.round(packageUnpackUiState.percent)}%
                  </span>
                </div>
                <div className="lt-source-prep-bar">
                  <span
                    style={{
                      width: `${Math.max(0, Math.min(100, packageUnpackUiState.percent))}%`,
                    }}
                  />
                </div>
              </div>
            ) : null}

            {sessionExportUiState.active ? (
              <div
                className="lt-source-prep-indicator"
                aria-live="polite"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(sessionExportUiState.percent)}
              >
                <div className="lt-source-prep-line">
                  <span className="lt-source-prep-label">
                    {sessionExportUiState.message ||
                      t("transport.shell.exportingSession", {
                        defaultValue: "Exportando sesión...",
                      })}
                  </span>
                  <span className="lt-source-prep-detail">
                    {Math.round(sessionExportUiState.percent)}%
                  </span>
                </div>
                <div className="lt-source-prep-bar">
                  <span
                    style={{
                      width: `${Math.max(0, Math.min(100, sessionExportUiState.percent))}%`,
                    }}
                  />
                </div>
              </div>
            ) : null}

            {sourcesPrepareUiState.active ? (
              <div
                className="lt-source-prep-indicator"
                aria-live="polite"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(sourcesPrepareUiState.percent)}
              >
                <div className="lt-source-prep-line">
                  <span className="lt-source-prep-label">
                    {t("transport.status.preparingAudio")}
                  </span>
                  <span className="lt-source-prep-detail">
                    {t("transport.status.tracksReady", {
                      ready: sourcesPrepareUiState.readyCount,
                      total: sourcesPrepareUiState.total,
                    })}{" "}
                    {Math.round(sourcesPrepareUiState.percent)}%
                  </span>
                </div>
                <div className="lt-source-prep-bar">
                  <span
                    style={{
                      width: `${Math.max(0, Math.min(100, sourcesPrepareUiState.percent))}%`,
                    }}
                  />
                </div>
                {sourcesPrepareUiState.failedCount > 0 ? (
                  <span className="lt-source-prep-failed">
                    {t("transport.status.sourcesFailed", {
                      count: sourcesPrepareUiState.failedCount,
                    })}
                  </span>
                ) : null}
              </div>
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
