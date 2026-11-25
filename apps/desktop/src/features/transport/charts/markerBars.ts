import type { SectionMarkerSummary, SongRegionSummary } from "@libretracks/shared/models";
import { chartMarkersForRegion } from "@libretracks/shared/charts/chartSync";

/** Seconds per bar at a point of the song (`barSecondsAtFor`). */
export type BarSecondsAt = (seconds: number) => number;

/**
 * How many bars each section marker of the song lasts: until the next section
 * marker, or the end of the song. With the tempo and meter in force where it
 * starts, like the song map. Keyed by marker id.
 */
export function markerBars(
  markers: readonly SectionMarkerSummary[],
  region: SongRegionSummary,
  barSecondsAt: BarSecondsAt,
): Record<string, number> {
  const sections = chartMarkersForRegion(markers, region);
  const bars: Record<string, number> = {};
  sections.forEach((marker, index) => {
    const end = sections[index + 1]?.startSeconds ?? region.endSeconds;
    const barSeconds = barSecondsAt(marker.startSeconds);
    if (barSeconds > 0 && end > marker.startSeconds) bars[marker.id] = (end - marker.startSeconds) / barSeconds;
  });
  return bars;
}

/** "8", or "8.5" when the marker is not on a bar line (a hint it is misplaced). */
export function roundBars(bars: number): number {
  return Math.abs(bars - Math.round(bars)) < 0.05 ? Math.round(bars) : Math.round(bars * 10) / 10;
}
