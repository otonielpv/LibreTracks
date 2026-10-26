import type { TransportSnapshot } from "@libretracks/shared/models";

import { getSongView, updateSongRegion } from "../desktopApi";

/** Tolerance when comparing seconds. */
const EPS = 1e-3;

/**
 * Audio dropped on a song that had none (the usual «+ New song», then drop
 * the stems): the song is one bar long, the audio is minutes long. Left like
 * that, everything past the bar is outside the song, and so is what reads the
 * song: «Analyze song» only looks inside it, so it found no click, no guide
 * and no drums for the key (the report). Grow the song to the longest of the
 * new audio, the same length a folder dropped as a song gets.
 *
 * Only a song with no other audio grows (an existing song is never resized
 * behind the user's back), and never into the next song. Returns the snapshot
 * of the resize, or null when nothing changed.
 */
export async function extendSongToAudio(
  regionId: string,
  filePaths: readonly string[],
): Promise<TransportSnapshot | null> {
  const song = await getSongView();
  const region = song?.regions.find((candidate) => candidate.id === regionId);
  if (!song || !region || filePaths.length === 0) return null;
  const added = new Set(filePaths);
  const overlapsSong = (clip: { timelineStartSeconds: number; durationSeconds: number }) =>
    clip.timelineStartSeconds < region.endSeconds - EPS &&
    clip.timelineStartSeconds + clip.durationSeconds > region.startSeconds + EPS;
  // Something already there: not an empty song.
  if (song.clips.some((clip) => overlapsSong(clip) && !added.has(clip.filePath))) return null;
  const longest = song.clips
    .filter((clip) => added.has(clip.filePath) && clip.timelineStartSeconds >= region.startSeconds - EPS)
    .reduce((end, clip) => Math.max(end, clip.timelineStartSeconds + clip.durationSeconds), 0);
  const nextStart = song.regions
    .filter((candidate) => candidate.id !== region.id && candidate.startSeconds >= region.endSeconds - EPS)
    .reduce((min, candidate) => Math.min(min, candidate.startSeconds), Number.POSITIVE_INFINITY);
  const endSeconds = Math.min(longest, nextStart);
  if (endSeconds <= region.endSeconds + EPS) return null;
  return updateSongRegion(region.id, region.name, region.startSeconds, endSeconds);
}
