import type { TimelineMenuDeps } from "../menus/timelineMenus";
import { createTimelineItemHandlers } from "./timelineItemHandlers";

/** The duplicate/copy handlers built from the menus' deps, so the MIDI and
 * cue menus need no new wiring through timelineMenus (under a size budget). */
export function timelineItemHandlersFrom(getDeps: () => TimelineMenuDeps) {
  const d = getDeps();
  return createTimelineItemHandlers({
    getSong: () => getDeps().songRef.current,
    runAction: d.runAction,
    applyPlaybackSnapshot: d.applyPlaybackSnapshot,
    refreshSongView: (options) => d.refreshSongView(options),
    setStatus: d.setStatus,
    t: d.t,
  });
}
