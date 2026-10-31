import type { SectionMarkerSummary, SongRegionSummary } from "@libretracks/shared/models";

import { useTransportStore } from "../store";
import type { SongMapBlock } from "./songMapModel";

function isPlaying(): boolean {
  // Read at call time, not subscribed: callers must not re-render on every
  // transport change.
  return useTransportStore.getState().playback?.playbackState === "playing";
}

/**
 * A tap on a song card (and ↑/↓ in the view): select it and, stopped, cue it.
 * Sounding, it only prepares the song.
 */
export function activateSetlistSong(
  regionId: string,
  deps: {
    canControl: boolean;
    onSelectRegion: (regionId: string) => void;
    onCueSong: (regionId: string) => void;
  },
): void {
  deps.onSelectRegion(regionId);
  if (!isPlaying() && deps.canControl) deps.onCueSong(regionId);
}

export type SongMapJumpDeps = {
  region: SongRegionSummary;
  pendingBlockId: string | null;
  onMarkerAction: (marker: SectionMarkerSummary) => void;
  onCancelPendingJump: () => void;
  onPlaySong: (regionId: string, regionName: string) => void;
  onCueSong: (regionId: string) => void;
};

/**
 * Jump to a block of the song map (a double tap while playing, a tap while
 * stopped, Enter on the keyboard cursor). The pending block cancels instead.
 */
export function jumpToSongMapBlock(block: SongMapBlock, deps: SongMapJumpDeps): void {
  if (block.id === deps.pendingBlockId) {
    deps.onCancelPendingJump();
    return;
  }
  if (block.marker) {
    deps.onMarkerAction(block.marker);
    return;
  }
  // The implicit start / whole-song block has no marker: it goes to the
  // song's start (a song jump while sounding, a cue while stopped).
  if (isPlaying()) deps.onPlaySong(deps.region.id, deps.region.name);
  else deps.onCueSong(deps.region.id);
}
