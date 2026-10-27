import type { SongRegionSummary, SongView } from "@libretracks/shared/models";

export type SongTrackContent = {
  /** Tracks with an audio, MIDI or video clip inside the song. */
  trackIds: Set<string>;
  /** The automation lane has a cue inside the song. The lane is not a
   * track (no mixer strip), so it is reported apart. */
  hasAutomation: boolean;
};

function overlaps(start: number, end: number, region: SongRegionSummary) {
  return start < region.endSeconds && end > region.startSeconds;
}

/**
 * What lives in one song, for the Setlist mixer and lanes (D4: the selected
 * song, not the one under the playhead). Unlike Compacta's
 * computeActiveSongTrackIds, which only sees audio clips, this also counts
 * MIDI and video clips and the automation lane.
 */
export function computeSongTrackContent(
  song: Pick<SongView, "clips" | "midiClips" | "videoClips" | "automationCues">,
  region: SongRegionSummary,
): SongTrackContent {
  const trackIds = new Set<string>();
  for (const clip of song.clips) {
    if (overlaps(clip.timelineStartSeconds, clip.timelineStartSeconds + clip.durationSeconds, region)) {
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
    if (overlaps(clip.timelineStartSeconds, clip.timelineStartSeconds + clip.durationSeconds, region)) {
      trackIds.add(clip.trackId);
    }
  }
  const hasAutomation = (song.automationCues ?? []).some(
    (cue) => cue.atSeconds >= region.startSeconds && cue.atSeconds < region.endSeconds,
  );
  return { trackIds, hasAutomation };
}
