import type {
  SongView,
  TrackKind,
  TrackSummary,
  TransportSnapshot,
} from "@libretracks/shared/models";

import type { TrackDropState } from "../types";
import { AUTOMATION_TRACK_ID } from "../library/pendingAudioImports";

type MoveTrackArgs = {
  trackId: string;
  insertAfterTrackId: string | null;
  insertBeforeTrackId: string | null;
  parentTrackId: string | null;
};

/**
 * Dependencies for the track create / reorder handlers extracted from
 * TransportPanelContent. Reactive state (song, tracksById, selection) is read
 * through getters so the factory can be instantiated once with stable deps and
 * still see live values inside its async bodies.
 */
export type TrackHandlerDeps = {
  getSong: () => SongView | null;
  getTracksById: () => Record<string, TrackSummary>;
  getSelectedTrackIds: () => string[];
  runAction: (action: () => Promise<void>) => Promise<void>;
  refreshSongView: (options?: {
    sync?: boolean;
    includeWaveforms?: boolean;
  }) => Promise<SongView | null>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  clearTrackDragVisuals: () => void;
  optimisticallyAppliedRevisionsRef: { current: Set<number> };
  setStatus: (message: string) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
  moveTrack: (args: MoveTrackArgs) => Promise<TransportSnapshot>;
  createTrack: (args: {
    name: string;
    kind: TrackKind;
    insertAfterTrackId: string | null;
    parentTrackId: string | null;
  }) => Promise<TransportSnapshot>;
  prompt: (message: string, defaultValue?: string) => Promise<string | null>;
  /** Persist the synthetic automation lane's order (after `afterTrackId`). */
  setAutomationTrackPosition: (
    afterTrackId: string | null,
  ) => Promise<TransportSnapshot>;
  /** Ordered visible track ids, including the AUTOMATION_TRACK_ID sentinel. */
  getVisibleTrackIds: () => string[];
};

