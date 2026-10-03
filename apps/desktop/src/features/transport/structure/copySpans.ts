import {
  markerCategory,
  type SectionMarkerSummary,
  type SongRegionSummary,
} from "@libretracks/shared/models";

/** `"coro~2"` → true: a section the arrangement repeats (the backend gives
 * every copy after the first a deterministic `~n` id). */
export function isCopyMarkerId(id: string): boolean {
  return /~\d+$/.test(id);
}

/**
 * Spans (view seconds) of the sections that are COPIES in an arranged song,
 * so the ruler can shade what is a repetition: from each copy section marker
 * to the next section marker, or to the end of its song.
 */
export function copySectionSpans(
  markers: readonly SectionMarkerSummary[],
  regions: readonly SongRegionSummary[],
): Array<{ startSeconds: number; endSeconds: number }> {
  const sections = markers
    .filter((marker) => markerCategory(marker) === "section")
    .sort((left, right) => left.startSeconds - right.startSeconds);
  const spans: Array<{ startSeconds: number; endSeconds: number }> = [];
  sections.forEach((marker, index) => {
    if (!isCopyMarkerId(marker.id)) return;
    const region = regions.find(
      (candidate) =>
        marker.startSeconds >= candidate.startSeconds - 0.001 &&
        marker.startSeconds < candidate.endSeconds,
    );
    if (!region?.structure?.appliedArrangementId) return;
    const next = sections[index + 1];
    const end =
      next && next.startSeconds < region.endSeconds ? next.startSeconds : region.endSeconds;
    if (end > marker.startSeconds) {
      spans.push({ startSeconds: marker.startSeconds, endSeconds: end });
    }
  });
  return spans;
}
