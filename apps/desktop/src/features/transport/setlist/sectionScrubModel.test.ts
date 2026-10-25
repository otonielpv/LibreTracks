import { describe, expect, it } from "vitest";
import type { SongView } from "@libretracks/shared/models";

import { barStartsInSong, nearestBarIndex, stepBar } from "./sectionScrubModel";

const song = (overrides: Partial<SongView> = {}) =>
  ({
    bpm: 120,
    timeSignature: "4/4",
    tempoMarkers: [],
    timeSignatureMarkers: [],
    ...overrides,
  }) as unknown as SongView;

describe("section scrub model", () => {
  it("a 4/4 song at 120 BPM has a bar every 2 s from its start", () => {
    expect(barStartsInSong(song(), { startSeconds: 10, endSeconds: 18 })).toEqual([10, 12, 14, 16]);
  });

  it("meter changes make the bars as long as the meter in force", () => {
    // 6/8 at 120 BPM: six eighth notes = 1.5 s per bar.
    const sixEight = song({ timeSignatureMarkers: [{ id: "m", startSeconds: 4, signature: "6/8" }] } as never);
    const bars = barStartsInSong(sixEight, { startSeconds: 0, endSeconds: 8.5 });
    expect(bars.slice(0, 2)).toEqual([0, 2]);
    expect(bars[3] - bars[2]).toBeCloseTo(1.5);
  });

  it("the bar a moment is on: nearest downbeat, or the one it falls in", () => {
    const bars = [0, 2, 4, 6];
    expect(nearestBarIndex(bars, 2.9)).toBe(1);
    expect(nearestBarIndex(bars, 3.1)).toBe(2);
    expect(nearestBarIndex(bars, 3.9, { floor: true })).toBe(1);
    expect(nearestBarIndex(bars, 99)).toBe(3);
  });

  it("one bar before or after, never past the song's edges", () => {
    const bars = [0, 2, 4, 6];
    expect(stepBar(bars, 2, 1)).toBe(4);
    expect(stepBar(bars, 2.5, 1)).toBe(4);
    expect(stepBar(bars, 2, -1)).toBe(0);
    expect(stepBar(bars, 2.5, -1)).toBe(2);
    expect(stepBar(bars, 6, 1)).toBeNull();
    expect(stepBar(bars, 0, -1)).toBeNull();
  });
});
