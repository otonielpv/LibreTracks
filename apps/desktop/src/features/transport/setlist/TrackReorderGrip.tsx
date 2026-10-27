import type { PointerEvent as ReactPointerEvent } from "react";

import type { SongViewBindings } from "../songs/songViewBindings";
import { useTimelineUIStore } from "../uiStore";

type TrackReorderGripProps = {
  trackId: string;
  label: string;
  onTrackDragStart: SongViewBindings["onTrackDragStart"];
};

/**
 * The handle that reorders a track in Edit → Tracks: the DAW's own track
 * drag (`onTrackDragStart`). The DAW only lets a finger drag a track in its
 * «reorder mode», so a scroll is never taken for a drag; this handle is
 * explicit, so a finger on it turns that mode on for the drag (the iPhone
 * report: the tracks had a handle and did not move).
 */
export function TrackReorderGrip({ trackId, label, onTrackDragStart }: TrackReorderGripProps) {
  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch" && !useTimelineUIStore.getState().trackReorderMode) {
      useTimelineUIStore.setState({ trackReorderMode: true });
      const restore = () => {
        window.removeEventListener("pointerup", restore);
        window.removeEventListener("pointercancel", restore);
        // After the drag's own pointerup handler has run.
        window.setTimeout(() => useTimelineUIStore.setState({ trackReorderMode: false }), 0);
      };
      window.addEventListener("pointerup", restore);
      window.addEventListener("pointercancel", restore);
    }
    onTrackDragStart(event, trackId);
  };
  return (
    <div
      className="lt-setlist-track-grip material-symbols-outlined"
      role="button"
      aria-label={label}
      title={label}
      onPointerDown={start}
    >
      drag_indicator
    </div>
  );
}
