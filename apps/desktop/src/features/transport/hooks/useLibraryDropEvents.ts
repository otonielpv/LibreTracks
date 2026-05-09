import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type {
  ExternalDropPreview,
  DroppedFileClassification,
  NativeDroppedPathClassification,
} from "../dragDrop";
import { classifyDroppedPaths } from "../dragDrop";
import type {
  InternalLibraryPointerDrag,
  LibraryAssetDragPayload,
  LibraryClipPreviewState,
  LibraryDragAutoScrollState,
  LibraryDragHoverState,
  NativeDropCandidateDebug,
  NativeDropCoordinateMode,
  NativeDroppedFile,
} from "../types";
import {
  DRAG_THRESHOLD_PX,
  DOM_EXTERNAL_DROP_PREVIEW_TTL_MS,
  LIBRARY_DRAG_EDGE_BUFFER_PX,
  LIBRARY_DRAG_MAX_SCROLL_SPEED_PX,
  NATIVE_DND_DEBUG_ENABLED,
} from "../constants";

type GeometryFns = {
  updateLibraryClipPreview: (
    hoverState: LibraryDragHoverState,
    element: HTMLElement,
  ) => void;
  resolveLibraryFolderDropFromClientPoint: (
    clientX: number,
    clientY: number,
  ) => { folderPath: string | null } | null;
  resolveTimelineDropFromClientPoint: (
    clientX: number,
    clientY: number,
  ) => {
    isOverTimeline: boolean;
    dropSeconds: number;
    targetTrackId: string | null;
    previewLeftPx: number | null;
    previewClientX: number | null;
    rawSeconds: number | null;
    snappedSeconds: number | null;
    snapApplied: boolean;
  };
  resolveTimelineDropTargetAtClientPoint: (
    clientX: number,
    clientY: number,
  ) => HTMLDivElement | null;
  resolveLibraryDropLayout: (
    payload: LibraryAssetDragPayload[],
    targetTrackId: string | null,
    ctrlKey: boolean,
    metaKey: boolean,
  ) => "horizontal" | "vertical";
  resolveTimelineDropFromNativePosition: (position: {
    x: number;
    y: number;
  }) => {
    isOverTimeline: boolean;
    dropSeconds: number;
    targetTrackId: string | null;
    previewLeftPx: number | null;
    previewClientX: number | null;
    rawSeconds: number | null;
    snappedSeconds: number | null;
    snapApplied: boolean;
    coordinateMode?: string | null;
  };
};

type UseLibraryDropEventsProps = GeometryFns & {
  libraryDragHoverRef: MutableRefObject<LibraryDragHoverState | null>;
  activeLibraryDragPayloadRef: MutableRefObject<LibraryAssetDragPayload[] | null>;
  internalLibraryPointerDragRef: MutableRefObject<InternalLibraryPointerDrag | null>;
  internalLibraryPointerDragListenersRef: MutableRefObject<{
    move: (event: PointerEvent) => void;
    up: (event: PointerEvent) => void;
    cancel: (event: PointerEvent) => void;
    mouseMove: (event: MouseEvent) => void;
    mouseUp: (event: MouseEvent) => void;
  } | null>;
  libraryDragAutoScrollRef: MutableRefObject<LibraryDragAutoScrollState>;
  nativeExternalDropPathsRef: MutableRefObject<string[]>;
  nativeDropKindRef: MutableRefObject<string | null>;
  domExternalDropPreviewUntilRef: MutableRefObject<number>;
  lastNativeTimelineDropRef: MutableRefObject<{
    seconds: number;
    rawSeconds: number;
    snappedSeconds: number;
    previewClientX: number;
    snapApplied: boolean;
    coordinateMode: NativeDropCoordinateMode;
  } | null>;
  laneAreaRef: MutableRefObject<HTMLDivElement | null>;
  timelineScrollViewportRef: MutableRefObject<HTMLDivElement | null>;
  rulerTrackRef: MutableRefObject<HTMLDivElement | null>;
  timelineShellRef: MutableRefObject<HTMLDivElement | null>;
  nativeDropCoordinateModeRef: MutableRefObject<NativeDropCoordinateMode | null>;
  externalDropPreview: ExternalDropPreview | null;
  snapEnabled: boolean;
  setInternalLibraryPointerDrag: Dispatch<SetStateAction<InternalLibraryPointerDrag | null>>;
  setExternalDropPreview: Dispatch<SetStateAction<ExternalDropPreview | null>>;
  setNativeDropDebugCandidates: Dispatch<SetStateAction<NativeDropCandidateDebug[]>>;
  setLibraryClipPreview: Dispatch<SetStateAction<LibraryClipPreviewState[]>>;
  cameraXRef: MutableRefObject<number>;
  updateCameraX: (nextCameraX: number, options?: Record<string, unknown>) => number;
  handleMoveLibraryAssets: (
    filePaths: string[],
    newFolderPath: string | null,
  ) => Promise<void>;
  placeLibraryAssetsOnTimeline: (args: {
    payload: Array<{ file_path: string; durationSeconds: number }>;
    timelineStartSeconds: number;
    targetTrackId: string | null;
    layout: "horizontal" | "vertical";
  }) => Promise<void>;
  handleDroppedAudioFiles: (files: File[], dropSeconds: number) => void;
  handleDroppedAudioPaths: (paths: string[], dropSeconds: number) => void;
  handleDroppedSongPackagePath: (
    packagePath: string,
    dropSeconds: number,
  ) => Promise<void>;
  runAction: (
    work: () => Promise<void>,
    options?: { busy?: boolean },
  ) => Promise<void>;
  setStatus: (status: string) => void;
  t: TFunction;
};

export function useLibraryDropEvents({
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
}: UseLibraryDropEventsProps) {
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

  function resolveLibraryAutoScrollVelocity(distancePx: number): number {
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
      return { ...args.drag, hover: null };
    }

    const targetElement = resolveTimelineDropTargetAtClientPoint(
      args.clientX,
      args.clientY,
    );
    if (!targetElement) {
      clearLibraryDragPreview();
      return { ...args.drag, hover: null };
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
      current: { x: event.clientX, y: event.clientY },
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
        drag: { ...drag, current: { x: event.clientX, y: event.clientY } },
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
      });
    }

    const hover = nextDrag.hover;
    clearInternalLibraryPointerDrag();

    if (!nextDrag.isDragging || !hover) {
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
        return { ...current, kind };
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
        coordinateMode: hit.coordinateMode as NativeDropCoordinateMode,
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

  return {
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
  };
}
