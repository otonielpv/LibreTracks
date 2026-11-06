import type {
  SongView,
  TrackKind,
  TrackSummary,
  TransportSnapshot,
} from "@libretracks/shared/models";

import type { TrackDropState } from "../types";
import {
  applyTrackMoves,
  planTrackDrop,
  withTrackTreeFields,
  type MoveTrackArgs,
} from "./trackMovePlan";

/**
 * Dependencies for the track create / reorder handlers extracted from
 * TransportPanelContent. Reactive state (song, tracksById, selection) is read
 * through getters so the factory can be instantiated once with stable deps and
 * still see live values inside its async bodies.
 */
export type TrackHandlerDeps = {
  getSong: () => SongView | null;
  /** Write the song store (value or updater). The drop paints its result
   * optimistically before the backend confirms it. */
  setSong: (next: SongView | null | ((previous: SongView | null) => SongView | null)) => void;
  getTracksById: () => Record<string, TrackSummary>;
  getSelectedTrackIds: () => string[];
  runAction: (action: () => Promise<void>) => Promise<void>;
  refreshSongView: (options?: {
    sync?: boolean;
    includeWaveforms?: boolean;
  }) => Promise<SongView | null>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  /** `settle` after a drop that will change the order: the preview stays
   * until the new order renders. See ./useTrackDragPreview. */
  clearTrackDragVisuals: (options?: { settle?: boolean; revert?: boolean }) => void;
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
    getSelectedTrackIds,
    runAction,
    refreshSongView,
    applyPlaybackSnapshot,
    clearTrackDragVisuals,
    optimisticallyAppliedRevisionsRef,
    setStatus,
    t,
    moveTrack,
    setSong,
    createTrack,
    prompt,
    setAutomationTrackPosition,
    getVisibleTrackIds,
  } = deps;

  return {
    async handleTrackDrop(
      draggedTrackId: string,
      dropState: NonNullable<TrackDropState>,
    ) {
      const song = getSong();
      // Same plan the drag preview showed, so the drop lands where the ghost
      // was. See ./trackMovePlan.
      const plan = song
        ? planTrackDrop({
            tracks: song.tracks,
            visibleTrackIds: getVisibleTrackIds(),
            selectedTrackIds: getSelectedTrackIds(),
            draggedTrackId,
            drop: dropState,
          })
        : null;
      if (!plan) {
        clearTrackDragVisuals();
        return;
      }

      if (plan.kind === "automation") {
        // The automation lane is synthetic (not in getTracksById), so its
        // reorder can't go through moveTrack. Persist its position instead.
        // Settle BEFORE the refresh: the preview is dropped when the new order
        // renders (useTrackDragPreview), and settling after it left the rows
        // offset on top of the new order until the safety timeout.
        clearTrackDragVisuals({ settle: true });
        await runAction(async () => {
          try {
            const snapshot = await setAutomationTrackPosition(plan.afterTrackId);
            applyPlaybackSnapshot(snapshot);
            await refreshSongView({ includeWaveforms: false });
            setStatus(t("transport.automation.statusTrackReordered"));
          } catch (error) {
            clearTrackDragVisuals({ revert: true });
            throw error;
          }
        });
        return;
      }

      // The preview already shows the result: accept it now, so the release
      // does not wait on the backend (every move rebuilds the audio structure
      // and saves, which takes a while in a big session).
      clearTrackDragVisuals({ settle: true });
      // And paint it: headers moved with the preview, but the clips live on
      // the canvas, which only follows `song.tracks`. Applying the moves here
      // (the backend's own rules, ./trackMovePlan) moves the clips with their
      // track at once; the refresh below confirms it, and keeps the objects
      // since they come back equal.
      const tracksBefore = song!.tracks;
      setSong((current) =>
        current && current.tracks === tracksBefore
          ? { ...current, tracks: withTrackTreeFields(applyTrackMoves(tracksBefore, plan.moves)) }
          : current,
      );
      await runAction(async () => {
        try {
          let lastSnapshot: TransportSnapshot | null = null;
          for (const move of plan.moves) {
            lastSnapshot = await moveTrack(move);
          }

          if (lastSnapshot) {
            // refreshSongView below already pulls the new order: without this
            // the revision effect fetched the whole song a second time.
            optimisticallyAppliedRevisionsRef.current.add(lastSnapshot.projectRevision);
            applyPlaybackSnapshot(lastSnapshot);
          }
          // Reordering moves tracks, never clips: the waveform cache is still
          // valid. Fetching it again was a multi-MB payload, and replacing
          // the song wholesale re-rendered every row — with 138 tracks the
          // drop took seconds to land.
          await refreshSongView({ includeWaveforms: false });
          setStatus(
            t("transport.status.tracksReordered", {
              count: plan.moves.length,
            }),
          );
        } catch (error) {
          clearTrackDragVisuals({ revert: true });
          // Back to what the backend has: the optimistic order did not happen.
          setSong((current) => (current ? { ...current, tracks: tracksBefore } : current));
          throw error;
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
          : kind === "video"
            ? t("transport.video.trackDefaultName")
            : kind === "midi"
              ? t("transport.midi.trackDefaultName")
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
