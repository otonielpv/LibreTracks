/**
 * Pure derivations for the song-header and clip-list widgets — the remote's
 * projection of the desktop's compact (Ableton-Session) view. Kept free of
 * React so they can be unit-tested; the components live in App.tsx where the
 * stores, sendCommand and the shared SongMasterFader already are.
 */

import {
  getEffectiveBpmAt,
  regionEffectiveKey,
  type SongRegionSummary,
  type SongView,
} from "@libretracks/shared/models";

export type SongClipEntry = {
  id: string;
  clipName: string;
  trackId: string;
  trackName: string;
  /** Track accent colour, propagated for the left ribbon + tinted name (mirrors
   * the desktop compact clip card). null when the track has no colour. */
  trackColor: string | null;
  /** Timeline start, used only to order the stack the way the DAW does. */
  timelineStartSeconds: number;
};

/** Human clip name from its file path: basename without extension. Mirrors the
 * desktop's `filePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "")`. */
export function clipDisplayName(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath;
  return base.replace(/\.[^.]+$/, "") || base;
}

/**
 * Clips that live inside a region (their timeline start falls within the
 * region span), ordered by the track's index in the project so reading
 * top-to-bottom matches the DAW header pane. Returns entries enriched with the
 * clip name and its track's name + colour.
 */
export function clipsForRegion(
  songView: SongView | null,
  region: SongRegionSummary,
): SongClipEntry[] {
  if (!songView) {
    return [];
  }
  const trackIndex = new Map(songView.tracks.map((track, index) => [track.id, index]));
  const trackById = new Map(songView.tracks.map((track) => [track.id, track]));

  const entries: SongClipEntry[] = [];
  for (const clip of songView.clips) {
    if (
      clip.timelineStartSeconds >= region.startSeconds &&
      clip.timelineStartSeconds < region.endSeconds
    ) {
      const track = trackById.get(clip.trackId);
      entries.push({
        id: clip.id,
        clipName: clipDisplayName(clip.filePath),
        trackId: clip.trackId,
        trackName: clip.trackName || track?.name || "",
        trackColor: clip.color ?? track?.color ?? null,
        timelineStartSeconds: clip.timelineStartSeconds,
      });
    }
  }

  entries.sort((a, b) => {
    const ai = trackIndex.get(a.trackId) ?? Number.MAX_SAFE_INTEGER;
    const bi = trackIndex.get(b.trackId) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) {
      return ai - bi;
    }
    return a.timelineStartSeconds - b.timelineStartSeconds;
  });
  return entries;
}

/** Effective BPM at a region's start — "what tempo plays here", honouring the
 * song's tempo map (mirrors the desktop's bpmByRegion). */
export function bpmForRegion(
  songView: SongView | null,
  region: SongRegionSummary,
): number {
  return getEffectiveBpmAt(songView, region.startSeconds);
}

/** Formats a BPM the way the compact header does: integer when whole. */
export function formatBpm(bpm: number): string {
  return bpm.toFixed(bpm % 1 === 0 ? 0 : 2);
}

/** The effective key badge for a region (transpose applied), or null. */
export function keyForRegion(region: SongRegionSummary): string | null {
  return regionEffectiveKey(region);
}

/** The region under the playhead, or null between/outside songs. */
export function activeRegion(
  songView: SongView | null,
  positionSeconds: number,
): SongRegionSummary | null {
  return (
    songView?.regions.find(
      (region) =>
        positionSeconds >= region.startSeconds && positionSeconds < region.endSeconds,
    ) ?? null
  );
}
