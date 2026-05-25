import type { SongView } from "./desktopApi";
import type {
  ClipDragMember,
  ClipSnapAnchor,
} from "./types";

/**
 * Build the list of anchor points the user can magnet a dragged clip group
 * onto. Called once at the start of a drag so the cost (O(clips + markers +
 * regions)) is paid up-front, not on every mousemove.
 *
 * Excludes the edges of clips that are part of the drag — a clip should not
 * try to snap to its own edges.
 */
export function buildClipSnapAnchors(
  song: SongView,
  draggedMembers: ClipDragMember[],
  playheadSeconds: number,
): ClipSnapAnchor[] {
  const draggedIds = new Set(draggedMembers.map((member) => member.clipId));
  const anchors: ClipSnapAnchor[] = [];

  if (Number.isFinite(playheadSeconds) && playheadSeconds >= 0) {
    anchors.push({ seconds: playheadSeconds, kind: "playhead" });
  }

  for (const marker of song.sectionMarkers) {
    if (Number.isFinite(marker.startSeconds)) {
      anchors.push({ seconds: marker.startSeconds, kind: "section" });
    }
  }

  for (const region of song.regions) {
    if (Number.isFinite(region.startSeconds)) {
      anchors.push({ seconds: region.startSeconds, kind: "region-start" });
    }
    if (Number.isFinite(region.endSeconds)) {
      anchors.push({ seconds: region.endSeconds, kind: "region-end" });
    }
  }

  for (const clip of song.clips) {
    if (draggedIds.has(clip.id)) continue;
    anchors.push({
      seconds: clip.timelineStartSeconds,
      kind: "clip-start",
    });
    anchors.push({
      seconds: clip.timelineStartSeconds + clip.durationSeconds,
      kind: "clip-end",
    });
  }

  return anchors;
}

export type SnappedGroupResult = {
  /** Delta the whole group should move by, possibly adjusted to snap. */
  groupDelta: number;
  /** Anchor that was magneted onto, or null if no anchor was within range. */
  activeAnchor: ClipSnapAnchor | null;
};

/**
 * Given the proposed group delta from the cursor, find whether any member's
 * leading or trailing edge falls within `snapRadiusSeconds` of any anchor.
 * If so, adjust the delta so that the closest edge lands exactly on its
 * anchor — the whole group moves solidarily.
 *
 * Returns the (possibly snapped) delta and the anchor that was captured.
 */
export function findSnappedGroupDelta(
  members: ClipDragMember[],
  proposedDelta: number,
  anchors: ClipSnapAnchor[],
  snapRadiusSeconds: number,
  durationByClipId: Record<string, number>,
): SnappedGroupResult {
  if (anchors.length === 0 || members.length === 0) {
    return { groupDelta: proposedDelta, activeAnchor: null };
  }

  let bestDistance = snapRadiusSeconds;
  let bestDelta = proposedDelta;
  let bestAnchor: ClipSnapAnchor | null = null;

  // Both the start and end edge of every member can capture an anchor. The
  // first match within the radius wins; ties prefer the earlier-listed
  // anchor (playhead beats markers beats clips, by build order).
  for (const member of members) {
    const duration = durationByClipId[member.clipId] ?? 0;
    const candidateStart = member.originSeconds + proposedDelta;
    const candidateEnd = candidateStart + duration;
    for (const anchor of anchors) {
      const startDistance = Math.abs(candidateStart - anchor.seconds);
      if (startDistance <= bestDistance) {
        bestDistance = startDistance;
        bestDelta = anchor.seconds - member.originSeconds;
        bestAnchor = anchor;
      }
      if (duration > 0) {
        const endDistance = Math.abs(candidateEnd - anchor.seconds);
        if (endDistance <= bestDistance) {
          bestDistance = endDistance;
          bestDelta = anchor.seconds - member.originSeconds - duration;
          bestAnchor = anchor;
        }
      }
    }
  }

  return { groupDelta: bestDelta, activeAnchor: bestAnchor };
}
