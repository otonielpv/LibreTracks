import { describe, expect, it } from "vitest";

import {
  MARKER_SCROLL_TOP_PADDING_PX,
  resolveMarkerAutoScrollTop,
  type MarkerAutoScrollInput,
} from "./markerAutoScroll";

/** A phone-sized grid: 300px tall viewport over 900px of cards (~6 rows of
 * 150px), scrolled to the top. */
function grid(overrides: Partial<MarkerAutoScrollInput> = {}): MarkerAutoScrollInput {
  return {
    scrollTop: 0,
    viewportHeight: 300,
    contentHeight: 900,
    cardTop: 0,
    cardHeight: 150,
    ...overrides,
  };
}

describe("resolveMarkerAutoScrollTop", () => {
  it("does not scroll when the next card is already fully visible", () => {
    expect(resolveMarkerAutoScrollTop(grid({ cardTop: 150 }))).toBeNull();
  });

  it("parks a card below the fold at the top of the viewport", () => {
    // Row 3 (300..450) starts exactly at the fold: only invisible rows follow.
    expect(resolveMarkerAutoScrollTop(grid({ cardTop: 300 }))).toBe(
      300 - MARKER_SCROLL_TOP_PADDING_PX,
    );
  });

  it("scrolls for a card that is only half visible", () => {
    // Viewport 0..300 with the row at 200..350: the bottom half is cut off,
    // which is exactly the "half a row peeking" case on a phone.
    expect(resolveMarkerAutoScrollTop(grid({ cardTop: 200 }))).toBe(
      200 - MARKER_SCROLL_TOP_PADDING_PX,
    );
  });

  it("scrolls back up when the next marker is behind the viewport", () => {
    // After a jump backwards the next marker can be above what's on screen.
    const target = resolveMarkerAutoScrollTop(
      grid({ scrollTop: 600, cardTop: 150 }),
    );
    expect(target).toBe(150 - MARKER_SCROLL_TOP_PADDING_PX);
  });

  it("clamps to the bottom of the scroller for the last rows", () => {
    // Last row (750..900) cannot be parked at the top: max scrollTop is 600.
    expect(resolveMarkerAutoScrollTop(grid({ cardTop: 750 }))).toBe(600);
  });

  it("does nothing when the whole grid fits", () => {
    expect(
      resolveMarkerAutoScrollTop(grid({ contentHeight: 280, cardTop: 150 })),
    ).toBeNull();
  });

  it("does not report a scroll that would not move the grid", () => {
    // Already pinned at the bottom and the next card is the last row.
    expect(
      resolveMarkerAutoScrollTop(grid({ scrollTop: 600, cardTop: 750 })),
    ).toBeNull();
  });

  it("tolerates sub-pixel overhang instead of nudging the grid", () => {
    // Row bottom sits 1px past the fold: layout rounding, not a hidden row.
    expect(
      resolveMarkerAutoScrollTop(grid({ cardTop: 151, cardHeight: 150 })),
    ).toBeNull();
  });

  it("returns null when there is no measurable geometry", () => {
    expect(
      resolveMarkerAutoScrollTop(grid({ viewportHeight: 0 })),
    ).toBeNull();
    expect(
      resolveMarkerAutoScrollTop(grid({ cardTop: Number.NaN })),
    ).toBeNull();
  });
});
