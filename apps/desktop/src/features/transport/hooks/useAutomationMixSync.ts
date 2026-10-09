import { useEffect } from "react";

import type { SongView } from "@libretracks/shared/models";

import { getSongView } from "../desktopApi";
import { setSong } from "../songStore";
import { useTransportStore } from "../store";

/**
 * Copy the mix fields (mute/solo/volume/pan) of `fresh` onto `current`'s
 * tracks, leaving everything else — clips, regions, the hydrated waveforms —
 * untouched. Returns `current` itself when nothing changed, so the song store
 * does not re-render the panel for an identical mix.
 */
export function mergeTrackMix(
  current: SongView | null,
  fresh: SongView | null,
): SongView | null {
  if (!current || !fresh) return current;
  const freshById = new Map(fresh.tracks.map((track) => [track.id, track]));
  let changed = false;
  const tracks = current.tracks.map((track) => {
    const next = freshById.get(track.id);
    if (
      !next ||
      (next.muted === track.muted &&
        next.solo === track.solo &&
        next.volume === track.volume &&
        next.pan === track.pan)
    ) {
      return track;
    }
    changed = true;
    return {
      ...track,
      muted: next.muted,
      solo: next.solo,
      volume: next.volume,
      pan: next.pan,
    };
  });
  return changed ? { ...current, tracks } : current;
}

/**
 * Automation cues change the mix in the backend model without bumping
 * `projectRevision` (it is playback state, not an edit), so the song-view
 * loader never refetches and the headers keep the pre-cue buttons: the red M
 * stayed lit after a cue un-muted the track. The backend publishes
 * `mixRevision` for this; on each bump we pull a waveform-less song view and
 * take only the mix fields from it.
 */
export function useAutomationMixSync() {
  useEffect(() => {
    let active = true;
    let requestId = 0;

    const unsubscribe = useTransportStore.subscribe(
      (state) => state.playback?.mixRevision ?? 0,
      (mixRevision, previousMixRevision) => {
        if (mixRevision === previousMixRevision || mixRevision === 0) return;
        const ownRequest = ++requestId;
        void getSongView({ includeWaveforms: false })
          .then((fresh) => {
            // A newer bump already asked for a fresher view; let that one win.
            if (!active || ownRequest !== requestId) return;
            setSong((current) => mergeTrackMix(current, fresh));
          })
          .catch(() => undefined);
      },
    );

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
}
