import { describe, expect, it } from "vitest";

import {
  timelineCanvasPixelRatio,
  timelineCanvasViewport,
} from "./canvasPixelRatio";

describe("timelineCanvasPixelRatio", () => {
  it("caps high-density mobile canvases at DPR 2", () => {
    expect(timelineCanvasPixelRatio(3, true)).toBe(2);
    expect(timelineCanvasPixelRatio(4, true)).toBe(2);
  });

  it("keeps desktop and low-density mobile ratios intact", () => {
    expect(timelineCanvasPixelRatio(3, false)).toBe(3);
    expect(timelineCanvasPixelRatio(1.5, true)).toBe(1.5);
  });

  it("sizes the backing store to the viewport rather than all track rows", () => {
    expect(timelineCanvasViewport(640, 420, 4000)).toEqual({
      top: 640,
      height: 420,
    });
    expect(timelineCanvasViewport(-10, 0, 4000)).toEqual({ top: 0, height: 1 });
  });

  // The canvases are absolutely positioned inside the track layer, so a slice
  // hanging below the scene extends the scroll container's scrollable overflow.
  // That raises the max scrollTop, which pushes the next slice further down:
  // endless vertical scroll trailing empty black space.
  it("never lets the slice hang below the painted scene", () => {
    expect(timelineCanvasViewport(560, 420, 700)).toEqual({
      top: 280,
      height: 420,
    });
    // Fewer tracks than the viewport fits: the slice is the whole scene and
    // stays pinned at the top, adding no scroll of its own.
    expect(timelineCanvasViewport(0, 900, 500)).toEqual({ top: 0, height: 500 });
    expect(timelineCanvasViewport(300, 900, 500)).toEqual({
      top: 0,
      height: 500,
    });
  });

  it("floors fractional metrics so rounding cannot re-open the scroll loop", () => {
    const scene = 700.4;
    const slice = timelineCanvasViewport(281.7, 420.9, scene);
    expect(slice).toEqual({ top: 280, height: 420 });
    expect(slice.top + slice.height).toBeLessThanOrEqual(scene);
  });
});
