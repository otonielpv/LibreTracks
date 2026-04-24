import { describe, expect, it } from "vitest";

import {
  buildVisibleTimelineGrid,
  clientXToTimelineSeconds,
  getContentWidth,
  getCumulativeMusicalPosition,
  getMusicalPosition,
  getTimelineWorkspaceEndSeconds,
  getZoomLevelDelta,
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

  it("accumulates bar numbers across consecutive regions", () => {
    const regions = [
      { startSeconds: 0, endSeconds: 8, bpm: 120, timeSignature: "4/4" },
      { startSeconds: 8, endSeconds: 14, bpm: 120, timeSignature: "6/8" },
    ];

    expect(getCumulativeMusicalPosition(8.25, regions)).toEqual({
      barNumber: 5,
      beatInBar: 2,
      subBeat: 0,
      display: "5.2.00",
    });
  });

  it("falls back to global timing when no regions are provided", () => {
    expect(getCumulativeMusicalPosition(3.25, [])).toEqual(
      getMusicalPosition(3.25, 120, "4/4"),
    );
  });

  it("uses the next region exactly at the shared boundary", () => {
    const regions = [
      { startSeconds: 0, endSeconds: 8, bpm: 120, timeSignature: "4/4" },
      { startSeconds: 8, endSeconds: 14, bpm: 120, timeSignature: "6/8" },
    ];

    expect(getCumulativeMusicalPosition(8, regions)).toEqual({
      barNumber: 5,
      beatInBar: 1,
      subBeat: 0,
      display: "5.1.00",
    });
  });

  it("sorts unsorted regions and ignores invalid zero-length entries", () => {
    const regions = [
      { startSeconds: 8, endSeconds: 14, bpm: 120, timeSignature: "6/8" },
      { startSeconds: 4, endSeconds: 4, bpm: 300, timeSignature: "7/8" },
      { startSeconds: 0, endSeconds: 8, bpm: 120, timeSignature: "4/4" },
    ];

    expect(getCumulativeMusicalPosition(8.5, regions)).toEqual({
      barNumber: 5,
      beatInBar: 3,
      subBeat: 0,
      display: "5.3.00",
    });
  });

  it("builds visible markers cumulatively across region boundaries", () => {
    const grid = buildVisibleTimelineGrid({
      durationSeconds: 14,
      bpm: 120,
      timeSignature: "4/4",
      regions: [
        { startSeconds: 0, endSeconds: 8, bpm: 120, timeSignature: "4/4" },
        { startSeconds: 8, endSeconds: 14, bpm: 120, timeSignature: "6/8" },
      ],
      zoomLevel: 8,
      pixelsPerSecond: 144,
      viewportStartSeconds: 7.75,
      viewportEndSeconds: 8.75,
    });

    expect(grid.markers.find((marker) => marker.seconds === 8)?.barNumber).toBe(5);
    expect(grid.markers.find((marker) => marker.seconds === 8)?.beatInBar).toBe(1);
  });

  it("fills implicit timing before a late explicit region so the timeline does not restart", () => {
    const grid = buildVisibleTimelineGrid({
      durationSeconds: 20,
      bpm: 120,
      timeSignature: "4/4",
      regions: [
        { startSeconds: 8, endSeconds: 14, bpm: 120, timeSignature: "6/8" },
      ],
      zoomLevel: 8,
      pixelsPerSecond: 144,
      viewportStartSeconds: 0,
      viewportEndSeconds: 10,
    });

    expect(grid.markers.find((marker) => marker.seconds === 0)).toMatchObject({
      barNumber: 1,
      beatInBar: 1,
      isBarStart: true,
    });
    expect(grid.markers.find((marker) => marker.seconds === 8)).toMatchObject({
      barNumber: 5,
      beatInBar: 1,
      isBarStart: true,
    });
  });

  it("falls back to a single implicit region when all provided regions are invalid", () => {
    const grid = buildVisibleTimelineGrid({
      durationSeconds: 4,
      bpm: 120,
      timeSignature: "4/4",
      regions: [{ startSeconds: 2, endSeconds: 2, bpm: 90, timeSignature: "5/4" }],
      zoomLevel: 8,
      pixelsPerSecond: 144,
      viewportStartSeconds: 0,
      viewportEndSeconds: 1,
    });

    expect(grid.markers[0]).toMatchObject({
      seconds: 0,
      barNumber: 1,
      beatInBar: 1,
      isBarStart: true,
    });
    expect(grid.beatDurationSeconds).toBe(0.5);
  });

  it("clamps visible start and end seconds to the declared duration", () => {
    const grid = buildVisibleTimelineGrid({
      durationSeconds: 10,
      bpm: 120,
      timeSignature: "4/4",
      zoomLevel: 8,
      pixelsPerSecond: 144,
      viewportStartSeconds: -5,
      viewportEndSeconds: 99,
    });

    expect(grid.visibleStartSeconds).toBe(0);
    expect(grid.visibleEndSeconds).toBe(10);
  });

  it("snaps using the active region beat grid", () => {
    const regions = [
      { startSeconds: 0, endSeconds: 8, bpm: 120, timeSignature: "4/4" },
      { startSeconds: 8, endSeconds: 14, bpm: 60, timeSignature: "4/4" },
    ];

    expect(snapToTimelineGrid(8.49, 120, "4/4", 1, 1, regions)).toBe(8);
    expect(snapToTimelineGrid(8.51, 120, "4/4", 1, 1, regions)).toBe(9);
  });

  it("clamps snapping to the end of the active region", () => {
    const regions = [{ startSeconds: 8, endSeconds: 8.6, bpm: 60, timeSignature: "4/4" }];

    expect(snapToTimelineGrid(8.59, 120, "4/4", 1, 1, regions)).toBe(8.6);
  });

  it("uses fallback bpm and time signature when region values are invalid", () => {
    const regions = [{ startSeconds: 0, endSeconds: 2, bpm: 0, timeSignature: "" }];

    expect(getCumulativeMusicalPosition(0.5, regions, 120, "3/4")).toEqual({
      barNumber: 1,
      beatInBar: 2,
      subBeat: 0,
      display: "1.2.00",
    });
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

  it("uses multiplicative zoom deltas instead of additive steps", () => {
    expect(getZoomLevelDelta(8, "in")).toBeCloseTo(9.2);
    expect(getZoomLevelDelta(8, "out")).toBeCloseTo(8 / 1.15);
  });

  it("extends the workspace by one hour past the furthest content", () => {
    expect(getTimelineWorkspaceEndSeconds(12, 45)).toBe(3645);
    expect(getContentWidth(12, 18, 45)).toBe(3645 * 18);
  });
});
