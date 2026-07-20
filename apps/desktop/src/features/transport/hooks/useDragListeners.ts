import { useEffect } from "react";

import {
  buildSongTempoRegions,
  getSongTempoRegionAtPosition,
  type SongView,
  type TransportSnapshot,
} from "@libretracks/shared/models";

import {
  moveClip,
  moveClipsBatch,
  type ClipMoveRequest,
} from "../desktopApi";
import { CLIP_SNAP_RADIUS_PX, DRAG_THRESHOLD_PX } from "../constants";
import {
  clipDisplayName,
  findClip,
  resolveCompactTrackDropState,
  resolveTrackDropState,
} from "../helpers";
import { findSnappedGroupDelta } from "../timeline/clipSnapping";
import {
  clampGroupRowDelta,
  resolveMemberTargetTrackId,
} from "../timeline/clipVerticalDrag";
import { snapToTimelineGrid } from "../timeline/useTimelineGrid";
import { useTimelineUIStore } from "../uiStore";
import type { TimelineTrackSummary } from "../library/pendingAudioImports";
import type {
  ClipDragState,
  ClipSnapAnchor,
  TimelinePanState,
  TrackDragState,
  TrackDropState,
} from "../types";

export type UseDragListenersOptions = {
  // --- Live state, read through refs so the listeners never re-subscribe ---
  songRef: { current: SongView | null };
  clipDragRef: { current: ClipDragState };
  trackDragRef: { current: TrackDragState };
  timelinePanRef: { current: TimelinePanState };
  visibleTracksRef: { current: TimelineTrackSummary[] };
  livePixelsPerSecondRef: { current: number };
  liveZoomLevelRef: { current: number };
  /** Per-clip preview positions the canvas paints without a re-render. */
  clipPreviewSecondsRef: { current: Record<string, number> };
  /** Per-clip destination lanes, same non-React painting path. */
  clipPreviewTrackIdRef: { current: Record<string, string> };
  clipPreviewClearAfterRevisionRef: { current: Record<string, number> };
  clipMoveCommitPendingRef: { current: Set<string> };
  clipSelectionAnchorRef: { current: string | null };
  clipSelectionPendingCollapseRef: { current: string | null };
  suppressTrackClickRef: { current: boolean };

  // --- Hoisted component functions, passed by ref (declared further down) ---
  restoreConfirmedTransportVisualRef: { current: (() => void) | null };
  performSeekRef: { current: ((positionSeconds: number) => Promise<void>) | null };

  // --- Stable callbacks ---
  snapEnabled: boolean;
  runAction: (action: () => Promise<void>) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  applyTrackDragVisuals: (
    dragState: NonNullable<TrackDragState>,
    dropState: TrackDropState,
  ) => void;
  clearTrackDragVisuals: () => void;
  /** Only called with a resolved drop target — never with the null variant. */
  handleTrackDrop: (
    trackId: string,
    dropState: NonNullable<TrackDropState>,
  ) => Promise<void>;
  queueClipMoveLiveUpdate: (clipId: string, seconds: number) => void;
  queueClipMoveBatchLiveUpdate: (moves: ClipMoveRequest[]) => void;
  waitForClipMoveLiveIdle: (clipId: string) => Promise<void>;
  waitForClipMoveBatchLiveIdle: () => Promise<void>;
  selectClip: (clipId: string, trackId: string | null) => void;
  setClipDragSnapIndicatorSeconds: (seconds: number | null) => void;
  setStatus: (message: string) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
};

/**
 * Global mousemove/mouseup listeners that drive clip drags and track drags.
 *
 * THIS IS THE HOT PATH. Two invariants must hold:
 *
 * 1. It writes preview positions/lanes into `clipPreviewSecondsRef` and
 *    `clipPreviewTrackIdRef`, which the canvas reads directly — the ghost is
 *    painted WITHOUT a React re-render. Never convert these to state.
 * 2. The dep list must stay minimal and referentially stable. Every change to
 *    it tears down and re-registers the window listeners, which can happen in
 *    the middle of a drag. Live zoom and selection are read through refs and
 *    `useTimelineUIStore.getState()` precisely so they need not be deps.
 */
export function useDragListeners({
  songRef,
  clipDragRef,
  trackDragRef,
  timelinePanRef,
  visibleTracksRef,
  livePixelsPerSecondRef,
  liveZoomLevelRef,
  clipPreviewSecondsRef,
  clipPreviewTrackIdRef,
  clipPreviewClearAfterRevisionRef,
  clipMoveCommitPendingRef,
  clipSelectionAnchorRef,
  clipSelectionPendingCollapseRef,
  suppressTrackClickRef,
  restoreConfirmedTransportVisualRef,
  performSeekRef,
  snapEnabled,
  runAction,
  applyPlaybackSnapshot,
  applyTrackDragVisuals,
  clearTrackDragVisuals,
  handleTrackDrop,
  queueClipMoveLiveUpdate,
  queueClipMoveBatchLiveUpdate,
  waitForClipMoveLiveIdle,
  waitForClipMoveBatchLiveIdle,
  selectClip,
  setClipDragSnapIndicatorSeconds,
  setStatus,
  t,
}: UseDragListenersOptions) {
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
          restoreConfirmedTransportVisualRef.current?.();
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
        const desiredRowDelta = Math.round(deltaLocalY / liveTrackHeight);
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
          const snapRadiusSeconds = CLIP_SNAP_RADIUS_PX / effectPixelsPerSecond;
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
              0.05 -
                (durationByClipId[member.clipId] ?? 0) -
                member.originSeconds,
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
          movedEnough && (activeClipDrag.members.length > 1 || changedTrack);
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
                (move) => !clipPreviewClearAfterRevisionRef.current[move.clipId],
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
                  name: clip ? clipDisplayName(clip) : activeClipDrag.clipId,
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
            await performSeekRef.current?.(activeClipDrag.clickSeekSeconds);
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
    // NOTE: live zoom and selection are NOT deps on purpose — they are read
    // through refs / useTimelineUIStore.getState() so the listeners never have
    // to re-subscribe mid-drag. See the hook doc above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    applyPlaybackSnapshot,
    applyTrackDragVisuals,
    clearTrackDragVisuals,
    handleTrackDrop,
    queueClipMoveBatchLiveUpdate,
    queueClipMoveLiveUpdate,
    waitForClipMoveBatchLiveIdle,
    runAction,
    selectClip,
    snapEnabled,
    waitForClipMoveLiveIdle,
  ]);
}
