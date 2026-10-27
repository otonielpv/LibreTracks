import type { SongRegionSummary, SongView } from "@libretracks/shared/models";

import { snapSecondsToSongGrid } from "./sectionScrubModel";

/** A marker never sits ON the song end: it would belong to the next song. */
export const SECTION_END_MARGIN_SECONDS = 0.001;

/** Where a section lands: on the bar line (tempo and meter in force there)
 * when snapping is on, and always inside its song. */
export function placeSectionSeconds(
  song: SongView,
  region: Pick<SongRegionSummary, "startSeconds" | "endSeconds">,
  seconds: number,
  snapEnabled: boolean,
  widthPx = 0,
): number {
  const snapped = snapEnabled
    ? snapSecondsToSongGrid(song, region, seconds, widthPx)
    : seconds;
  return Math.max(
    region.startSeconds,
    Math.min(region.endSeconds - SECTION_END_MARGIN_SECONDS, snapped),
  );
}

/**
 * How far a group of markers may move without any leaving the song: the
 * earliest can't go before the song start, the latest can't reach its end.
 */
export function clampSectionGroupDelta(
  startSeconds: readonly number[],
  deltaSeconds: number,
  region: Pick<SongRegionSummary, "startSeconds" | "endSeconds">,
): number {
  if (startSeconds.length === 0) return 0;
  const earliest = Math.min(...startSeconds);
  const latest = Math.max(...startSeconds);
  const minDelta = region.startSeconds - earliest;
  const maxDelta = region.endSeconds - SECTION_END_MARGIN_SECONDS - latest;
  return Math.max(minDelta, Math.min(maxDelta, deltaSeconds));
}

/** The delta of a drag, snapped so the dragged marker lands on a bar. */
export function snappedSectionDelta(
  song: SongView,
  region: Pick<SongRegionSummary, "startSeconds" | "endSeconds">,
  draggedStartSeconds: number,
  rawDeltaSeconds: number,
  groupStartSeconds: readonly number[],
  snapEnabled: boolean,
  widthPx = 0,
): number {
  const target = placeSectionSeconds(
    song,
    region,
    draggedStartSeconds + rawDeltaSeconds,
    snapEnabled,
    widthPx,
  );
  return clampSectionGroupDelta(groupStartSeconds, target - draggedStartSeconds, region);
}
