export const TRACK_DRAG_EDGE_ZONE_PX = 28;
export const TRACK_DRAG_MAX_SCROLL_PX_PER_FRAME = 18;

/** Signed per-frame scroll speed for a pointer near the track viewport edges. */
export function trackDragAutoScrollVelocity(
  pointerClientY: number,
  topEdge: number,
  bottomEdge: number,
) {
  if (pointerClientY < topEdge + TRACK_DRAG_EDGE_ZONE_PX) {
    const proximity = Math.min(
      1,
      Math.max(
        0,
        (topEdge + TRACK_DRAG_EDGE_ZONE_PX - pointerClientY) /
          TRACK_DRAG_EDGE_ZONE_PX,
      ),
    );
    return -Math.max(1, Math.round(proximity * TRACK_DRAG_MAX_SCROLL_PX_PER_FRAME));
  }
  if (pointerClientY > bottomEdge - TRACK_DRAG_EDGE_ZONE_PX) {
    const proximity = Math.min(
      1,
      Math.max(
        0,
        (pointerClientY - (bottomEdge - TRACK_DRAG_EDGE_ZONE_PX)) /
          TRACK_DRAG_EDGE_ZONE_PX,
      ),
    );
    return Math.max(1, Math.round(proximity * TRACK_DRAG_MAX_SCROLL_PX_PER_FRAME));
  }
  return 0;
}