export function createTrackHandlers(deps: TrackHandlerDeps) {
  const {
    getSong,
    getTracksById,
    getSelectedTrackIds,
    runAction,
    refreshSongView,
    applyPlaybackSnapshot,
    clearTrackDragVisuals,
    optimisticallyAppliedRevisionsRef,
    setStatus,
    t,
    moveTrack,
    createTrack,
    prompt,
    setAutomationTrackPosition,
    getVisibleTrackIds,
  } = deps;

  /**
   * Resolve where the automation lane should land given a drop onto the real
   * track `targetTrackId` with the given mode. Returns the id of the audio
   * track the lane sits *after* (`null` = first row).
   */
  const automationAfterIdFor = (
    targetTrackId: string,
    mode: NonNullable<TrackDropState>["mode"],
  ): string | null => {
    if (mode === "after" || mode === "inside-folder") {
      return targetTrackId;
    }
    // "before": land after the visible track that precedes the target,
    // skipping the automation lane itself.
    const order = getVisibleTrackIds().filter(
      (id) => id !== AUTOMATION_TRACK_ID,
    );
    const targetIndex = order.indexOf(targetTrackId);
    if (targetIndex <= 0) {
      return null;
    }
    return order[targetIndex - 1];
  };

  /** Build the moveTrack args for a single dragged track given the drop mode. */
  const moveArgsFor = (
    trackId: string,
    targetTrack: TrackSummary,
    mode: NonNullable<TrackDropState>["mode"],
  ): MoveTrackArgs => {
    if (mode === "inside-folder") {
      return {
        trackId,
        insertAfterTrackId: null,
        insertBeforeTrackId: null,
        parentTrackId: targetTrack.id,
      };
    }
    if (mode === "before") {
      return {
        trackId,
        insertAfterTrackId: null,
        insertBeforeTrackId: targetTrack.id,
        parentTrackId: targetTrack.parentTrackId ?? null,
      };
    }
    return {
      trackId,
      insertAfterTrackId: targetTrack.id,
      insertBeforeTrackId: null,
      parentTrackId: targetTrack.parentTrackId ?? null,
    };
  };

  return {
    async handleTrackDrop(
      draggedTrackId: string,
      dropState: NonNullable<TrackDropState>,
    ) {
      // The automation lane is synthetic (not in getTracksById), so its reorder
      // can't go through moveTrack. Persist its position separately instead.
      const isAutomationDragged = draggedTrackId === AUTOMATION_TRACK_ID;
      const isAutomationTarget =
        dropState.targetTrackId === AUTOMATION_TRACK_ID;

      if (isAutomationDragged) {
        if (!getSong() || isAutomationTarget) {
          clearTrackDragVisuals();
          return;
        }
        const afterId = automationAfterIdFor(
          dropState.targetTrackId,
          dropState.mode,
        );
        await runAction(async () => {
          try {
            const snapshot = await setAutomationTrackPosition(afterId);
            applyPlaybackSnapshot(snapshot);
            await refreshSongView({ includeWaveforms: false });
            setStatus(t("transport.automation.statusTrackReordered"));
          } finally {
            clearTrackDragVisuals();
          }
        });
        return;
      }

      if (isAutomationTarget) {
        // Dropping a real track relative to the automation lane: anchor it to
        // the lane's own saved position (the track before/after the lane).
        const order = getVisibleTrackIds();
        const laneIndex = order.indexOf(AUTOMATION_TRACK_ID);
        // Find the nearest real track to act as the moveTrack anchor.
        const realTargetId =
          dropState.mode === "before"
            ? order.slice(laneIndex + 1).find((id) => id !== AUTOMATION_TRACK_ID)
            : order
                .slice(0, laneIndex)
                .reverse()
                .find((id) => id !== AUTOMATION_TRACK_ID);
        const anchorTrack = realTargetId
          ? getTracksById()[realTargetId] ?? null
          : null;
        if (!getSong() || !anchorTrack || draggedTrackId === anchorTrack.id) {
          clearTrackDragVisuals();
          return;
        }
        await runAction(async () => {
          try {
            const snapshot = await moveTrack(
              moveArgsFor(draggedTrackId, anchorTrack, dropState.mode),
            );
            applyPlaybackSnapshot(snapshot);
            await refreshSongView();
            setStatus(t("transport.status.tracksReordered", { count: 1 }));
          } finally {
            clearTrackDragVisuals();
          }
        });
        return;
      }

      const targetTrack = getTracksById()[dropState.targetTrackId] ?? null;
      if (!getSong() || !targetTrack || draggedTrackId === targetTrack.id) {
        clearTrackDragVisuals();
        return;
      }

      const selectedTrackIds = getSelectedTrackIds();
      const tracksToMove =
        selectedTrackIds.includes(draggedTrackId) &&
        selectedTrackIds.length > 1
          ? selectedTrackIds
          : [draggedTrackId];

      await runAction(async () => {
        try {
          let lastSnapshot: TransportSnapshot | null = null;
          for (const trackId of tracksToMove) {
            if (trackId === targetTrack.id) {
              continue;
            }
            lastSnapshot = await moveTrack(
              moveArgsFor(trackId, targetTrack, dropState.mode),
            );
          }

          if (lastSnapshot) {
            applyPlaybackSnapshot(lastSnapshot);
          }
          await refreshSongView();
          setStatus(
            t("transport.status.tracksReordered", {
              count: tracksToMove.length,
            }),
          );
        } finally {
          clearTrackDragVisuals();
        }
      });
    },

    async handleCreateTrack(
      kind: TrackKind,
      anchorTrack: TrackSummary | null,
      parentTrackId?: string | null,
    ) {
      const defaultName =
        kind === "folder"
          ? t("transport.defaults.folderTrackName")
          : t("transport.defaults.audioTrackName");
      const name = (await prompt(t("transport.prompt.trackName"), defaultName))?.trim();
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
        // Pre-register the new revision so the revision-effect skips its own
        // refetch — refreshSongView below already pulls the fresh structure.
        optimisticallyAppliedRevisionsRef.current.add(
          nextSnapshot.projectRevision,
        );
        applyPlaybackSnapshot(nextSnapshot);
        // Creating an empty track does not add, move, or remove clips, so the
        // waveform peaks cache is still valid. Skip the ~27 MB waveform payload.
        await refreshSongView({ includeWaveforms: false });
        setStatus(t("transport.status.trackCreated", { name }));
      });
    },
  };
}

export type TrackHandlers = ReturnType<typeof createTrackHandlers>;
