import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type {
  LibraryAssetSummary,
  SongView,
} from "@libretracks/shared/models";
import {
  buildSongTempoRegions,
  getSongTempoRegionAtPosition,
} from "@libretracks/shared/models";
import { screenXToSeconds, secondsToScreenX } from "../timelineMath";
import { snapToTimelineGrid, type TimelineGrid } from "../useTimelineGrid";
import { buildTimelineDropPreviewGeometry } from "../dragDrop";
import type {
  LibraryAssetDragPayload,
  LibraryClipPreviewState,
  LibraryDragHoverState,
  LibraryDropLayout,
  NativeClientPointCandidate,
  NativeDropCandidateDebug,
  NativeDropCoordinateMode,
  TimelineDropGeometry,
} from "../types";
import {
  clamp,
  describeNativeDropElement,
  libraryAssetFileName,
  nativeClientPointCandidates,
  selectNativeDropCandidate,
  toNativeDropDebugRect,
} from "../helpers";
import { NATIVE_DND_DEBUG_ENABLED } from "../constants";
import type { TimelineTrackSummary } from "../pendingAudioImports";

export type UseLibraryDragGeometryProps = {
  libraryAssets: LibraryAssetSummary[];
  visibleTracks: TimelineTrackSummary[];
  timelineGrid: TimelineGrid;
  song: SongView | null;
  songBaseBpm: number;
  songBaseTimeSignature: string;
  snapEnabled: boolean;
  liveZoomLevelRef: MutableRefObject<number>;
  livePixelsPerSecondRef: MutableRefObject<number>;
  cameraXRef: MutableRefObject<number>;
  rulerTrackRef: MutableRefObject<HTMLDivElement | null>;
  timelineShellRef: MutableRefObject<HTMLDivElement | null>;
  nativeWebviewPositionRef: MutableRefObject<{ x: number; y: number } | null>;
  nativeDropCoordinateModeRef: MutableRefObject<NativeDropCoordinateMode | null>;
  getCameraX: () => number;
  setLibraryClipPreview: Dispatch<SetStateAction<LibraryClipPreviewState[]>>;
  setNativeDropDebugCandidates: Dispatch<SetStateAction<NativeDropCandidateDebug[]>>;
  t: TFunction;
};

export function useLibraryDragGeometry({
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
}: UseLibraryDragGeometryProps) {
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
  ): LibraryDropLayout {
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
  ): string | null {
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
  }): LibraryClipPreviewState[] {
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

  function getLibraryDragViewportBounds(element: HTMLElement): DOMRect {
    if (element.classList.contains("lt-track-lane")) {
      return element.getBoundingClientRect();
    }
    return (
      rulerTrackRef.current?.getBoundingClientRect() ??
      element.getBoundingClientRect()
    );
  }

  function snapTimelineDropSeconds(rawSeconds: number): number {
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
  ): number {
    const bounds = getLibraryDragViewportBounds(element);
    const viewportX = clamp(clientX - bounds.left, 0, bounds.width);
    const rawSeconds = screenXToSeconds(
      viewportX,
      getCameraX(),
      livePixelsPerSecondRef.current,
    );
    return snapEnabled ? snapTimelineDropSeconds(rawSeconds) : rawSeconds;
  }

  function getClientElementAtPoint(
    clientX: number,
    clientY: number,
  ): HTMLElement | null {
    if (typeof document.elementFromPoint !== "function") {
      return null;
    }
    const target = document.elementFromPoint(clientX, clientY);
    return target instanceof HTMLElement ? target : null;
  }

  function resolveTimelineDropTargetAtClientPoint(
    clientX: number,
    clientY: number,
  ): HTMLDivElement | null {
    const target = getClientElementAtPoint(clientX, clientY);
    if (!(target instanceof HTMLElement)) {
      return null;
    }
    if (!timelineShellRef.current?.contains(target)) {
      return null;
    }
    return target.closest(
      ".lt-track-lane, .lt-track-list, .lt-track-list-dropzone, .lt-empty-arrangement-dropzone",
    ) as HTMLDivElement | null;
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

  function resolveLibraryGhostLeft(timelineStartSeconds: number): number {
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

  function scoreNativeDropCandidate(candidate: NativeDropCandidateDebug): number {
    if (!candidate.isOverTimeline) {
      return 0;
    }
    let score = 100;
    if (candidate.elementFromPoint?.includes(".lt-track-lane")) {
      score += 200;
    } else if (
      candidate.elementFromPoint?.includes(".lt-empty-arrangement-dropzone") ||
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
    const rawElement = getClientElementAtPoint(candidate.clientX, candidate.clientY);
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
  ): { folderPath: string | null } | null {
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

  return {
    resolveDraggedLibraryAsset,
    resolveLibraryDropLayout,
    resolveLibraryPreviewTrackId,
    buildLibraryClipPreview,
    getLibraryDragViewportBounds,
    snapTimelineDropSeconds,
    resolveLibraryDropSecondsAtClientX,
    resolveTimelineDropGeometryFromClientPoint,
    resolveLibraryGhostLeft,
    updateLibraryClipPreview,
    getClientElementAtPoint,
    resolveTimelineDropTargetAtClientPoint,
    resolveTimelineDropFromClientPoint,
    scoreNativeDropCandidate,
    resolveNativeDropCandidate,
    resolveTimelineDropFromNativePosition,
    resolveLibraryFolderDropFromClientPoint,
  };
}
