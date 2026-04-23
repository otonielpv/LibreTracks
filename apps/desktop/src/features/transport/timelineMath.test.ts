import { describe, expect, it } from "vitest";

import {
  buildVisibleTimelineGrid,
  clientXToTimelineSeconds,
  getMusicalPosition,
  secondsToAbsoluteX,
  snapToTimelineGrid,
} from "./timelineMath";

describe("timelineMath", () => {
  it("uses the declared beat unit for musical positions", () => {
    expect(getMusicalPosition(0.25, 120, "6/8")).toEqual({
      barNumber: 1,
      beatInBar: 2,
      subBeat: 0,
      display: "1.2.00",
    });
  });

  it("snaps against the fixed timebase without drifting over long durations", () => {
    expect(snapToTimelineGrid(3600.124, 120, "4/4", 1, 1)).toBe(3600);
    expect(snapToTimelineGrid(3600.376, 120, "4/4", 1, 1)).toBe(3600.5);
  });

  it("builds visible markers from absolute frame positions", () => {
    const grid = buildVisibleTimelineGrid({
      durationSeconds: 4000,
      bpm: 120,
      timeSignature: "4/4",
      zoomLevel: 8,
      pixelsPerSecond: 144,
      viewportStartSeconds: 3599.9,
      viewportEndSeconds: 3601.1,
    });

    expect(grid.markers.some((marker) => marker.seconds === 3600)).toBe(true);
    expect(grid.markers.find((marker) => marker.seconds === 3600)?.barNumber).toBe(1801);
  });

  it("maps client coordinates into absolute timeline seconds using scroll offset", () => {
    const boundsElement = {
      getBoundingClientRect: () =>
        ({
          left: 100,
        }) as DOMRect,
    };

    expect(clientXToTimelineSeconds(160, boundsElement, { scrollLeft: 240 }, 20)).toBe(15);
  });

  it("converts seconds into absolute timeline pixels", () => {
    expect(secondsToAbsoluteX(12.5, 36)).toBe(450);
  });
});
