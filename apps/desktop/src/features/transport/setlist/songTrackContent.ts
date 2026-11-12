import type { SongRegionSummary, SongView } from "@libretracks/shared/models";

export type SongTrackContent = {
  /** Tracks with an audio, MIDI or video clip inside the song. */
  trackIds: Set<string>;
  /** The automation lane has a cue inside the song. The lane is not a
   * track (no mixer strip), so it is reported apart. */
  hasAutomation: boolean;
};

function overlapSeconds(start: number, end: number, region: SongRegionSummary) {
  return Math.min(end, region.endSeconds) - Math.max(start, region.startSeconds);
}

/**
 * A clip belongs to ONE song: the one it overlaps the most. Counting every
 * song it touches made a stem whose tail (or a whole folder of them) runs a
 * little into the next song show up in that song's filtered mixer too. Ties
 * go to the earlier song, which is where the clip starts.
 */
function belongsTo(
  start: number,
  end: number,
  region: SongRegionSummary,
  regions: readonly SongRegionSummary[],
) {
  const own = overlapSeconds(start, end, region);
  if (own <= 0) return false;
  for (const other of regions) {
    if (other.id === region.id) continue;
    const theirs = overlapSeconds(start, end, other);
    if (theirs > own || (theirs === own && other.startSeconds < region.startSeconds)) return false;
  }
  return true;
}

/**
 * What lives in one song, for the Setlist mixer and lanes (D4: the selected
 * song, not the one under the playhead). Unlike Compacta's
 * computeActiveSongTrackIds, which only sees audio clips, this also counts
 * MIDI and video clips and the automation lane.
 */
export function computeSongTrackContent(
  song: Pick<SongView, "clips" | "midiClips" | "videoClips" | "automationCues"> &
    Partial<Pick<SongView, "regions">>,
  region: SongRegionSummary,
): SongTrackContent {
  const trackIds = new Set<string>();
  const regions = song.regions ?? [];
  for (const clip of song.clips) {
    if (belongsTo(clip.timelineStartSeconds, clip.timelineStartSeconds + clip.durationSeconds, region, regions)) {
      trackIds.add(clip.trackId);
    }
  }
  for (const clip of song.midiClips ?? []) {
    // A MIDI clip's length is in its events; its start decides the song.
    if (clip.timelineStartSeconds >= region.startSeconds && clip.timelineStartSeconds < region.endSeconds) {
      trackIds.add(clip.trackId);
    }
  }
  for (const clip of song.videoClips ?? []) {
    if (belongsTo(clip.timelineStartSeconds, clip.timelineStartSeconds + clip.durationSeconds, region, regions)) {
      trackIds.add(clip.trackId);
    }
  }
  const hasAutomation = (song.automationCues ?? []).some(
    (cue) => cue.atSeconds >= region.startSeconds && cue.atSeconds < region.endSeconds,
  );
  return { trackIds, hasAutomation };
}
