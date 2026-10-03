import type { SongRegionSummary } from "@libretracks/shared/models";

/** Name of the arrangement written on the timeline for this song, or `null`
 * when it plays its original. Plain module: the canvas renderer uses it too. */
export function appliedArrangementName(region: SongRegionSummary): string | null {
  const structure = region.structure;
  const appliedId = structure?.appliedArrangementId;
  if (!structure || !appliedId) return null;
  return (
    structure.arrangements.find((arrangement) => arrangement.id === appliedId)?.name ??
    appliedId
  );
}
