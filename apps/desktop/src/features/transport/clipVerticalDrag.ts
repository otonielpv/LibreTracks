import type { TimelineTrackSummary } from "./pendingAudioImports";
import type { ClipDragMember } from "./types";

/**
 * A track row is a valid drop target for a clip when it exists, is not a
 * folder lane, and is not a pending (not-yet-created) import placeholder.
 */
function isDroppableTrack(track: TimelineTrackSummary | undefined): boolean {
  return Boolean(track) && track!.kind !== "folder" && !track!.isPending;
}

/**
 * Clamp a desired vertical row delta so that EVERY dragged member lands on a
 * droppable track. The whole group moves by the same delta (preserving the
 * relative vertical spacing of a multi-selection), so the returned delta is the
 * one closest to `desiredRowDelta` for which no member falls out of bounds or
 * onto a folder lane. Falls back to 0 when even staying put would be invalid
 * (e.g. a member's origin track vanished mid-drag).
 */
export function clampGroupRowDelta(
  members: ClipDragMember[],
  desiredRowDelta: number,
  visibleTracks: TimelineTrackSummary[],
): number {
  if (desiredRowDelta === 0 || members.length === 0) {
    return 0;
  }

  const originIndexByMember = members.map((member) =>
    visibleTracks.findIndex((track) => track.id === member.originTrackId),
  );
  // If any member's origin row can't be located, vertical movement is unsafe.
  if (originIndexByMember.some((index) => index < 0)) {
    return 0;
  }

  const step = desiredRowDelta > 0 ? 1 : -1;
  let bestDelta = 0;
  // Walk outward from 0 toward the desired delta; stop at the last delta where
  // every member still lands on a droppable track.
  for (let delta = step; Math.abs(delta) <= Math.abs(desiredRowDelta); delta += step) {
    const allValid = originIndexByMember.every((originIndex) =>
      isDroppableTrack(visibleTracks[originIndex + delta]),
    );
    if (!allValid) {
      break;
    }
    bestDelta = delta;
  }
  return bestDelta;
}

/**
 * Resolve the destination track id for a member given a (already clamped) row
 * delta. Returns null when the delta is 0 or the target can't be resolved, so
 * callers can omit `targetTrackId` and leave the clip on its current track.
 */
export function resolveMemberTargetTrackId(
  member: ClipDragMember,
  rowDelta: number,
  visibleTracks: TimelineTrackSummary[],
): string | null {
  if (rowDelta === 0) {
    return null;
  }
  const originIndex = visibleTracks.findIndex(
    (track) => track.id === member.originTrackId,
  );
  if (originIndex < 0) {
    return null;
  }
  const target = visibleTracks[originIndex + rowDelta];
  if (!isDroppableTrack(target)) {
    return null;
  }
  return target.id;
}
