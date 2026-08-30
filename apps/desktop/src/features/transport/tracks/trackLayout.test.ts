import { describe, expect, it } from "vitest";

import { TRACK_HEIGHT_MIN, TRACK_HEIGHT_ROW_MAX } from "../constants";
import {
  buildTrackRowLayout,
  trackHeightOffsetFor,
  trackRowDeltaForDrag,
  trackRowHeight,
} from "./trackLayout";

const uniform = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("trackRowHeight", () => {
  it("is the global height when the track carries no offset", () => {
    expect(trackRowHeight(76)).toBe(76);
    expect(trackRowHeight(76, null)).toBe(76);
    expect(trackRowHeight(76, 0)).toBe(76);
  });

  it("adds the offset to the global height", () => {
    expect(trackRowHeight(76, 40)).toBe(116);
    expect(trackRowHeight(76, -30)).toBe(46);
  });

  it("clamps a row to the single-row range", () => {
    expect(trackRowHeight(76, -900)).toBe(TRACK_HEIGHT_MIN);
    expect(trackRowHeight(76, 9000)).toBe(TRACK_HEIGHT_ROW_MAX);
  });

  it("lets one row go past the global maximum", () => {
    // The whole point of the feature: open one track up while the rest stay
    // collapsed. The global control's ceiling does not apply to a single row.
    expect(trackRowHeight(18, 300)).toBe(318);
  });
});

describe("trackHeightOffsetFor", () => {
  it("returns null for the global height, so nothing is stored", () => {
    expect(trackHeightOffsetFor(76, 76)).toBeNull();
  });

  it("is the difference from the global height", () => {
    expect(trackHeightOffsetFor(76, 120)).toBe(44);
    expect(trackHeightOffsetFor(76, 40)).toBe(-36);
  });

  it("clamps the target before measuring the offset", () => {
    expect(trackHeightOffsetFor(76, 5)).toBe(TRACK_HEIGHT_MIN - 76);
    expect(trackHeightOffsetFor(76, 5000)).toBe(TRACK_HEIGHT_ROW_MAX - 76);
  });

  it("survives a round trip through trackRowHeight", () => {
    const offset = trackHeightOffsetFor(30, 220);
    expect(trackRowHeight(30, offset)).toBe(220);
  });
});

describe("buildTrackRowLayout", () => {
  it("stacks uniform rows and reports it as uniform", () => {
    const layout = buildTrackRowLayout(uniform, 80);

    expect(layout.heights).toEqual([80, 80, 80]);
    expect(layout.tops).toEqual([0, 80, 160]);
    expect(layout.totalHeight).toBe(240);
    expect(layout.isUniform).toBe(true);
  });

  it("stacks rows of different heights", () => {
    const layout = buildTrackRowLayout(
      [{ id: "a" }, { id: "b", heightOffset: 120 }, { id: "c" }],
      40,
    );

    expect(layout.heights).toEqual([40, 160, 40]);
    expect(layout.tops).toEqual([0, 40, 200]);
    expect(layout.totalHeight).toBe(240);
    expect(layout.isUniform).toBe(false);
    expect(layout.heightOf("b")).toBe(160);
    expect(layout.topOf("c")).toBe(200);
  });

  it("answers for ids it does not know", () => {
    const layout = buildTrackRowLayout(uniform, 80);

    expect(layout.heightOf("missing")).toBe(80);
    expect(layout.topOf("missing")).toBeNull();
  });

  it("finds the row a y lands in when rows differ in height", () => {
    // 40 / 160 / 40 => bands [0,40) [40,200) [200,240)
    const layout = buildTrackRowLayout(
      [{ id: "a" }, { id: "b", heightOffset: 120 }, { id: "c" }],
      40,
    );

    expect(layout.rowAt(0)).toBe(0);
    expect(layout.rowAt(39)).toBe(0);
    expect(layout.rowAt(40)).toBe(1);
    expect(layout.rowAt(199)).toBe(1);
    expect(layout.rowAt(200)).toBe(2);
    // Off both ends: clamped into the existing rows.
    expect(layout.rowAt(-50)).toBe(0);
    expect(layout.rowAt(9000)).toBe(2);
  });

  it("has no rows to find when there are no tracks", () => {
    const layout = buildTrackRowLayout([], 80);

    expect(layout.totalHeight).toBe(0);
    expect(layout.rowAt(120)).toBe(0);
  });
});

describe("trackRowDeltaForDrag", () => {
  it("divides by the shared height while every row matches", () => {
    const layout = buildTrackRowLayout(uniform, 80);

    expect(trackRowDeltaForDrag(layout, 0, 0)).toBe(0);
    expect(trackRowDeltaForDrag(layout, 0, 80)).toBe(1);
    expect(trackRowDeltaForDrag(layout, 2, -160)).toBe(-2);
  });

  it("counts the rows the dragged row's centre actually crossed", () => {
    // 40 / 160 / 40 — dragging from row 0 (centre 20) has to travel past the
    // whole tall row before it reaches row 2, which a division would get wrong.
    const layout = buildTrackRowLayout(
      [{ id: "a" }, { id: "b", heightOffset: 120 }, { id: "c" }],
      40,
    );

    expect(trackRowDeltaForDrag(layout, 0, 30)).toBe(1);
    expect(trackRowDeltaForDrag(layout, 0, 100)).toBe(1);
    expect(trackRowDeltaForDrag(layout, 0, 190)).toBe(2);
    expect(trackRowDeltaForDrag(layout, 2, -100)).toBe(-1);
  });

  it("falls back to the uniform maths for a row it cannot place", () => {
    const layout = buildTrackRowLayout(
      [{ id: "a" }, { id: "b", heightOffset: 120 }],
      40,
    );

    expect(trackRowDeltaForDrag(layout, -1, 80)).toBe(2);
  });
});
