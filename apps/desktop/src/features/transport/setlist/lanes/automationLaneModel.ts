import {
  buildSongTempoRegions,
  getSongTempoRegionAtPosition,
  markerCategory,
  type AutomationCueSummary,
  type SectionMarkerSummary,
  type SongRegionSummary,
  type SongView,
} from "@libretracks/shared/models";

import { snapToTimelineGrid } from "../../timeline/timelineMath";

/** A cue never sits ON the song end: it would belong to the next song. */
const SONG_END_MARGIN_SECONDS = 0.05;

type SongBounds = Pick<SongRegionSummary, "startSeconds" | "endSeconds">;

/** The song's automation cues, in time order. */
export function songAutomationCues(song: SongView, region: SongBounds): AutomationCueSummary[] {
  return (song.automationCues ?? [])
    .filter((cue) => cue.atSeconds >= region.startSeconds && cue.atSeconds < region.endSeconds)
    .sort((left, right) => left.atSeconds - right.atSeconds);
}

/** The section a moment of the song falls in (the last one starting at or
 * before it), or null before the first section. */
export function sectionAt(
  song: SongView,
  region: SongBounds,
  seconds: number,
): SectionMarkerSummary | null {
  let found: SectionMarkerSummary | null = null;
  for (const marker of song.sectionMarkers) {
    if (markerCategory(marker) !== "section") continue;
    if (marker.startSeconds < region.startSeconds || marker.startSeconds >= region.endSeconds) continue;
    if (marker.startSeconds <= seconds + 1e-6 && (!found || marker.startSeconds > found.startSeconds)) {
      found = marker;
    }
  }
  return found;
}

export type CueDragInput = {
  song: SongView;
  region: SongBounds;
  originSeconds: number;
  rawDeltaSeconds: number;
  pxPerSecond: number;
  snapEnabled: boolean;
};

/**
 * Where a dragged cue lands: on the grid the user sees when snap is on (the
 * DAW's rule for its ruler flags and clips), and always inside the song.
 */
export function resolveCueDrag(input: CueDragInput): number {
  const { song, region, originSeconds, rawDeltaSeconds, pxPerSecond } = input;
  let target = originSeconds + rawDeltaSeconds;
  if (input.snapEnabled) {
    const timing = getSongTempoRegionAtPosition(song, target);
    target = snapToTimelineGrid(
      target,
      timing?.bpm ?? song.bpm,
      timing?.timeSignature ?? song.timeSignature,
      1,
      pxPerSecond,
      buildSongTempoRegions(song),
    );
  }
  const min = Math.max(region.startSeconds, 0);
  const max = region.endSeconds - SONG_END_MARGIN_SECONDS;
  return Math.max(min, Math.min(max, target));
}

/**
 * Where the automation row goes among the song's track rows: where it sits in
 * the project (after `afterTrackId`, first when `null`). When that track has
 * no audio in this song, after the closest track above it that does.
 */
export function automationRowIndex(
  rowTrackIds: readonly string[],
  projectTrackIds: readonly string[],
  afterTrackId: string | null | undefined,
): number {
  if (!afterTrackId) return 0;
  const direct = rowTrackIds.indexOf(afterTrackId);
  if (direct !== -1) return direct + 1;
  const projectIndex = projectTrackIds.indexOf(afterTrackId);
  for (let index = projectIndex - 1; index >= 0; index -= 1) {
    const row = rowTrackIds.indexOf(projectTrackIds[index]);
    if (row !== -1) return row + 1;
  }
  return projectIndex === -1 ? rowTrackIds.length : 0;
}
