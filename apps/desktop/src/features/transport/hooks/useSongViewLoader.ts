import { useEffect } from "react";

import type { SongView } from "@libretracks/shared/models";

import { mergeSongView } from "../songs/mergeSongView";

type SongViewLoaderDeps = {
  /** Revision counter published by the backend; each bump refetches. */
  playbackProjectRevision: number;
  getSongView: () => Promise<SongView | null>;
  setSong: (song: SongView | null) => void;
  songRef: { current: SongView | null };
  /** Revisions this frontend produced itself and already applied locally. */
  optimisticallyAppliedRevisionsRef: { current: Set<number> };
  waveformsHydratedRef: { current: boolean };
  inFlightWaveformKeysRef: { current: Set<string> };
  setIsProjectViewHydrating: (hydrating: boolean) => void;
  resetWaveformCacheWithoutSong: (song: SongView | null) => void;
};

/**
 * Keep the frontend's `song` in sync with the backend's project revision.
 *
 * A revision bump can mean the backend switched to a *different* song, not
 * just an edit: that case replaces the song instead of merging it into the
 * previous one's rows. Waveforms are not this hook's business: the song view
 * never carries them, and useSongWaveforms fetches what the clips need.
 */
export function useSongViewLoader({
  playbackProjectRevision,
  getSongView,
  setSong,
  songRef,
  optimisticallyAppliedRevisionsRef,
  waveformsHydratedRef,
  inFlightWaveformKeysRef,
  setIsProjectViewHydrating,
  resetWaveformCacheWithoutSong,
}: SongViewLoaderDeps) {
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

      // The first load takes the song as-is; later revision bumps (transpose,
      // gain, mute, region edit, …) are merged so untouched rows keep their
      // identity. Use a ref (not songRef, which lags by one render) so that
      // overlapping effect runs during the initial load agree on which one is
      // the first. Peaks never ride on the song view: useSongWaveforms fetches
      // them in batches.
      const isFirstLoad = !waveformsHydratedRef.current;
      if (isFirstLoad) {
        waveformsHydratedRef.current = true;
      }
      const previousSongId = songRef.current?.id ?? null;
      const nextSong = await getSongView();
      if (!active) {
        return;
      }

      // A revision bump can also mean the backend switched to a DIFFERENT
      // song within the same project session, not just an edit to the current
      // one. Merging would graft the new song onto the old one's rows, so it
      // is replaced like a first load. Its waveforms come from
      // useSongWaveforms, which restarts on the new song id.
      const songChanged =
        !isFirstLoad &&
        nextSong !== null &&
        previousSongId !== null &&
        previousSongId !== nextSong.id;

      if (!isFirstLoad && !songChanged && nextSong) {
        // Every track / clip / marker the edit did not touch keeps its object
        // identity, so memos keyed on them (and memoized rows) skip the work.
        setSong(mergeSongView(songRef.current, nextSong));
      } else {
        resetWaveformCacheWithoutSong(nextSong);
        setSong(nextSong);
        if (!nextSong) {
          // No song (shouldn't normally happen mid-session, but be
          // defensive): the next load is a first load again.
          waveformsHydratedRef.current = false;
        }
      }
      const resolvedSong = nextSong;
      if (resolvedSong) {
        setIsProjectViewHydrating(false);
      }
    }

    void loadSong();

    return () => {
      active = false;
    };
    // Mirrors the original effect's dependency list: everything else is a ref
    // or a stable setter, deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetWaveformCacheWithoutSong, playbackProjectRevision]);
}
