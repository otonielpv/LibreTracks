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
    expect(timelineCanvasViewport(640, 420)).toEqual({
      top: 640,
      height: 420,
    });
    expect(timelineCanvasViewport(-10, 0)).toEqual({ top: 0, height: 1 });
  });
});
