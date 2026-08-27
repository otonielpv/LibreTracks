import { describe, expect, it } from "vitest";

import {
  TRACK_DRAG_MAX_SCROLL_PX_PER_FRAME,
  trackDragAutoScrollVelocity,
} from "./trackDragAutoScroll";

describe("trackDragAutoScrollVelocity", () => {
  it("scrolls toward the edge and stays idle in the middle", () => {
    expect(trackDragAutoScrollVelocity(110, 100, 600)).toBeLessThan(0);
    expect(trackDragAutoScrollVelocity(590, 100, 600)).toBeGreaterThan(0);
    expect(trackDragAutoScrollVelocity(350, 100, 600)).toBe(0);
  });

  it("does not trigger until the pointer is very close to an edge", () => {
    expect(trackDragAutoScrollVelocity(140, 100, 600)).toBe(0);
    expect(trackDragAutoScrollVelocity(560, 100, 600)).toBe(0);
  });

  it("caps pointers outside the viewport", () => {
    expect(trackDragAutoScrollVelocity(-100, 100, 600)).toBe(
      -TRACK_DRAG_MAX_SCROLL_PX_PER_FRAME,
    );
    expect(trackDragAutoScrollVelocity(900, 100, 600)).toBe(
      TRACK_DRAG_MAX_SCROLL_PX_PER_FRAME,
    );
  });
});
