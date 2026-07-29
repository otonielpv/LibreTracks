import {
  useRef,
  useState,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { buildSongTempoRegions } from "@libretracks/shared/models";
import {
  getElementScaleX,
  screenXToSeconds,
  secondsToScreenX,
  snapToTimelineGrid,
} from "./timelineMath";
import type { SongView } from "../desktopApi";

const MARKER_DRAG_THRESHOLD_PX = 4;

export type MarkerMoveKind = "marker" | "cue";

type MarkerMoveDrag = {
  markerId: string;
  // Section flags and automation-cue diamonds share this drag machinery; only
  // the commit target differs (onMarkerMoveCommit vs onAutomationCueMoveCommit).
  kind: MarkerMoveKind;
  pointerId: number;
  pointerStartClientX: number;
  /**
   * Where the marker sat, in absolute lane screen space, when the drag began.
   * Only used for cues: they are positioned in raw screen coordinates rather
   * than inside a camera-transformed wrapper, so the drag re-derives seconds
   * from the live cameraX instead of accumulating a delta.
   */
  pointerStartLocalX: number;
  pointerScaleX: number;
  initialStartSeconds: number;
  previewStartSeconds: number;
  moved: boolean;
};

export type MarkerMovePreview = {
  markerId: string;
  startSeconds: number;
} | null;

export type MarkerMoveDragDeps = {
  song: SongView | null | undefined;
  snapEnabled: boolean | undefined;
  cameraXRef: MutableRefObject<number>;
  livePixelsPerSecondRef: MutableRefObject<number>;
  pixelsPerSecond: number;
  onMarkerMoveCommit?: (markerId: string, startSeconds: number) => void;
  onAutomationCueMoveCommit?: (cueId: string, atSeconds: number) => void;
};

/**
 * Drag a section flag or automation-cue diamond to reposition it.
 *
 * Optimistic: the hotspot follows the pointer during the drag and the backend
 * is touched once on release. Pointer events cover both mouse (desktop) and
 * touch (Android). A press that doesn't clear MARKER_DRAG_THRESHOLD_PX is left
 * to the element's own onClick, so tapping a marker still works.
 *
 * The two marker kinds live in different coordinate spaces, which is the whole
 * subtlety here. Ruler flags sit inside the ruler overlay, which CanvasTimeline
 * transforms with `translateX(-cameraX)`, so a plain pointer delta is already
 * in the right space. Cue diamonds sit in the track-lane area, which has no
 * such wrapper — the canvas paints them at an absolute screen X computed from
 * the live cameraX — so their drag has to work in that same absolute space, or
 * it desyncs from the diamond as soon as the timeline is scrolled or zoomed.
 */
export function useMarkerMoveDrag({
  song,
  snapEnabled,
  cameraXRef,
  livePixelsPerSecondRef,
  pixelsPerSecond,
  onMarkerMoveCommit,
  onAutomationCueMoveCommit,
}: MarkerMoveDragDeps) {
  const dragRef = useRef<MarkerMoveDrag | null>(null);
  // Set true the instant a drag actually moves; consumed by the marker's
  // onClick to swallow the synthetic click that follows pointer-up (the drag
  // ref is already nulled by then). Reset on the next pointerdown.
  const didDragRef = useRef(false);
  const [preview, setPreview] = useState<MarkerMovePreview>(null);
  // Mirror for the rAF hotspot placement, which runs outside React and must see
  // the in-flight drag position without waiting for a re-render.
  const previewRef = useRef(preview);
  previewRef.current = preview;

  function begin(
    event: ReactPointerEvent<HTMLButtonElement>,
    markerId: string,
    startSeconds: number,
    kind: MarkerMoveKind = "marker",
  ) {
    if (event.button !== 0) return;
    didDragRef.current = false;
    // Derive the grab anchor from the marker's own position rather than the
    // cursor's, so the pointer may land anywhere inside the hotspot without
    // shifting the marker on the first move.
    const pointerStartLocalX = secondsToScreenX(
      startSeconds,
      cameraXRef.current,
      livePixelsPerSecondRef.current ?? pixelsPerSecond,
    );
    dragRef.current = {
      markerId,
      kind,
      pointerId: event.pointerId,
      pointerStartClientX: event.clientX,
      pointerStartLocalX,
      pointerScaleX: getElementScaleX(
        event.currentTarget.getBoundingClientRect(),
        event.currentTarget.offsetWidth,
      ),
      initialStartSeconds: startSeconds,
      previewStartSeconds: startSeconds,
      moved: false,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Some engines refuse capture on a not-yet-hovered element; ignore.
    }
  }

  function update(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId || !song) return;

    const effectivePixelsPerSecond =
      livePixelsPerSecondRef.current ?? pixelsPerSecond;
    if (effectivePixelsPerSecond <= 0) return;

    const pointerDeltaPx =
      (event.clientX - drag.pointerStartClientX) / drag.pointerScaleX;

    // Cues resolve against the live camera (so they keep tracking the pointer
    // even if the timeline pans mid-drag); ruler flags use the plain delta.
    const rawDelta =
      drag.kind === "cue"
        ? screenXToSeconds(
            drag.pointerStartLocalX + pointerDeltaPx,
            cameraXRef.current,
            effectivePixelsPerSecond,
          ) - drag.initialStartSeconds
        : pointerDeltaPx / effectivePixelsPerSecond;

    // Only start treating this as a drag once the pointer clears the threshold,
    // so a stationary tap/click still fires the primary action.
    if (
      !drag.moved &&
      Math.abs(event.clientX - drag.pointerStartClientX) <
        MARKER_DRAG_THRESHOLD_PX
    ) {
      return;
    }
    drag.moved = true;
    didDragRef.current = true;

    let nextStart = drag.initialStartSeconds + rawDelta;

    // Snap to the song grid (same grid the user sees). Holding Shift bypasses.
    const shouldSnap = Boolean(snapEnabled) && !event.shiftKey;
    if (shouldSnap) {
      nextStart = snapToTimelineGrid(
        nextStart,
        song.bpm,
        song.timeSignature,
        1,
        effectivePixelsPerSecond,
        buildSongTempoRegions(song),
      );
    }

    // A marker can't sit before the timeline start.
    nextStart = Math.max(0, nextStart);

    drag.previewStartSeconds = nextStart;
    setPreview({ markerId: drag.markerId, startSeconds: nextStart });
  }

  function end(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Already released — ignore.
    }

    const finalStart = drag.previewStartSeconds;
    const moved =
      drag.moved && Math.abs(finalStart - drag.initialStartSeconds) > 1e-6;

    dragRef.current = null;
    setPreview(null);

    if (!moved) {
      return;
    }
    if (drag.kind === "cue") {
      onAutomationCueMoveCommit?.(drag.markerId, finalStart);
    } else {
      onMarkerMoveCommit?.(drag.markerId, finalStart);
    }
  }

  return {
    markerMovePreview: preview,
    markerMovePreviewRef: previewRef,
    markerDidDragRef: didDragRef,
    beginMarkerMove: begin,
    updateMarkerMove: update,
    endMarkerMove: end,
  };
}
