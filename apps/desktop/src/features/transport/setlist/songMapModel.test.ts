import { describe, expect, it } from "vitest";

import type { SectionMarkerSummary, SongView } from "@libretracks/shared/models";

import {
  barSecondsAtFor,
  blockIdForMarker,
  buildSongMapBlocks,
  resolveActiveBlock,
  resolveSetlistSongId,
} from "./songMapModel";
import { testRegion } from "./testBindings";

const region = testRegion("r1", { name: "Canción", startSeconds: 10, endSeconds: 70 });
// 120 BPM in 4/4: one bar = 2 s.
const twoSecondBars = () => 2;
const labels = { start: "Inicio" };

const section = (id: string, startSeconds: number, extra: Partial<SectionMarkerSummary> = {}) =>
  ({ id, name: id, startSeconds, kind: "verse", ...extra }) as SectionMarkerSummary;
const cue = (id: string, startSeconds: number) =>
  ({ id, name: id, startSeconds, kind: "custom", categoryOverride: "cue" }) as SectionMarkerSummary;

const sum = (values: number[]) => values.reduce((acc, value) => acc + value, 0);

describe("buildSongMapBlocks", () => {
  it("regular sections: one block each, proportional, the last ends with the song", () => {
    const { blocks } = buildSongMapBlocks(
      region,
      [section("intro", 10), section("verso", 20), section("coro", 40)],
      twoSecondBars,
      labels,
    );
    expect(blocks.map((block) => block.id)).toEqual(["intro", "verso", "coro"]);
    expect(blocks.map((block) => [block.startSeconds, block.endSeconds])).toEqual([
      [10, 20],
      [20, 40],
      [40, 70],
    ]);
    expect(blocks.map((block) => block.bars)).toEqual([5, 10, 15]);
    expect(blocks[0].widthFraction).toBeCloseTo(10 / 60);
    expect(sum(blocks.map((block) => block.widthFraction))).toBe(1);
  });

  it("ignores markers of other songs", () => {
    const { blocks } = buildSongMapBlocks(
      region,
      [section("antes", 5), section("intro", 10), section("despues", 70)],
      twoSecondBars,
      labels,
    );
    expect(blocks.map((block) => block.id)).toEqual(["intro"]);
  });

  it("no sections: one block named after the song", () => {
    const { blocks } = buildSongMapBlocks(region, [], twoSecondBars, labels);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "song", label: "Canción", marker: null, widthFraction: 1 });
  });

  it("a first section after the song start leaves a «Start» block that has no marker", () => {
    const { blocks } = buildSongMapBlocks(region, [section("verso", 16)], twoSecondBars, labels);
    expect(blocks.map((block) => [block.kind, block.label, block.startSeconds, block.endSeconds])).toEqual([
      ["start", "Inicio", 10, 16],
      ["section", "verso", 16, 70],
    ]);
    expect(blocks[0].marker).toBeNull();
  });

  it("folds cues on a section and keeps lone cues as notches", () => {
    const { blocks, notches } = buildSongMapBlocks(
      region,
      [section("intro", 10), cue("aviso", 10.01), section("coro", 40), cue("suelto", 55)],
      twoSecondBars,
      labels,
    );
    expect(blocks.map((block) => block.id)).toEqual(["intro", "coro"]);
    expect(blocks[0].cues.map((item) => item.id)).toEqual(["aviso"]);
    expect(notches.map((notch) => notch.marker.id)).toEqual(["suelto"]);
    expect(notches[0].fraction).toBeCloseTo(45 / 60);
    expect(blockIdForMarker(blocks, "aviso")).toBe("intro");
  });

  it("fractions add up to exactly 1 with awkward lengths", () => {
    const odd = testRegion("odd", { startSeconds: 0, endSeconds: 10 });
    const { blocks } = buildSongMapBlocks(
      odd,
      [section("a", 0), section("b", 10 / 3), section("c", 20 / 3)],
      twoSecondBars,
      labels,
    );
    expect(sum(blocks.map((block) => block.widthFraction))).toBe(1);
  });

  it("bars follow the tempo in force where each section starts", () => {
    const song = {
      bpm: 120,
      timeSignature: "4/4",
      tempoMarkers: [{ id: "t", startSeconds: 40, bpm: 60 }],
      timeSignatureMarkers: [],
      regions: [region],
    } as unknown as SongView;
    const { blocks } = buildSongMapBlocks(
      region,
      [section("intro", 10), section("coro", 40)],
      barSecondsAtFor(song),
      labels,
    );
    // 30 s at 120 BPM = 15 bars; 30 s at 60 BPM = 7.5 bars.
    expect(blocks.map((block) => block.bars)).toEqual([15, 7.5]);
  });
});

describe("resolveActiveBlock", () => {
  const { blocks } = buildSongMapBlocks(
    region,
    [section("intro", 10), section("verso", 20), section("coro", 40)],
    twoSecondBars,
    labels,
  );

  it.each([
    [9.99, null, "intro", 0],
    [10, "intro", "verso", 0],
    [15, "intro", "verso", 0.5],
    [19.9995, "verso", "coro", 0],
    [20, "verso", "coro", 0],
    [39.99, "verso", "coro", 0.9995],
    [40, "coro", null, 0],
    [69.99, "coro", null, 0.99967],
    [70, null, null, 0],
  ])("at %d s → active %s, next %s", (position, activeId, nextId, progress) => {
    const resolved = resolveActiveBlock(blocks, position);
    expect(resolved.activeId).toBe(activeId);
    expect(resolved.nextId).toBe(nextId);
    expect(resolved.progress).toBeCloseTo(progress, 3);
  });
});

describe("resolveSetlistSongId", () => {
  const regions = [testRegion("a"), testRegion("b"), testRegion("c")];
  it("prefers the selection, then the last shown, then the sounding, then the first", () => {
    expect(resolveSetlistSongId(regions, "b", "c", "a")).toBe("b");
    expect(resolveSetlistSongId(regions, null, "c", "a")).toBe("c");
    expect(resolveSetlistSongId(regions, null, "gone", "a")).toBe("a");
    expect(resolveSetlistSongId(regions, null, null, null)).toBe("a");
    expect(resolveSetlistSongId([], null, null, null)).toBeNull();
  });
});
