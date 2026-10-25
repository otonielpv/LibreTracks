import {
  buildSongTempoRegions,
  getSongTempoRegionAtPosition,
  type ClipSummary,
  type SongRegionSummary,
  type SongView,
} from "@libretracks/shared/models";

import { CLIP_SNAP_RADIUS_PX } from "../../constants";
import { findSnappedGroupDelta } from "../../timeline/clipSnapping";
import { snapToTimelineGrid } from "../../timeline/timelineMath";
import type { ClipDragMember, ClipSnapAnchor } from "../../types";

/** The backend's floor for a clip window (validate_clip_window). */
export const MIN_CLIP_WINDOW_SECONDS = 0.05;
/** A clip never starts ON the song end: it would belong to the next song. */
const SONG_END_MARGIN_SECONDS = 0.05;

export type ClipDragInput = {
  song: SongView;
  region: Pick<SongRegionSummary, "startSeconds" | "endSeconds">;
  members: ClipDragMember[];
  /** The clip under the pointer: the grid snaps ITS start, keeping the
   * group's spacing (like the DAW). */
  primaryClipId: string;
  rawDeltaSeconds: number;
  pxPerSecond: number;
  snapEnabled: boolean;
  /** Ctrl/⌘ held: magnet to the anchors instead of the grid. */
  magnet: boolean;
  anchors: ClipSnapAnchor[];
};

export type ClipDragResult = {
  groupDelta: number;
  activeAnchor: ClipSnapAnchor | null;
};

/**
 * Where a dragged group of clips lands. The same rules as the DAW's clip
 * drag (hooks/useDragListeners): Ctrl/⌘ magnets every member's edges to the
 * playhead, markers, song edges and other clips (findSnappedGroupDelta);
 * otherwise the primary clip snaps to the grid the user sees
 * (snapToTimelineGrid). Then the lanes' own rule: the group stays inside
 * the song.
 */
export function resolveClipDrag(input: ClipDragInput): ClipDragResult {
  const { song, region, members, rawDeltaSeconds, pxPerSecond } = input;
  if (members.length === 0) return { groupDelta: 0, activeAnchor: null };
  const durationById: Record<string, number> = {};
  for (const member of members) {
    durationById[member.clipId] =
      song.clips.find((clip) => clip.id === member.clipId)?.durationSeconds ?? 0;
  }

  let groupDelta = rawDeltaSeconds;
  let activeAnchor: ClipSnapAnchor | null = null;
  if (input.magnet && input.anchors.length > 0 && pxPerSecond > 0) {
    const snapped = findSnappedGroupDelta(
      members,
      rawDeltaSeconds,
      input.anchors,
      CLIP_SNAP_RADIUS_PX / pxPerSecond,
      durationById,
    );
    groupDelta = snapped.groupDelta;
    activeAnchor = snapped.activeAnchor;
  } else if (input.snapEnabled) {
    const primary =
      members.find((member) => member.clipId === input.primaryClipId) ?? members[0];
    const target = primary.originSeconds + rawDeltaSeconds;
    const timing = getSongTempoRegionAtPosition(song, target);
    const snapped = snapToTimelineGrid(
      target,
      timing?.bpm ?? song.bpm,
      timing?.timeSignature ?? song.timeSignature,
      1,
      pxPerSecond,
      buildSongTempoRegions(song),
    );
    groupDelta = snapped - primary.originSeconds;
  }

  return { groupDelta: clampGroupToSong(members, groupDelta, region), activeAnchor };
}

/** Every member's start stays inside the song (and never before 0). */
export function clampGroupToSong(
  members: readonly Pick<ClipDragMember, "originSeconds">[],
  delta: number,
  region: Pick<SongRegionSummary, "startSeconds" | "endSeconds">,
): number {
  if (members.length === 0) return 0;
  const earliest = Math.min(...members.map((member) => member.originSeconds));
  const latest = Math.max(...members.map((member) => member.originSeconds));
  const minDelta = Math.max(region.startSeconds, 0) - earliest;
  const maxDelta = region.endSeconds - SONG_END_MARGIN_SECONDS - latest;
  return Math.max(minDelta, Math.min(maxDelta, delta));
}

export type ClipWindow = {
  timelineStartSeconds: number;
  sourceStartSeconds: number;
  durationSeconds: number;
};

/**
 * Trimming one edge of a clip. The start edge moves the timeline start and
 * the source start together (the audio stays where it was); the end edge
 * only changes the duration. Never below the backend's minimum window,
 * never before the file's start, past its end, or outside the song.
 *
 * Only for clips in songs without warp: there view time is source time.
 */
export function resolveClipTrim(
  clip: Pick<
    ClipSummary,
    "timelineStartSeconds" | "sourceStartSeconds" | "durationSeconds" | "sourceDurationSeconds"
  >,
  edge: "start" | "end",
  deltaSeconds: number,
  region: Pick<SongRegionSummary, "startSeconds" | "endSeconds">,
): ClipWindow {
  if (edge === "start") {
    const minDelta = Math.max(
      -clip.sourceStartSeconds,
      region.startSeconds - clip.timelineStartSeconds,
    );
    const maxDelta = clip.durationSeconds - MIN_CLIP_WINDOW_SECONDS;
    const delta = Math.max(minDelta, Math.min(maxDelta, deltaSeconds));
    return {
      timelineStartSeconds: clip.timelineStartSeconds + delta,
      sourceStartSeconds: clip.sourceStartSeconds + delta,
      durationSeconds: clip.durationSeconds - delta,
    };
  }
  const fileLeft = clip.sourceDurationSeconds - clip.sourceStartSeconds;
  const maxDuration = Math.min(fileLeft, region.endSeconds - clip.timelineStartSeconds);
  const duration = Math.max(
    MIN_CLIP_WINDOW_SECONDS,
    Math.min(maxDuration, clip.durationSeconds + deltaSeconds),
  );
  return {
    timelineStartSeconds: clip.timelineStartSeconds,
    sourceStartSeconds: clip.sourceStartSeconds,
    durationSeconds: duration,
  };
}
