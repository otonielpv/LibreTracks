import { create } from "zustand";

import type { SongView } from "@libretracks/shared/models";

/**
 * The tracks the controller's strips drive right now (plan midi-controllers,
 * paso 04), for the mixer's bank indicator: like the coloured ring Ableton
 * draws around the tracks a control surface is on. `active` is whether any
 * `strip:*` binding exists; without one there is nothing to show.
 */
type MidiBankStore = {
  active: boolean;
  offset: number;
  trackIds: string[];
  setBank: (bank: { offset: number; trackIds: string[] }) => void;
  setActive: (active: boolean) => void;
};

export const useMidiBankStore = create<MidiBankStore>()((set) => ({
  active: false,
  offset: 0,
  trackIds: [],
  setBank: ({ offset, trackIds }) => set({ offset, trackIds }),
  setActive: (active) => set({ active }),
}));

/** Narrow selector: whether this track is under a strip. */
export function useIsInMidiBank(trackId: string) {
  return useMidiBankStore(
    (state) => state.active && state.trackIds.includes(trackId),
  );
}

export function hasStripMappings(midiMappings: Record<string, unknown>) {
  return Object.keys(midiMappings).some((key) => key.startsWith("strip:"));
}

/**
 * The tracks of the song under the playhead: those with an audio or MIDI
 * clip starting inside its region, plus the folders that hold them. `null`
 * when there is no such song or it has no clips yet (then every track).
 */
export function activeSongTrackIds(
  song: SongView | null,
  activeRegionId: string | null,
): Set<string> | null {
  const region = activeRegionId
    ? song?.regions.find((item) => item.id === activeRegionId)
    : undefined;
  if (!song || !region) return null;
  const inside = (start: number) =>
    start >= region.startSeconds && start < region.endSeconds;
  const ids = new Set<string>();
  for (const clip of song.clips) {
    if (inside(clip.timelineStartSeconds)) ids.add(clip.trackId);
  }
  for (const clip of song.midiClips ?? []) {
    if (inside(clip.timelineStartSeconds)) ids.add(clip.trackId);
  }
  if (ids.size === 0) return null;
  const byId = new Map(song.tracks.map((track) => [track.id, track]));
  for (const id of [...ids]) {
    let parentId = byId.get(id)?.parentTrackId;
    while (parentId && !ids.has(parentId)) {
      ids.add(parentId);
      parentId = byId.get(parentId)?.parentTrackId;
    }
  }
  return ids;
}

/**
 * The order the strips follow (D7): the tracks a fader can drive (no video),
 * as the mixer shows them, skipping the children of a collapsed folder.
 * With `onlyTrackIds` (strips follow the active song), only those tracks.
 */
export function midiStripOrder(
  song: SongView | null,
  onlyTrackIds: Set<string> | null = null,
): string[] {
  const tracks = song?.tracks ?? [];
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const hidden = (trackId: string | null | undefined): boolean => {
    const seen = new Set<string>();
    let parentId = trackId;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) return false;
      if (parent.collapsed) return true;
      parentId = parent.parentTrackId;
    }
    return false;
  };
  return tracks
    .filter(
      (track) =>
        track.kind !== "video" &&
        !hidden(track.parentTrackId) &&
        (!onlyTrackIds || onlyTrackIds.has(track.id)),
    )
    .map((track) => track.id);
}
