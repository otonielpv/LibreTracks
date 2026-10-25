import type { ClipSummary, SongRegionSummary } from "@libretracks/shared/models";

export const MIN_REGION_DURATION_SECONDS = 0.1;

export type RegionResizeBounds = {
  initialStartSeconds: number;
  initialEndSeconds: number;
  /** The previous song's end (or 0): the start edge's floor. */
  minStartSeconds: number;
  /** The next song's start, or the workspace end without one. */
  maxEndSeconds: number;
  /** The furthest end of a clip in the song: the end can't shrink past it. */
  clipFloorEndSeconds: number | null;
  /** The earliest start of a clip in the song: the start can't pass it. */
  clipCeilStartSeconds: number | null;
};

/**
 * Where a song's edges may go. The rules of dragging a region's edge in the
 * DAW (timeline/useRegionDrag) and of typing them in Setlist's song settings:
 * neighbours are hard walls, and a song can't be trimmed past its own audio
 * (the backend rejects clips outside their region).
 */
export function regionResizeBounds(
  regions: readonly SongRegionSummary[],
  region: SongRegionSummary,
  clips: Iterable<Pick<ClipSummary, "timelineStartSeconds" | "durationSeconds">>,
  workspaceEndSeconds: number,
): RegionResizeBounds {
  const sorted = [...regions].sort((left, right) => left.startSeconds - right.startSeconds);
  const index = sorted.findIndex((entry) => entry.id === region.id);
  const leftNeighbour = index > 0 ? sorted[index - 1] : null;
  const rightNeighbour = index >= 0 && index < sorted.length - 1 ? sorted[index + 1] : null;
  let clipFloorEndSeconds: number | null = null;
  let clipCeilStartSeconds: number | null = null;
  for (const clip of clips) {
    const clipStart = clip.timelineStartSeconds;
    const clipEnd = clip.timelineStartSeconds + clip.durationSeconds;
    if (!(clipStart < region.endSeconds && clipEnd > region.startSeconds)) continue;
    clipFloorEndSeconds = clipFloorEndSeconds === null ? clipEnd : Math.max(clipFloorEndSeconds, clipEnd);
    clipCeilStartSeconds =
      clipCeilStartSeconds === null ? clipStart : Math.min(clipCeilStartSeconds, clipStart);
  }
  return {
    initialStartSeconds: region.startSeconds,
    initialEndSeconds: region.endSeconds,
    minStartSeconds: leftNeighbour ? leftNeighbour.endSeconds : 0,
    // Without a right neighbour the song may grow into the empty workspace
    // tail; growing it moves no clips.
    maxEndSeconds: rightNeighbour ? rightNeighbour.startSeconds : workspaceEndSeconds,
    clipFloorEndSeconds,
    clipCeilStartSeconds,
  };
}

/** Clamps one edge to its bounds (the other edge stays where it was). */
export function clampRegionResizeEdge(
  edge: "start" | "end",
  seconds: number,
  bounds: RegionResizeBounds,
): number {
  if (edge === "start") {
    const ceil =
      bounds.clipCeilStartSeconds === null
        ? bounds.initialEndSeconds - MIN_REGION_DURATION_SECONDS
        : Math.min(bounds.clipCeilStartSeconds, bounds.initialEndSeconds - MIN_REGION_DURATION_SECONDS);
    return Math.max(bounds.minStartSeconds, Math.min(seconds, ceil));
  }
  const floor =
    bounds.clipFloorEndSeconds === null
      ? bounds.initialStartSeconds + MIN_REGION_DURATION_SECONDS
      : Math.max(bounds.clipFloorEndSeconds, bounds.initialStartSeconds + MIN_REGION_DURATION_SECONDS);
  return Math.min(bounds.maxEndSeconds, Math.max(seconds, floor));
}
