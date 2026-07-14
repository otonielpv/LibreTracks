import {
  buildSongTempoRegions,
  getSongTempoRegionAtPosition,
  type ClipSummary,
  type LibraryAssetSummary,
  type SongView,
  type TransportSnapshot,
} from "@libretracks/shared/models";
import { confirmDialog } from "../../../shared/dialog/dialogService";
import {
  createAudioTracksWithClips,
  createClipsBatch,
  createClipsWithAutoTracks,
  createTrack,
  getSongView,
  importAudioFilesFromBytes,
  importAudioFilesFromPaths,
  importExternalProjectFromPathWithProgress,
  importSongPackageFromPathWithProgress,
  importStagedAudioFiles,
  isAndroidApp,
  isTauriApp,
  pickLibraryFiles,
} from "../desktopApi";
import {
  clientXToLocalX,
  screenXToSeconds,
  secondsToScreenX,
} from "../timeline/timelineMath";
import { snapToTimelineGrid } from "../timeline/useTimelineGrid";
import { useTransportStore } from "../store";
import {
  createPendingAudioImports,
  createPendingAudioImportsFromPaths,
  nextPaint,
  type PendingAudioImport,
  type TimelineTrackSummary,
} from "./pendingAudioImports";
import { pickFilesViaWebView, stageFileForImport } from "./mobileFilePicker";
import { runAudioImportPipeline } from "./importPipeline";
import {
  buildTimelineDropPreviewGeometry,
  classifyDroppedPaths,
  type DroppedFileClassification,
  type ExternalDropPreview,
  type NativeDroppedPathClassification,
} from "./dragDrop";
import {
  clamp,
  describeNativeDropElement,
  humanizeLibraryTrackName,
  libraryAssetFileName,
  formatClock,
  nativeClientPointCandidates,
  resolveNativeAudioImportPayloads,
  selectNativeDropCandidate,
  toNativeDropDebugRect,
} from "../helpers";
import {
  DOM_EXTERNAL_DROP_PREVIEW_TTL_MS,
  DRAG_THRESHOLD_PX,
  LIBRARY_DRAG_EDGE_BUFFER_PX,
  LIBRARY_DRAG_MAX_SCROLL_SPEED_PX,
  NATIVE_DND_DEBUG_ENABLED,
} from "../constants";
import type { TimelineGrid } from "../timeline/timelineMath";
import type {
  InternalLibraryPointerDrag,
  LibraryAssetDragPayload,
  LibraryClipPreviewState,
  LibraryDragAutoScrollState,
  LibraryDragHoverState,
  LibraryDropLayout,
  NativeClientPointCandidate,
  NativeDropCandidateDebug,
  NativeDroppedFile,
  TimelineDropGeometry,
} from "../types";

type Translate = (key: string, options?: Record<string, unknown>) => string;

type NativeDropCoordinateModeRef = { current: string | null };

/**
 * Dependencies for the library drag&drop + external-file-drop pipeline
 * extracted from TransportPanelContent. The factory is instantiated once
 * (useMemo []) and reads a fresh deps snapshot through `deps()` on every call,
 * so the returned handlers stay referentially stable while never capturing
 * stale state — the same ref-mirror pattern as the other extracted slices.
 */
export type LibraryDragDropDeps = {
  t: Translate;
  // reactive state / derived
  song: SongView | null;
  songBaseBpm: number;
  songBaseTimeSignature: string;
  snapEnabled: boolean;
  libraryAssets: LibraryAssetSummary[];
  visibleTracks: TimelineTrackSummary[];
  timelineGrid: TimelineGrid;
  externalDropPreview: ExternalDropPreview | null;
  // refs
  rulerTrackRef: { current: HTMLDivElement | null };
  laneAreaRef: { current: HTMLDivElement | null };
  timelineShellRef: { current: HTMLDivElement | null };
  timelineScrollViewportRef: { current: HTMLDivElement | null };
  cameraXRef: { current: number };
  liveZoomLevelRef: { current: number };
  livePixelsPerSecondRef: { current: number };
  nativeWebviewPositionRef: { current: { x: number; y: number } | null };
  nativeDropCoordinateModeRef: NativeDropCoordinateModeRef;
  nativeDropKindRef: { current: unknown };
  nativeExternalDropPathsRef: { current: string[] };
  domExternalDropPreviewUntilRef: { current: number };
  lastNativeTimelineDropRef: {
    current: {
      seconds: number;
      rawSeconds: number;
      snappedSeconds: number;
      previewClientX: number;
      snapApplied: boolean;
      coordinateMode: string;
    } | null;
  };
  internalLibraryPointerDragRef: { current: InternalLibraryPointerDrag | null };
  internalLibraryPointerDragListenersRef: {
    current: {
      move: (event: PointerEvent) => void;
      up: (event: PointerEvent) => void;
      cancel: (event: PointerEvent) => void;
      mouseMove: (event: MouseEvent) => void;
      mouseUp: (event: MouseEvent) => void;
      key: (event: KeyboardEvent) => void;
    } | null;
  };
  libraryDragHoverRef: { current: LibraryDragHoverState | null };
  activeLibraryDragPayloadRef: {
    current: LibraryAssetDragPayload[] | null;
  };
  libraryDragAutoScrollRef: { current: LibraryDragAutoScrollState };
  tracksByIdRef: { current: Record<string, { name: string }> };
  displayPositionSecondsRef: { current: number };
  playbackSongDirRef: { current: string | null };
  // setState
  setLibraryClipPreview: (next: LibraryClipPreviewState[]) => void;
  setInternalLibraryPointerDrag: (next: InternalLibraryPointerDrag | null) => void;
  setCompactDragPreview: (
    next:
      | { targetRegionId: string | null; count: number; isPackage: boolean }
      | null
      | ((
          current:
            | { targetRegionId: string | null; count: number; isPackage: boolean }
            | null,
        ) =>
          | { targetRegionId: string | null; count: number; isPackage: boolean }
          | null),
  ) => void;
  setNativeDropDebugCandidates: (next: NativeDropCandidateDebug[]) => void;
  setPackageUnpackUiState: (next: { active: boolean; percent: number }) => void;
  setExternalDropPreview: (
    next:
      | ExternalDropPreview
      | null
      | ((current: ExternalDropPreview | null) => ExternalDropPreview | null),
  ) => void;
  setSelectedSectionId: (next: string | null) => void;
  setStatus: (message: string) => void;
  // callbacks
  getCameraX: () => number;
  updateCameraX: (next: number, options?: Record<string, unknown>) => number;
  runAction: (
    work: () => Promise<void>,
    options?: { busy?: boolean },
  ) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  refreshSongView: (options?: {
    sync?: boolean;
    includeWaveforms?: boolean;
  }) => Promise<unknown>;
  formatErrorStatus: (error: unknown) => string;
  selectTrack: (trackIds: string[]) => void;
  mergeLibraryAssets: (assets: LibraryAssetSummary[]) => void;
  refreshLibraryState: (options?: {
    preserveAssets?: LibraryAssetSummary[];
  }) => Promise<LibraryAssetSummary[]>;
  startOptimisticClipOperation: (clips: ClipSummary[]) => string;
  completeOptimisticClipOperation: (
    operationId: string,
    revision: number,
  ) => void;
  discardOptimisticClipOperation: (operationId: string) => void;
  handleCompactDropLibraryAssetsIntoSong: (
    regionId: string,
    payload: { filePath: string; durationSeconds: number }[],
  ) => void;
  handleMoveLibraryAssets: (
    filePaths: string[],
    folderPath: string | null,
  ) => Promise<unknown>;
  runCompactSongPackageImport: (packagePath: string) => Promise<void>;
  assignAssetsToSongFolder: (
    songName: string,
    assets: LibraryAssetSummary[],
  ) => Promise<unknown>;
};

