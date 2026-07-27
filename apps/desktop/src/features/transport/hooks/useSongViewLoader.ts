import { useEffect } from "react";

import type { SongView } from "@libretracks/shared/models";

type SongViewLoaderDeps = {
  /** Revision counter published by the backend; each bump refetches. */
  playbackProjectRevision: number;
  getSongView: (options: {
    includeWaveforms: boolean;
  }) => Promise<SongView | null>;
  setSong: (song: SongView | null) => void;
  songRef: { current: SongView | null };
  /** Revisions this frontend produced itself and already applied locally. */
  optimisticallyAppliedRevisionsRef: { current: Set<number> };
  waveformsHydratedRef: { current: boolean };
  inFlightWaveformKeysRef: { current: Set<string> };
  setIsProjectViewHydrating: (hydrating: boolean) => void;
  hydrateWaveformCacheFromSong: (song: SongView | null) => void;
};

/**
 * Keep the frontend's `song` in sync with the backend's project revision.
 *
 * Two behaviours here are load-bearing and were both bug fixes, so preserve
 * them when touching this:
 *
 * 1. Waveforms are fetched only on the first load of a song (~27 MB payload);
 *    later revision bumps reuse the hydrated cache.
 * 2. A revision bump can mean the backend switched to a *different* song, not
 *    just an edit — that case must refetch waveforms instead of inheriting the
 *    previous song's (the cross-song waveform-cache buildup).
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
  hydrateWaveformCacheFromSong,
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

      // First load needs the full SongView with waveforms; subsequent
      // revision bumps (transpose, gain, mute, region edit, …) only need
      // the structural mutations — the waveform cache is still valid.
      // Use a ref (not songRef which lags by one render) so that overlapping
      // effect runs during the initial load don't all race to fetch
      // waveforms before the first setSong has committed.
      const needsWaveforms = !waveformsHydratedRef.current;
      // Reserve the slot *before* awaiting so a concurrent revision bump
      // sees needsWaveforms=false and skips the redundant 27 MB fetch.
      if (needsWaveforms) {
        waveformsHydratedRef.current = true;
      }
      const previousSongId = songRef.current?.id ?? null;
      const nextSong = await getSongView({ includeWaveforms: needsWaveforms });
      if (!active) {
        return;
      }

      // A revision bump can also mean the backend switched to a DIFFERENT
      // song within the same project session, not just an edit to the
      // current one — only knowable once nextSong.id is in hand. Without this
      // check every song opened after the first one in a session would skip
      // its own waveform fetch and silently inherit (merge in) the previous
      // song's waveforms via the branch below, which is what caused the
      // reported cross-song waveform-cache buildup. Re-fetch with waveforms
      // instead of trusting the waveforms-less nextSong already in hand.
      const songChanged =
        !needsWaveforms &&
        nextSong !== null &&
        previousSongId !== null &&
        previousSongId !== nextSong.id;
      const resolvedSong = songChanged
        ? await getSongView({ includeWaveforms: true })
        : nextSong;
      if (!active) {
        return;
      }

      if (!needsWaveforms && !songChanged && resolvedSong) {
        // Preserve previously hydrated waveforms.
        const previous = songRef.current;
        setSong({ ...resolvedSong, waveforms: previous?.waveforms ?? [] });
      } else {
        hydrateWaveformCacheFromSong(resolvedSong);
        setSong(resolvedSong);
        if (!resolvedSong) {
          // Fetched-with-waveforms returned null (shouldn't normally happen
          // mid-session, but be defensive): reset the flag so the next
          // load will fetch waveforms again.
          waveformsHydratedRef.current = false;
        } else if (songChanged) {
          waveformsHydratedRef.current = true;
        }
      }
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
  }, [hydrateWaveformCacheFromSong, playbackProjectRevision]);
}
