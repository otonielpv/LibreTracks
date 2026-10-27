import { describe, expect, it } from "vitest";

import type { SongView } from "@libretracks/shared/models";

import { formatMusicalPosition } from "../helpers";
import {
  SECTION_END_MARGIN_SECONDS,
  clampSectionGroupDelta,
  placeSectionSeconds,
  snappedSectionDelta,
} from "./sectionEditModel";

// 6/8 at 97 BPM: one bar is 6 × (60 / 97 / 2)… = 1.855625 s on this grid.
const song = {
  bpm: 97,
  timeSignature: "6/8",
  tempoMarkers: [],
  timeSignatureMarkers: [],
  regions: [],
  durationSeconds: 600,
} as unknown as SongView;
const BAR = 1.855625;
const region = { startSeconds: 0, endSeconds: 60 };

describe("placeSectionSeconds", () => {
  it("snaps to the nearest bar line in 6/8 at 97 BPM", () => {
    const placed = placeSectionSeconds(song, region, 12.3, true);
    expect(placed).toBeCloseTo(7 * BAR, 6);
    expect(formatMusicalPosition(placed, song)).toBe("8.1.00");
    expect(formatMusicalPosition(placeSectionSeconds(song, region, 3.1, true), song)).toBe("3.1.00");
  });

  it("leaves the position alone without snapping", () => {
    expect(placeSectionSeconds(song, region, 12.3, false)).toBe(12.3);
  });

  it("snaps to subdivisions when the zoom exposes them", () => {
    const fourFour = {
      ...song,
      bpm: 120,
      timeSignature: "4/4",
    } as SongView;
    expect(placeSectionSeconds(fourFour, region, 3.1, true, 6000)).toBeCloseTo(3.125);
  });

  it("never leaves the song", () => {
    expect(placeSectionSeconds(song, { startSeconds: 10, endSeconds: 20 }, 2, false)).toBe(10);
    expect(placeSectionSeconds(song, { startSeconds: 10, endSeconds: 20 }, 25, false)).toBe(
      20 - SECTION_END_MARGIN_SECONDS,
    );
  });
});

describe("clampSectionGroupDelta", () => {
  const song10to20 = { startSeconds: 10, endSeconds: 20 };
  it("stops the earliest marker at the song start", () => {
    expect(clampSectionGroupDelta([12, 15], -5, song10to20)).toBe(-2);
  });
  it("stops the latest marker before the song end", () => {
    expect(clampSectionGroupDelta([12, 15], 9, song10to20)).toBeCloseTo(5 - SECTION_END_MARGIN_SECONDS, 9);
  });
  it("passes a delta that fits", () => {
    expect(clampSectionGroupDelta([12, 15], 1, song10to20)).toBe(1);
  });
});

describe("snappedSectionDelta", () => {
  it("lands the dragged marker on a bar", () => {
    const delta = snappedSectionDelta(song, region, 2 * BAR, 1.2, [2 * BAR], true);
    expect(2 * BAR + delta).toBeCloseTo(3 * BAR, 6);
  });

  it("lands the dragged marker on a visible subdivision", () => {
    const fourFour = {
      ...song,
      bpm: 120,
      timeSignature: "4/4",
    } as SongView;
    const delta = snappedSectionDelta(fourFour, region, 2, 0.3, [2], true, 6000);
    expect(2 + delta).toBeCloseTo(2.25);
  });
});