export function createLibraryDragDrop(getDeps: () => LibraryDragDropDeps) {
  const deps = getDeps;

  function resolveDraggedLibraryAsset(
    filePath: string,
    durationSeconds: number,
  ): LibraryAssetSummary {
    return (
      deps().libraryAssets.find((asset) => asset.filePath === filePath) ?? {
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

    const baseIndex = deps().visibleTracks.findIndex(
      (track) => track.id === targetTrackId,
    );
    if (baseIndex < 0) {
      return index === 0 ? targetTrackId : null;
    }

    return deps().visibleTracks[baseIndex + index]?.id ?? null;
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

  function getLibraryDragViewportElement(element: HTMLElement) {
    if (element.classList.contains("lt-track-lane")) {
      return element;
    }

    return deps().rulerTrackRef.current ?? element;
  }

  function getLibraryDragViewportBounds(element: HTMLElement) {
    return getLibraryDragViewportElement(element).getBoundingClientRect();
  }

  function snapTimelineDropSeconds(rawSeconds: number) {
    const candidates = deps().timelineGrid.markers
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

    const timingRegion = getSongTempoRegionAtPosition(deps().song, rawSeconds);
    return snapToTimelineGrid(
      rawSeconds,
      timingRegion?.bpm ?? deps().songBaseBpm,
      timingRegion?.timeSignature ?? deps().songBaseTimeSignature,
      deps().liveZoomLevelRef.current,
      deps().livePixelsPerSecondRef.current,
      buildSongTempoRegions(deps().song),
    );
  }

  function resolveLibraryDropSecondsAtClientX(
    clientX: number,
    element: HTMLElement,
  ) {
    const viewportElement = getLibraryDragViewportElement(element);
    const bounds = viewportElement.getBoundingClientRect();
    const viewportWidth = viewportElement.offsetWidth || bounds.width;
    const viewportX = clamp(
      clientXToLocalX(clientX, bounds, viewportElement.offsetWidth),
      0,
      viewportWidth,
    );
    const rawSeconds = screenXToSeconds(
      viewportX,
      deps().getCameraX(),
      deps().livePixelsPerSecondRef.current,
    );

    return deps().snapEnabled ? snapTimelineDropSeconds(rawSeconds) : rawSeconds;
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

    const viewportElement = getLibraryDragViewportElement(targetElement);
    const viewportBounds = viewportElement.getBoundingClientRect();
    const viewportWidth = viewportElement.offsetWidth || viewportBounds.width;
    const viewportX = clamp(
      clientXToLocalX(clientX, viewportBounds, viewportElement.offsetWidth),
      0,
      viewportWidth,
    );
    const rawSeconds = screenXToSeconds(
      viewportX,
      deps().getCameraX(),
      deps().livePixelsPerSecondRef.current,
    );
    const snappedSeconds = snapTimelineDropSeconds(rawSeconds);
    const previewGeometry = buildTimelineDropPreviewGeometry({
      clientX,
      viewportLeft: viewportBounds.left,
      viewportWidth: viewportBounds.width,
      viewportLayoutWidth: viewportWidth,
      cameraX: deps().getCameraX(),
      pixelsPerSecond: deps().livePixelsPerSecondRef.current,
      snappedSeconds,
      snapEnabled: deps().snapEnabled,
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
      deps().getCameraX(),
      deps().livePixelsPerSecondRef.current,
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

    deps().setLibraryClipPreview(
      buildLibraryClipPreview({
        payload: hoverState.payload,
        targetTrackId: hoverState.targetTrackId,
        timelineStartSeconds,
        layout,
      }),
    );
  }

  function stopLibraryDragAutoScroll() {
    const autoScrollState = deps().libraryDragAutoScrollRef.current;
    autoScrollState.horizontalVelocity = 0;
    autoScrollState.verticalVelocity = 0;

    if (autoScrollState.frameId !== null) {
      window.cancelAnimationFrame(autoScrollState.frameId);
      autoScrollState.frameId = null;
    }
  }

  function clearLibraryDragPreview() {
    deps().libraryDragHoverRef.current = null;
    stopLibraryDragAutoScroll();
    deps().setLibraryClipPreview([]);
  }

  function clearActiveLibraryDragPayload() {
    deps().activeLibraryDragPayloadRef.current = null;
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

    if (!deps().timelineShellRef.current?.contains(target)) {
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
        snapApplied: deps().snapEnabled,
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
    const rulerBounds = deps().rulerTrackRef.current?.getBoundingClientRect() ?? null;

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
        snapApplied: deps().snapEnabled,
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
      deps().nativeWebviewPositionRef.current,
    ).map(resolveNativeDropCandidate);

    if (NATIVE_DND_DEBUG_ENABLED) {
      console.debug("[native-dnd] candidates", {
        nativePosition: position,
        webviewPosition: deps().nativeWebviewPositionRef.current,
        cameraX: deps().getCameraX(),
        pixelsPerSecond: deps().livePixelsPerSecondRef.current,
        candidates,
      });
      deps().setNativeDropDebugCandidates(candidates);
    }

    const selectedCandidate = selectNativeDropCandidate(candidates);

    deps().nativeDropCoordinateModeRef.current = selectedCandidate?.label ?? null;

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
      snapApplied: deps().snapEnabled,
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

  // Detects a drop over the left track-headers column (the "track info"
  // sidebar). Dropping there is a shortcut for "place at the very start of
  // the timeline": over an existing header row it targets that track, and
  // over the empty area below the last row it leaves targetTrackId null so a
  // fresh track is auto-created. Either way the caller pins dropSeconds to 0.
  function resolveTrackHeadersDropFromClientPoint(
    clientX: number,
    clientY: number,
  ): { targetTrackId: string | null } | null {
    if (typeof document.elementFromPoint !== "function") {
      return null;
    }

    const target = document.elementFromPoint(clientX, clientY);
    if (!(target instanceof HTMLElement)) {
      return null;
    }

    const pane = target.closest(".lt-track-headers-pane");
    if (!(pane instanceof HTMLElement)) {
      return null;
    }

    // The ruler header ("Tracks") isn't a drop target — ignore it so a drop
    // there doesn't silently create a track at the top.
    if (target.closest(".lt-ruler-header")) {
      return null;
    }

    const headerRow = target.closest(".lt-track-header-row[data-track-id]");
    const targetTrackId =
      headerRow instanceof HTMLElement
        ? headerRow.getAttribute("data-track-id")
        : null;

    return { targetTrackId: targetTrackId ?? null };
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
    const autoScrollState = deps().libraryDragAutoScrollRef.current;
    const laneArea = deps().laneAreaRef.current;
    const verticalScrollViewport = deps().timelineScrollViewportRef.current;
    const hoverState = deps().libraryDragHoverRef.current;

    if (
      !hoverState ||
      (!autoScrollState.horizontalVelocity && !autoScrollState.verticalVelocity)
    ) {
      autoScrollState.frameId = null;
      return;
    }

    if (autoScrollState.horizontalVelocity) {
      deps().updateCameraX(deps().cameraXRef.current + autoScrollState.horizontalVelocity);
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
    const autoScrollState = deps().libraryDragAutoScrollRef.current;
    const horizontalBounds =
      deps().rulerTrackRef.current?.getBoundingClientRect() ??
      deps().timelineShellRef.current?.getBoundingClientRect();
    const verticalBounds =
      deps().timelineScrollViewportRef.current?.getBoundingClientRect();

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
    deps().internalLibraryPointerDragRef.current = next;
    deps().setInternalLibraryPointerDrag(next);
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
    const listeners = deps().internalLibraryPointerDragListenersRef.current;
    if (!listeners) {
      return;
    }

    window.removeEventListener("pointermove", listeners.move);
    window.removeEventListener("pointerup", listeners.up);
    window.removeEventListener("pointercancel", listeners.cancel);
    window.removeEventListener("mousemove", listeners.mouseMove);
    window.removeEventListener("mouseup", listeners.mouseUp);
    window.removeEventListener("keydown", listeners.key);
    window.removeEventListener("keyup", listeners.key);
    deps().internalLibraryPointerDragListenersRef.current = null;
  }

  function clearInternalLibraryPointerDrag() {
    stopInternalLibraryPointerDragListeners();
    clearLibraryDragPreview();
    clearActiveLibraryDragPayload();
    setInternalLibraryPointerDragState(null);
    deps().setCompactDragPreview(null);
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

    const headersTarget = resolveTrackHeadersDropFromClientPoint(
      args.clientX,
      args.clientY,
    );
    if (headersTarget) {
      const layout = resolveLibraryDropLayout(
        args.drag.payload,
        headersTarget.targetTrackId,
        args.ctrlKey,
        args.metaKey,
      );
      // Show the placement preview pinned at the timeline start instead of
      // following the cursor (the cursor is over the headers column, not a
      // lane, so there's no x→seconds mapping to honour here).
      deps().setLibraryClipPreview(
        buildLibraryClipPreview({
          payload: args.drag.payload,
          targetTrackId: headersTarget.targetTrackId,
          timelineStartSeconds: 0,
          layout,
        }),
      );
      deps().libraryDragHoverRef.current = null;
      stopLibraryDragAutoScroll();
      return {
        ...args.drag,
        hover: {
          kind: "timeline" as const,
          dropSeconds: 0,
          targetTrackId: headersTarget.targetTrackId,
          layout,
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

    const hoverState: LibraryDragHoverState = {
      clientX: args.clientX,
      clientY: args.clientY,
      ctrlKey: args.ctrlKey,
      metaKey: args.metaKey,
      payload: args.drag.payload,
      targetTrackId: hit.targetTrackId,
    };
    deps().libraryDragHoverRef.current = hoverState;
    updateLibraryClipPreview(hoverState, targetElement);
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

  // Recompute hover + drop layout from a cursor position and the live modifier
  // keys. Shared by pointer-move and by the keyboard handler so that pressing
  // or releasing Ctrl/Cmd while the cursor is stationary still flips the
  // in-line ↔ separate-tracks layout (the modifier changes the drop plan, not
  // just the cursor position).
  function refreshInternalLibraryDrag(args: {
    drag: InternalLibraryPointerDrag;
    clientX: number;
    clientY: number;
    ctrlKey: boolean;
    metaKey: boolean;
  }): InternalLibraryPointerDrag {
    const nextDrag = updateInternalLibraryPointerDragHover(args);

    // Compact-view drop preview: library items are never .ltpkg, so
    // we always emit isPackage=false and let the per-column handler
    // render `count` dashed placeholders.
    const hit = resolveCompactRegionAtPoint(args.clientX, args.clientY);
    if (hit.hit) {
      const count = nextDrag.payload.length;
      deps().setCompactDragPreview({
        targetRegionId: hit.regionId,
        count,
        isPackage: false,
      });
    } else {
      deps().setCompactDragPreview((current) => (current === null ? current : null));
    }

    return nextDrag;
  }

  function handleInternalLibraryPointerMove(event: PointerEvent) {
    const drag = deps().internalLibraryPointerDragRef.current;
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
      nextDrag = refreshInternalLibraryDrag({
        drag: nextDrag,
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
      });
    }

    setInternalLibraryPointerDragState(nextDrag);
  }

  function handleInternalLibraryPointerKey(event: KeyboardEvent) {
    // Only Ctrl/Cmd toggles the layout; ignore other keys to avoid needless
    // recomputation. The event fires for the key itself (Control/Meta) and for
    // any key while a modifier is held, so we gate on the modifier flags.
    if (event.key !== "Control" && event.key !== "Meta") {
      return;
    }
    const drag = deps().internalLibraryPointerDragRef.current;
    if (!drag || !drag.isDragging) {
      return;
    }
    const nextDrag = refreshInternalLibraryDrag({
      drag,
      clientX: drag.current.x,
      clientY: drag.current.y,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
    });
    setInternalLibraryPointerDragState(nextDrag);
  }

  function handleInternalLibraryPointerUp(event: PointerEvent) {
    const drag = deps().internalLibraryPointerDragRef.current;
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
        deps().handleCompactDropLibraryAssetsIntoSong(regionId, payload);
        return;
      }
    }

    if (!hover) {
      return;
    }

    if (hover.kind === "library-folder") {
      void deps().handleMoveLibraryAssets(
        nextDrag.payload.map((item) => item.file_path),
        hover.folderPath,
      );
      return;
    }

    void deps().runAction(async () => {
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

    deps().activeLibraryDragPayloadRef.current = args.payload;
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
    const key = (event: KeyboardEvent) => {
      handleInternalLibraryPointerKey(event);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("mousemove", mouseMove);
    window.addEventListener("mouseup", mouseUp);
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", key);
    deps().internalLibraryPointerDragListenersRef.current = {
      move,
      up,
      cancel,
      mouseMove,
      mouseUp,
      key,
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
        deps().applyPlaybackSnapshot(args.pendingTrackSnapshot);
      }
      return;
    }

    if (args.pendingTrackSnapshot) {
      deps().applyPlaybackSnapshot(args.pendingTrackSnapshot);
    }

    const optimisticOperationId = deps().startOptimisticClipOperation(
      args.placements.map((placement, index) => ({
        id: `optimistic-clip-${Date.now()}-${index}`,
        trackId: placement.trackId,
        trackName:
          deps().tracksByIdRef.current[placement.trackId]?.name ??
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
      deps().completeOptimisticClipOperation(
        optimisticOperationId,
        clipSnapshot.projectRevision,
      );
      deps().applyPlaybackSnapshot(clipSnapshot);
    } catch (error) {
      deps().discardOptimisticClipOperation(optimisticOperationId);
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
          deps().applyPlaybackSnapshot(pendingTrackSnapshot);
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

      deps().selectTrack([targetTrackId]);
    } else {
      // Vertical layout: one new track per asset. The first asset may instead
      // land on an existing `targetTrackId`. Both halves are single batched
      // calls (clip-onto-existing + new-tracks-with-clips), so dropping N
      // assets is two round-trips, not the 2N the per-asset loop once did —
      // which is what made a second batch drop appear track by track.
      let selectedTrackId: string | null = null;

      const reuseFirstTrack = Boolean(args.targetTrackId);
      if (reuseFirstTrack) {
        await commitLibraryClipPlacements({
          placements: [
            {
              asset: assets[0],
              trackId: args.targetTrackId as string,
              timelineStartSeconds: args.timelineStartSeconds,
            },
          ],
          pendingTrackSnapshot: null,
        });
        selectedTrackId = args.targetTrackId;
      }

      const newTrackAssets = reuseFirstTrack ? assets.slice(1) : assets;
      if (newTrackAssets.length) {
        const snapshot = await createAudioTracksWithClips(
          newTrackAssets.map((asset) => ({
            trackName: humanizeLibraryTrackName(asset.filePath),
            filePath: asset.filePath,
            timelineStartSeconds: args.timelineStartSeconds,
          })),
        );
        deps().applyPlaybackSnapshot(snapshot);
        const nextSong = await getSongView();
        selectedTrackId = nextSong?.tracks.at(-1)?.id ?? selectedTrackId;
      }

      if (selectedTrackId) {
        deps().selectTrack([selectedTrackId]);
      }
    }

    deps().setSelectedSectionId(null);
    deps().setStatus(
      assets.length === 1
        ? deps().t("transport.status.clipAdded", { name: assets[0].fileName })
        : deps().t("transport.status.clipsAdded", { count: assets.length }),
    );
  }

  async function handleDroppedSongPackagePath(
    packagePath: string,
    dropSeconds: number,
  ) {
    // Non-blocking .ltpkg import for every path-based entry point (compact view
    // picker, compact OS drag, timeline drop from the file explorer). The
    // backend returns as soon as the package is unzipped + the structure is
    // persisted — it no longer waits for source decode — so we do NOT raise the
    // blocking shell overlay. The new tracks appear immediately, waveforms fill
    // in as sources decode, and play is progressive (decoded head audible, rest
    // silent). The user keeps full use of the UI throughout, like the audio
    // import. (Previously this sat behind the busy overlay until every source
    // finished decoding.)
    // Show the non-modal "Descomprimiendo paquete…" indicator for the duration
    // (the percent is fed by the load-progress listener). Cleared in `finally`
    // whether the import succeeds, is cancelled, or throws.
    deps().setPackageUnpackUiState({ active: true, percent: 0 });
    try {
      const snapshot = await importSongPackageFromPathWithProgress(
        packagePath,
        dropSeconds,
      );
      if (!snapshot) {
        return;
      }
      // The backend only emits up to ~50% (decompress + merge); decode of the
      // sources is async and handed off to the "Preparing audio…" indicator. So
      // when the import call resolves the unpack phase is done — show 100% so it
      // doesn't visibly vanish at 40%. The refreshes below give it a frame to
      // paint before `finally` clears it.
      deps().setPackageUnpackUiState({ active: true, percent: 100 });
      deps().applyPlaybackSnapshot(snapshot);
      const refreshedAssets = await deps().refreshLibraryState();
      deps().mergeLibraryAssets(refreshedAssets);
      await deps().refreshSongView();
      deps().setStatus(
        deps().t("transport.status.packageImportedAt", {
          time: formatClock(dropSeconds),
        }),
      );
    } catch (error) {
      deps().setStatus(deps().formatErrorStatus(error));
    } finally {
      deps().setPackageUnpackUiState({ active: false, percent: 0 });
    }
  }

  // A Reaper/Ableton project dropped on the timeline from the OS file explorer.
  // Mirrors handleDroppedSongPackagePath (non-blocking, progress in the status
  // bar). The backend lands it at dropSeconds unless that overlaps an existing
  // song, in which case it appends after the setlist.
  async function handleDroppedExternalProjectPath(
    projectPath: string,
    dropSeconds: number,
  ) {
    deps().setPackageUnpackUiState({ active: true, percent: 0 });
    try {
      const snapshot = await importExternalProjectFromPathWithProgress(
        projectPath,
        dropSeconds,
      );
      if (!snapshot) {
        return;
      }
      deps().setPackageUnpackUiState({ active: true, percent: 100 });
      deps().applyPlaybackSnapshot(snapshot);
      const refreshedAssets = await deps().refreshLibraryState();
      deps().mergeLibraryAssets(refreshedAssets);
      await deps().refreshSongView({ sync: true });
      deps().setStatus(
        deps().t("transport.status.externalProjectImportedAt", {
          time: formatClock(dropSeconds),
          defaultValue: "Proyecto Reaper/Ableton importado en {{time}}.",
        }),
      );
    } catch (error) {
      deps().setStatus(deps().formatErrorStatus(error));
    } finally {
      deps().setPackageUnpackUiState({ active: false, percent: 0 });
    }
  }

  async function createRealTracksAndClipsForImportedAssets(args: {
    importedAssets: LibraryAssetSummary[];
    dropSeconds: number;
  }) {
    if (!args.importedAssets.length) {
      return;
    }

    // One track + one clip per asset, created in a SINGLE backend call. The old
    // per-asset create_track loop rebuilt the whole session once per asset, so
    // dropping onto an already-populated song scaled as N×(existing clips) and
    // showed tracks appearing one by one. See createAudioTracksWithClips.
    const snapshot = await createAudioTracksWithClips(
      args.importedAssets.map((asset) => ({
        trackName: humanizeLibraryTrackName(asset.filePath),
        filePath: asset.filePath,
        timelineStartSeconds: args.dropSeconds,
      })),
    );
    deps().applyPlaybackSnapshot(snapshot);

    // Select the last track the batch appended (the snapshot is transport-only,
    // so the track id comes from the refreshed song view — one call, not N).
    const nextSong = await getSongView();
    const lastNewTrackId = nextSong?.tracks.at(-1)?.id ?? null;
    if (lastNewTrackId) {
      deps().selectTrack([lastNewTrackId]);
    }

    deps().setSelectedSectionId(null);
  }

  async function startDroppedAudioImportJob(args: {
    files: File[];
    pendingImports: PendingAudioImport[];
    dropSeconds: number;
  }) {
    const { files, pendingImports, dropSeconds } = args;
    const pendingIds = pendingImports.map((item) => item.id);

    await nextPaint();

    const nativePayloads = isTauriApp
      ? resolveNativeAudioImportPayloads(files)
      : null;

    // Native paths import directly; the web/bytes path must read File bytes
    // first (status "reading") before importing.
    let bytesPayloads: { fileName: string; bytes: Uint8Array }[] | null = null;
    await runAudioImportPipeline({
      pendingIds,
      beforeImport: nativePayloads
        ? undefined
        : async () => {
            bytesPayloads = await Promise.all(
              files.map(async (file) => ({
                fileName: file.name,
                bytes: new Uint8Array(await file.arrayBuffer()),
              })),
            );
          },
      importFn: () =>
        nativePayloads
          ? importAudioFilesFromPaths(nativePayloads)
          : importAudioFilesFromBytes(bytesPayloads ?? []),
      onImported: (importedAssets) =>
        createRealTracksAndClipsForImportedAssets({
          importedAssets,
          dropSeconds,
        }),
      mergeLibraryAssets: deps().mergeLibraryAssets,
      refreshLibraryState: deps().refreshLibraryState,
      setStatus: deps().setStatus,
      successMessage: (importedAssets) =>
        importedAssets.length === 1
          ? deps().t("transport.status.clipAdded", {
              name: importedAssets[0].fileName,
            })
          : deps().t("transport.status.clipsAdded", { count: importedAssets.length }),
    });
  }

  function handleDroppedAudioFiles(files: File[], dropSeconds: number) {
    const pendingImports = createPendingAudioImports(files, dropSeconds);
    useTransportStore.getState().addPendingAudioImports(pendingImports);

    deps().setStatus(
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

    await runAudioImportPipeline({
      pendingIds,
      importFn: () =>
        importAudioFilesFromPaths(
          args.paths.map((path) => ({
            fileName: libraryAssetFileName(path),
            sourcePath: path,
          })),
        ),
      onImported: (importedAssets) =>
        createRealTracksAndClipsForImportedAssets({
          importedAssets,
          dropSeconds: args.dropSeconds,
        }),
      mergeLibraryAssets: deps().mergeLibraryAssets,
      refreshLibraryState: deps().refreshLibraryState,
      setStatus: deps().setStatus,
      successMessage: (importedAssets) =>
        importedAssets.length === 1
          ? deps().t("transport.status.clipAdded", {
              name: importedAssets[0].fileName,
            })
          : deps().t("transport.status.clipsAdded", { count: importedAssets.length }),
    });
  }

  function handleDroppedAudioPaths(paths: string[], dropSeconds: number) {
    const pendingImports = createPendingAudioImportsFromPaths(
      paths,
      dropSeconds,
    );
    useTransportStore.getState().addPendingAudioImports(pendingImports);

    deps().setStatus(
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

  // Library "import audio" button. Unified with drag-and-drop: pick paths, show
  // the same per-file "analyzing" placeholders, and run the shared pipeline —
  // but WITHOUT the timeline tail (library-only, no tracks/clips created).
  async function handleImportLibraryFromDialog() {
    if (!deps().playbackSongDirRef.current) {
      deps().setStatus(deps().t("transport.status.importRequiresSession"));
      return;
    }

    // Android: no rfd paths — the WebView chooser hands us the file CONTENTS
    // (Android files live behind content:// URIs the Rust side can't read).
    // Same placeholder pipeline as below, importing bytes instead of paths,
    // plus a one-tap "put the imported files on the timeline" prompt (the
    // usual mobile intent behind importing a song's multitracks). NOTE: the
    // chooser only opens inside the tap's user-gesture window, so the pick
    // must be the first thing this function does — no awaits before it.
    if (isAndroidApp) {
      const files = await pickFilesViaWebView("audio/*");
      if (!files.length) {
        return; // user cancelled
      }

      const pendingImports = createPendingAudioImports(files, 0).map(
        (item) => ({ ...item, showInTimeline: false }),
      );
      useTransportStore.getState().addPendingAudioImports(pendingImports);
      deps().setStatus(deps().t("transport.status.libraryImportStarting"));
      await nextPaint();

      // Stage sequentially: one in-flight slice at a time keeps the WebView
      // renderer's heap flat — reading whole files into Uint8Arrays here
      // OOM-crashed the renderer on low-RAM phones.
      const stagedPayloads: Array<{ fileName: string; sourcePath: string }> =
        [];
      await runAudioImportPipeline({
        pendingIds: pendingImports.map((item) => item.id),
        beforeImport: async () => {
          for (let index = 0; index < files.length; index += 1) {
            const file = files[index];
            stagedPayloads.push({
              fileName: file.name,
              sourcePath: await stageFileForImport(file, index === 0),
            });
          }
        },
        importFn: () => importStagedAudioFiles(stagedPayloads),
        onImported: async (importedAssets) => {
          if (importedAssets.length === 0) {
            return;
          }
          const shouldPlace = await confirmDialog(
            deps().t("library.addImportedToTimelinePrompt", {
              count: importedAssets.length,
              defaultValue:
                "¿Añadir los {{count}} audios importados al timeline?",
            }),
          );
          if (!shouldPlace) {
            return;
          }
          const startSeconds = deps().displayPositionSecondsRef.current;
          const snapshot = await createClipsWithAutoTracks(
            importedAssets.map((asset) => ({
              filePath: asset.filePath,
              timelineStartSeconds: startSeconds,
            })),
          );
          deps().applyPlaybackSnapshot(snapshot);
        },
        mergeLibraryAssets: deps().mergeLibraryAssets,
        refreshLibraryState: deps().refreshLibraryState,
        setStatus: deps().setStatus,
        successMessage: (importedAssets) =>
          deps().t("transport.status.libraryUpdated", {
            count: importedAssets.length,
          }),
      });
      return;
    }

    const paths = await pickLibraryFiles();
    if (!paths.length) {
      return; // user cancelled
    }

    // showInTimeline = false: this is a library-only import. The placeholder
    // shows in the library list (analyzing feedback) but must NOT render a
    // track/clip in the timeline, or clips flash in at position 0 and vanish.
    const pendingImports = createPendingAudioImportsFromPaths(paths, 0, false);
    useTransportStore.getState().addPendingAudioImports(pendingImports);
    deps().setStatus(deps().t("transport.status.libraryImportStarting"));
    await nextPaint();

    await runAudioImportPipeline({
      pendingIds: pendingImports.map((item) => item.id),
      importFn: () =>
        importAudioFilesFromPaths(
          paths.map((path) => ({
            fileName: libraryAssetFileName(path),
            sourcePath: path,
          })),
        ),
      // No onImported tail: library import does not create timeline clips.
      mergeLibraryAssets: deps().mergeLibraryAssets,
      refreshLibraryState: deps().refreshLibraryState,
      setStatus: deps().setStatus,
      successMessage: (importedAssets) =>
        deps().t("transport.status.libraryUpdated", { count: importedAssets.length }),
    });
  }

  function rejectExternalDrop(kind: DroppedFileClassification["kind"]) {
    deps().setStatus(
      kind === "mixed"
        ? deps().t("transport.status.externalDropMixed")
        : deps().t("transport.status.externalDropUnsupported"),
    );
  }

  function handleExternalTimelineDrop(
    classification: DroppedFileClassification,
    dropSeconds: number,
  ) {
    deps().setExternalDropPreview(null);
    deps().nativeDropKindRef.current = null;
    deps().domExternalDropPreviewUntilRef.current = 0;
    deps().lastNativeTimelineDropRef.current = null;

    if (
      classification.kind === "mixed" ||
      classification.kind === "unsupported"
    ) {
      rejectExternalDrop(classification.kind);
      return;
    }

    if (classification.kind === "package") {
      // Non-blocking: no `busy: true`. The package import decompresses off the
      // session lock and reports progress in the status bar; raising the shell
      // overlay would freeze the UI behind the "Descomprimiendo…" screen for a
      // large package — the very thing we're avoiding. Matches the file-menu /
      // compact import entry points.
      void deps().runAction(async () => {
        const packagePath = (
          classification.packageFile as NativeDroppedFile | null
        )?.path?.trim();
        if (!packagePath) {
          rejectExternalDrop("unsupported");
          return;
        }

        await handleDroppedSongPackagePath(packagePath, dropSeconds);
      });
      return;
    }

    if (classification.kind === "external") {
      void deps().runAction(async () => {
        const projectPath = (
          classification.externalFile as NativeDroppedFile | null
        )?.path?.trim();
        if (!projectPath) {
          rejectExternalDrop("unsupported");
          return;
        }

        await handleDroppedExternalProjectPath(projectPath, dropSeconds);
      });
      return;
    }

    handleDroppedAudioFiles(classification.audioFiles, dropSeconds);
  }

  function handleNativeExternalTimelineDrop(
    classification: NativeDroppedPathClassification,
    dropSeconds: number,
  ) {
    deps().setExternalDropPreview(null);
    deps().setCompactDragPreview(null);
    deps().nativeExternalDropPathsRef.current = [];
    deps().nativeDropKindRef.current = null;
    deps().domExternalDropPreviewUntilRef.current = 0;
    deps().lastNativeTimelineDropRef.current = null;
    deps().nativeDropCoordinateModeRef.current = null;
    if (NATIVE_DND_DEBUG_ENABLED) {
      deps().setNativeDropDebugCandidates([]);
    }

    if (
      classification.kind === "mixed" ||
      classification.kind === "unsupported"
    ) {
      rejectExternalDrop(classification.kind);
      return;
    }

    if (classification.kind === "package") {
      // Non-blocking (no `busy: true`) — see handleExternalTimelineDrop. The
      // import runs off the session lock and must not raise the shell overlay.
      void deps().runAction(async () => {
        await handleDroppedSongPackagePath(
          classification.packagePath,
          dropSeconds,
        );
      });
      return;
    }

    if (classification.kind === "external") {
      void deps().runAction(async () => {
        await handleDroppedExternalProjectPath(
          classification.externalPath,
          dropSeconds,
        );
      });
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
      deps().nativeExternalDropPathsRef.current = args.paths;
    }

    const paths = args.paths?.length
      ? args.paths
      : deps().nativeExternalDropPathsRef.current;
    const kind = paths.length ? classifyDroppedPaths(paths).kind : "unknown";
    deps().nativeDropKindRef.current = kind;

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
        deps().setCompactDragPreview((current) =>
          current === null ? current : null,
        );
        deps().setExternalDropPreview(null);
        return;
      }
      const count = paths.length || 1;
      deps().setCompactDragPreview({
        targetRegionId: isPackage ? null : compactHit.regionId,
        count,
        isPackage,
      });
      // Clear any lingering timeline preview so the two views don't
      // both light up while the pointer is over the compact strip.
      deps().setExternalDropPreview(null);
      return;
    }
    deps().setCompactDragPreview((current) => (current === null ? current : null));

    if (Date.now() < deps().domExternalDropPreviewUntilRef.current) {
      deps().setExternalDropPreview((current) => {
        if (!current) {
          return current;
        }

        deps().lastNativeTimelineDropRef.current = {
          seconds: current.seconds,
          rawSeconds: current.rawSeconds ?? current.seconds,
          snappedSeconds: current.snappedSeconds ?? current.seconds,
          previewClientX: current.previewClientX ?? 0,
          snapApplied: current.snapApplied ?? false,
          coordinateMode: deps().nativeDropCoordinateModeRef.current ?? "raw/dpr",
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
      deps().setExternalDropPreview(null);
      deps().domExternalDropPreviewUntilRef.current = 0;
      deps().lastNativeTimelineDropRef.current = null;
      return;
    }

    if (
      hit.rawSeconds != null &&
      hit.snappedSeconds != null &&
      hit.previewClientX != null &&
      hit.coordinateMode != null
    ) {
      deps().lastNativeTimelineDropRef.current = {
        seconds: hit.dropSeconds,
        rawSeconds: hit.rawSeconds,
        snappedSeconds: hit.snappedSeconds,
        previewClientX: hit.previewClientX,
        snapApplied: hit.snapApplied,
        coordinateMode: hit.coordinateMode,
      };
    }

    deps().setExternalDropPreview({
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

    deps().nativeExternalDropPathsRef.current = [];
    deps().nativeDropKindRef.current = null;
    deps().setCompactDragPreview(null);

    if (!args.paths.length) {
      deps().domExternalDropPreviewUntilRef.current = 0;
      deps().lastNativeTimelineDropRef.current = null;
      deps().nativeDropCoordinateModeRef.current = null;
      deps().setExternalDropPreview(null);
      if (NATIVE_DND_DEBUG_ENABLED) {
        deps().setNativeDropDebugCandidates([]);
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
        // Non-blocking (no `busy: true`) — the import decompresses off the
        // session lock and reports progress in the status bar; the shell
        // overlay would freeze the UI for a large package. Matches the other
        // .ltpkg entry points.
        void deps().runAction(async () =>
          deps().runCompactSongPackageImport(classification.packagePath),
        );
        return;
      }
      if (classification.kind === "audio" && compactHit.regionId) {
        // Route native paths straight through the same importer the
        // OS-File handler uses, but without round-tripping through a
        // synthetic File (which wouldn't carry the .path needed by
        // resolveNativeAudioImportPayloads under Tauri).
        const regionId = compactHit.regionId;
        const region = deps().song?.regions.find((r) => r.id === regionId);
        if (!region) return;
        const dropSeconds = region.startSeconds;
        void deps().runAction(async () => {
          const payloads = classification.audioPaths.map((path) => ({
            fileName: path.split(/[\\/]/).pop() ?? path,
            sourcePath: path,
          }));
          const importedAssets = await importAudioFilesFromPaths(payloads);
          deps().mergeLibraryAssets(importedAssets);
          await deps().refreshLibraryState({ preserveAssets: importedAssets });
          if (importedAssets.length === 0) return;
          // Auto-organise: drop the freshly imported assets into the
          // song's Library folder (creating it if needed).
          await deps().assignAssetsToSongFolder(region.name, importedAssets);
          const snapshot = await createClipsWithAutoTracks(
            importedAssets.map((asset) => ({
              filePath: asset.filePath,
              timelineStartSeconds: dropSeconds,
            })),
          );
          deps().applyPlaybackSnapshot(snapshot);
          deps().setStatus(
            importedAssets.length === 1
              ? deps().t("transport.status.clipAdded", {
                  name: importedAssets[0].fileName,
                })
              : deps().t("transport.status.clipsAdded", {
                  count: importedAssets.length,
                }),
          );
        });
        return;
      }
      if (classification.kind === "external") {
        // A Reaper/Ableton project dropped on the compact strip imports as a
        // song appended to the setlist (the drop position has no meaning on the
        // strip, so the backend's overlap fallback lands it at the end).
        void deps().runAction(async () =>
          handleDroppedExternalProjectPath(
            classification.externalPath,
            deps().song?.durationSeconds ?? 0,
          ),
        );
        return;
      }
      // mixed / unsupported / package-but-no-region (theoretically
      // impossible because the strip always has at least the action
      // buttons inside it) → reject with a status toast.
      deps().setStatus(
        deps().t("transport.status.unsupportedDrop", {
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
      deps().externalDropPreview === null &&
      deps().lastNativeTimelineDropRef.current === null
    ) {
      deps().lastNativeTimelineDropRef.current = null;
      deps().nativeDropCoordinateModeRef.current = null;
      deps().setExternalDropPreview(null);
      if (NATIVE_DND_DEBUG_ENABLED) {
        deps().setNativeDropDebugCandidates([]);
      }
      return;
    }

    const dropSeconds =
      deps().lastNativeTimelineDropRef.current?.seconds ??
      deps().externalDropPreview?.seconds ??
      hit.dropSeconds;

    handleNativeExternalTimelineDrop(
      classifyDroppedPaths(args.paths),
      dropSeconds,
    );
  }

  function handleDomExternalDropPreviewChange(
    preview: ExternalDropPreview | null,
  ) {
    deps().domExternalDropPreviewUntilRef.current =
      preview === null ? 0 : Date.now() + DOM_EXTERNAL_DROP_PREVIEW_TTL_MS;

    if (preview !== null) {
      deps().lastNativeTimelineDropRef.current = {
        seconds: preview.seconds,
        rawSeconds: preview.rawSeconds ?? preview.seconds,
        snappedSeconds: preview.snappedSeconds ?? preview.seconds,
        previewClientX: preview.previewClientX ?? 0,
        snapApplied: preview.snapApplied ?? false,
        coordinateMode: deps().nativeDropCoordinateModeRef.current ?? "raw/dpr",
      };
    }

    deps().setExternalDropPreview(preview);
  }


  return {
    resolveDraggedLibraryAsset,
    resolveLibraryGhostLeft,
    resolveTimelineDropFromClientPoint,
    resolveTimelineDropFromNativePosition,
    resolveLibraryAutoScrollVelocity,
    resolveCompactRegionAtPoint,
    updateLibraryClipPreview,
    stopLibraryDragAutoScroll,
    clearLibraryDragPreview,
    clearActiveLibraryDragPayload,
    stopInternalLibraryPointerDragListeners,
    clearInternalLibraryPointerDrag,
    startInternalLibraryPointerDrag,
    placeLibraryAssetsOnTimeline,
    handleDroppedSongPackagePath,
    handleDroppedExternalProjectPath,
    handleDroppedAudioFiles,
    handleDroppedAudioPaths,
    handleImportLibraryFromDialog,
    handleExternalTimelineDrop,
    handleNativeExternalTimelineDrop,
    handleNativeFileDragOver,
    handleNativeFileDrop,
    handleDomExternalDropPreviewChange,
  };
}

export type LibraryDragDrop = ReturnType<typeof createLibraryDragDrop>;
