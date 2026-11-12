import { describe, expect, it } from "vitest";

import {
  reorderedSongLayout,
  songDragReorderIndex,
  songStepReorderIndex,
} from "./songDropReorder";

// A [10,70) · B [70,130) · hueco de 20 · C [150,210)
const regions = [
  { id: "C", startSeconds: 150, endSeconds: 210 },
  { id: "A", startSeconds: 10, endSeconds: 70 },
  { id: "B", startSeconds: 70, endSeconds: 130 },
];

describe("songDragReorderIndex", () => {
  it("reorders once the dragged song's center passes another's", () => {
    // C (60 s) starting at 60: center 90 < B's center 100 → before B.
    expect(songDragReorderIndex(regions, "C", 60)).toBe(1);
    // A starting at 80: center 110 > B's center 100 → after B.
    expect(songDragReorderIndex(regions, "A", 80)).toBe(1);
    expect(songDragReorderIndex(regions, "A", 160)).toBe(2);
  });

  it("goes first without reaching the very start of the timeline", () => {
    // C's center at 35 is still left of A's (40).
    expect(songDragReorderIndex(regions, "C", 5)).toBe(0);
    expect(songDragReorderIndex(regions, "B", -20)).toBe(0);
  });

  it("is a plain move while no center is crossed", () => {
    expect(songDragReorderIndex(regions, "A", 30)).toBeNull();
    expect(songDragReorderIndex(regions, "C", 160)).toBeNull();
    expect(songDragReorderIndex(regions, "C", 300)).toBeNull();
  });

  it("needs two songs", () => {
    expect(songDragReorderIndex([regions[1]], "A", 100)).toBeNull();
  });
});

describe("reorderedSongLayout", () => {
  it("lays the songs out in the new order keeping the gaps by position", () => {
    const layout = reorderedSongLayout(regions, "C", 0);
    expect(layout.get("C")).toEqual({ startSeconds: 10, endSeconds: 70 });
    expect(layout.get("A")).toEqual({ startSeconds: 70, endSeconds: 130 });
    // The 20 s gap stays between the 2nd and 3rd positions.
    expect(layout.get("B")).toEqual({ startSeconds: 150, endSeconds: 210 });
  });

  it("handles songs of different lengths", () => {
    const layout = reorderedSongLayout(
      [
        { id: "A", startSeconds: 0, endSeconds: 10 },
        { id: "B", startSeconds: 10, endSeconds: 40 },
      ],
      "A",
      1,
    );
    expect(layout.get("B")).toEqual({ startSeconds: 0, endSeconds: 30 });
    expect(layout.get("A")).toEqual({ startSeconds: 30, endSeconds: 40 });
  });
});

describe("songStepReorderIndex", () => {
  it("moves one place in time order and stops at the ends", () => {
    expect(songStepReorderIndex(regions, "B", -1)).toBe(0);
    expect(songStepReorderIndex(regions, "B", 1)).toBe(2);
    expect(songStepReorderIndex(regions, "A", -1)).toBeNull();
    expect(songStepReorderIndex(regions, "C", 1)).toBeNull();
  });
});
