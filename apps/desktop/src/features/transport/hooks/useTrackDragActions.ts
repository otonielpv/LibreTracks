import { useCallback, useEffect } from "react";
import type { MutableRefObject } from "react";
import type { SongView, TrackSummary, TransportSnapshot } from "@libretracks/shared/models";
import {
  buildSongTempoRegions,
  getSongTempoRegionAtPosition,
} from "@libretracks/shared/models";
import { moveClip, moveTrack } from "../desktopApi";
import type { TFunction } from "i18next";
import type { ClipDragState, TimelinePanState, TrackDragState, TrackDropState } from "../types";
import { useTimelineUIStore } from "../uiStore";
import {
  clamp,
  findClip,
  resolveTrackDropState,
} from "../helpers";
import { snapToTimelineGrid } from "../useTimelineGrid";
import { DRAG_THRESHOLD_PX } from "../constants";

type UseTrackDragActionsProps = {
  timelineShellRef: MutableRefObject<HTMLDivElement | null>;
  draggedTrackRowRef: MutableRefObject<HTMLDivElement | null>;
  draggedTrackRowsRef: MutableRefObject<HTMLDivElement[]>;
  draggedTrackHeadersRef: MutableRefObject<HTMLElement[]>;
  droppedTrackRowRef: MutableRefObject<HTMLDivElement | null>;
  trackDropStateRef: MutableRefObject<TrackDropState>;
  clipDragRef: MutableRefObject<ClipDragState>;
  trackDragRef: MutableRefObject<TrackDragState>;
  clipPreviewSecondsRef: MutableRefObject<Record<string, number>>;
  suppressTrackClickRef: MutableRefObject<boolean>;
  timelinePanRef: MutableRefObject<TimelinePanState>;
  livePixelsPerSecondRef: MutableRefObject<number>;
  liveZoomLevelRef: MutableRefObject<number>;
  songRef: MutableRefObject<SongView | null>;
  song: SongView | null;
  tracksById: Record<string, TrackSummary>;
  snapEnabled: boolean;
  zoomLevel: number;
  runAction: (work: () => Promise<void>) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  refreshSongView: () => Promise<unknown>;
  performSeek: (positionSeconds: number) => Promise<void>;
  restoreConfirmedTransportVisual: () => void;
  queueClipMoveLiveUpdate: (clipId: string, seconds: number) => void;
  waitForClipMoveLiveIdle: (clipId: string) => Promise<void>;
  setStatus: (status: string) => void;
  t: TFunction;
};

export function useTrackDragActions({
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
}: UseTrackDragActionsProps) {
  const selectedTrackIds = useTimelineUIStore((state) => state.selectedTrackIds);

  const clearTrackDragVisuals = useCallback(() => {
    draggedTrackRowsRef.current.forEach((row) => {
      row.style.transform = "";
      row.style.zIndex = "";
      row.style.pointerEvents = "";
    });

    draggedTrackHeadersRef.current.forEach((header) => {
      header.classList.remove("is-dragging");
    });

    const dropTargets =
      timelineShellRef.current?.querySelectorAll(".is-drop-target");
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
  }, [draggedTrackRowRef, draggedTrackRowsRef, draggedTrackHeadersRef, droppedTrackRowRef, timelineShellRef, trackDropStateRef]);

  const applyTrackDragVisuals = useCallback(
    (dragState: NonNullable<TrackDragState>, dropState: TrackDropState) => {
      const deltaY = dragState.currentClientY - dragState.startClientY;

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

        dragTrackIds.forEach((trackId) => {
          const matchingRows = timelineShellRef.current?.querySelectorAll(
            `.lt-track-header-row[data-track-id="${trackId}"], .lt-track-lane-row[data-track-id="${trackId}"]`,
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
        row.style.transform = `translate3d(0, ${deltaY}px, 0)`;
        row.style.zIndex = "8";
        row.style.pointerEvents = "none";
      });

      draggedTrackHeadersRef.current.forEach((header) => {
        header.classList.add("is-dragging");
      });

      const dropTargets =
        timelineShellRef.current?.querySelectorAll(".is-drop-target");
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
        const nextDropRows = timelineShellRef.current?.querySelectorAll(
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
    [clearTrackDragVisuals, selectedTrackIds, draggedTrackRowRef, draggedTrackRowsRef, draggedTrackHeadersRef, droppedTrackRowRef, timelineShellRef, trackDropStateRef],
  );

  async function handleTrackDrop(
    draggedTrackId: string,
    dropState: NonNullable<TrackDropState>,
  ) {
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
      setStatus(
        t("transport.status.tracksReordered", { count: tracksToMove.length }),
      );
    });
  }

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
        const deltaSeconds =
          (event.clientX - clipDrag.startClientX) / effectPixelsPerSecond;
        const timingRegion = getSongTempoRegionAtPosition(
          effectSong,
          clipDrag.originSeconds + deltaSeconds,
        );
        const nextSeconds = snapEnabled
          ? snapToTimelineGrid(
              clipDrag.originSeconds + deltaSeconds,
              timingRegion?.bpm ?? effectSong.bpm,
              timingRegion?.timeSignature ?? effectSong.timeSignature,
              liveZoomLevelRef.current,
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
        clipPreviewSecondsRef.current = {
          [nextDrag.clipId]: nextDrag.previewSeconds,
        };
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
          Math.abs(event.clientX - activeClipDrag.startClientX) >
            DRAG_THRESHOLD_PX;
        if (movedEnough) {
          queueClipMoveLiveUpdate(
            activeClipDrag.clipId,
            activeClipDrag.previewSeconds,
          );
          void runAction(async () => {
            await waitForClipMoveLiveIdle(activeClipDrag.clipId);
            const nextSnapshot = await moveClip(
              activeClipDrag.clipId,
              activeClipDrag.previewSeconds,
            );
            applyPlaybackSnapshot(nextSnapshot);
            const clip = findClip(songRef.current, activeClipDrag.clipId);
            setStatus(
              t("transport.status.clipMoved", {
                name: clip?.trackName ?? activeClipDrag.clipId,
              }),
            );
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
          Math.abs(event.clientX - activeTrackDrag.startClientX) >
            DRAG_THRESHOLD_PX ||
          Math.abs(event.clientY - activeTrackDrag.startClientY) >
            DRAG_THRESHOLD_PX;
        const shouldTreatAsDrag =
          Boolean(currentSong) && (activeTrackDrag.isDragging || movedEnough);
        const dropState =
          shouldTreatAsDrag && currentSong
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

  return {
    clearTrackDragVisuals,
    applyTrackDragVisuals,
    handleTrackDrop,
  };
}
