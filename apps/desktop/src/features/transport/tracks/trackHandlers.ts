import type {
  SongView,
  TrackKind,
  TrackSummary,
  TransportSnapshot,
} from "@libretracks/shared/models";

import type { TrackDropState } from "../types";

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
  prompt: (message: string, defaultValue?: string) => string | null;
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
  } = deps;

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
      const name = prompt(t("transport.prompt.trackName"), defaultName)?.trim();
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
