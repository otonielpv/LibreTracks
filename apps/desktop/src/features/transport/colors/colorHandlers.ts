import type {
  ClipSummary,
  SongView,
  TrackSummary,
  TransportSnapshot,
} from "@libretracks/shared/models";

/**
 * Dependencies for the track/clip colour handlers extracted from
 * TransportPanelContent. Each handler follows the same optimistic pattern:
 * call the engine, record the returned revision as optimistically applied,
 * patch the local `song` immediately, then publish the playback snapshot.
 *
 * The optimistic `setSong` patch is what keeps the colour change visible the
 * instant the user picks it, before the next snapshot round-trips — preserving
 * it is important, so it is mirrored exactly from the monolith.
 */
export type ColorHandlerDeps = {
  runAction: (action: () => Promise<void>) => Promise<void>;
  setSong: (update: (previous: SongView | null) => SongView | null) => void;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  setStatus: (message: string) => void;
  optimisticallyAppliedRevisionsRef: { current: Set<number> };
  clipDisplayName: (clip: ClipSummary) => string;
  updateTrackColor: (input: {
    trackId: string;
    color: string | null;
  }) => Promise<TransportSnapshot>;
  updateClipColor: (
    clipId: string,
    color: string | null,
  ) => Promise<TransportSnapshot>;
};

export function createColorHandlers(deps: ColorHandlerDeps) {
  const {
    runAction,
    setSong,
    applyPlaybackSnapshot,
    setStatus,
    optimisticallyAppliedRevisionsRef,
    clipDisplayName,
    updateTrackColor,
    updateClipColor,
  } = deps;

  /** Apply a finished snapshot: mark its revision optimistic + publish it. */
  const commitSnapshot = (snapshot: TransportSnapshot) => {
    optimisticallyAppliedRevisionsRef.current.add(snapshot.projectRevision);
  };

  const handleSetTrackColor = async (
    track: TrackSummary,
    color: string | null,
  ) => {
    await runAction(async () => {
      const nextSnapshot = await updateTrackColor({ trackId: track.id, color });
      commitSnapshot(nextSnapshot);
      setSong((previous) =>
        previous
          ? {
              ...previous,
              projectRevision: nextSnapshot.projectRevision,
              tracks: previous.tracks.map((candidate) =>
                candidate.id === track.id ? { ...candidate, color } : candidate,
              ),
            }
          : previous,
      );
      applyPlaybackSnapshot(nextSnapshot);
      setStatus(`Track color updated: ${track.name}`);
    });
  };

  const handleSetTrackColors = async (
    tracks: TrackSummary[],
    color: string | null,
  ) => {
    if (tracks.length === 0) {
      return;
    }
    if (tracks.length === 1) {
      await handleSetTrackColor(tracks[0], color);
      return;
    }

    await runAction(async () => {
      let nextSnapshot: TransportSnapshot | null = null;
      const trackIds = new Set(tracks.map((track) => track.id));

      for (const track of tracks) {
        nextSnapshot = await updateTrackColor({ trackId: track.id, color });
      }
      if (!nextSnapshot) {
        return;
      }

      commitSnapshot(nextSnapshot);
      const snapshot = nextSnapshot;
      setSong((previous) =>
        previous
          ? {
              ...previous,
              projectRevision: snapshot.projectRevision,
              tracks: previous.tracks.map((candidate) =>
                trackIds.has(candidate.id)
                  ? { ...candidate, color }
                  : candidate,
              ),
            }
          : previous,
      );
      applyPlaybackSnapshot(nextSnapshot);
      setStatus(`Track colors updated: ${tracks.length}`);
    });
  };

  const handleSetClipColor = async (
    clip: ClipSummary,
    color: string | null,
  ) => {
    await runAction(async () => {
      const nextSnapshot = await updateClipColor(clip.id, color);
      commitSnapshot(nextSnapshot);
      setSong((previous) =>
        previous
          ? {
              ...previous,
              projectRevision: nextSnapshot.projectRevision,
              clips: previous.clips.map((candidate) =>
                candidate.id === clip.id ? { ...candidate, color } : candidate,
              ),
            }
          : previous,
      );
      applyPlaybackSnapshot(nextSnapshot);
      setStatus(`Clip color updated: ${clipDisplayName(clip)}`);
    });
  };

  return { handleSetTrackColor, handleSetTrackColors, handleSetClipColor };
}

export type ColorHandlers = ReturnType<typeof createColorHandlers>;
