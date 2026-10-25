import {
  moveClipsBatch,
  updateClipWindow,
  type ClipMoveRequest,
  type TransportSnapshot,
} from "../../desktopApi";
import { requestClipEdit } from "../../structure/structureGuard";
import type { ClipWindow } from "./laneGestures";

/**
 * The commits of a lane gesture: ONE command when the pointer is released,
 * through the panel's runAction and the snapshot it returns. A move is the
 * same batch command the DAW's clip drag commits (moveClipsBatch, track
 * change included); a trim is update_clip_window. Both ask the arrangement
 * guard first. Split, duplicate and delete are not here: the lanes run the
 * DAW's own shortcut actions for those.
 */
export type LaneClipHandlerDeps = {
  runAction: (action: () => Promise<void>) => Promise<void>;
  applySnapshot: (snapshot: TransportSnapshot) => void;
};

export function createLaneClipHandlers(getDeps: () => LaneClipHandlerDeps) {
  function commitMove(moves: ClipMoveRequest[]): boolean {
    if (moves.length === 0) return false;
    if (!requestClipEdit(moves.map((move) => move.clipId))) return false;
    const deps = getDeps();
    void deps.runAction(async () => deps.applySnapshot(await moveClipsBatch(moves)));
    return true;
  }

  function commitTrim(clipId: string, window: ClipWindow): boolean {
    if (!requestClipEdit([clipId])) return false;
    const deps = getDeps();
    void deps.runAction(async () =>
      deps.applySnapshot(
        await updateClipWindow(
          clipId,
          window.timelineStartSeconds,
          window.sourceStartSeconds,
          window.durationSeconds,
        ),
      ),
    );
    return true;
  }

  return { commitMove, commitTrim };
}

export type LaneClipHandlers = ReturnType<typeof createLaneClipHandlers>;
