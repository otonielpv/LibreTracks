import { describe, expect, it } from "vitest";

import { parseLyricLine } from "@libretracks/shared/charts/chordChart";
import { parseRhythmLine } from "./rhythmLine";

const beats = (line: string) =>
  parseRhythmLine(parseLyricLine(line))?.map((cell) =>
    cell.kind === "bar" ? "|" : `${cell.chord ?? ""}${cell.mark}`,
  );

describe("parseRhythmLine", () => {
  it("puts each chord on the beat it starts on, one cell per beat", () => {
    expect(beats("[Ab] / / / | [Fm] / / / | [Cm] / / / | [Bbsus] / [Eb] / [G] / |")).toEqual([
      "Ab/", "/", "/", "|",
      "Fm/", "/", "/", "|",
      "Cm/", "/", "/", "|",
      "Bbsus/", "Eb/", "G/", "|",
    ]);
  });

  it("splits bars glued to beats and keeps a chord placed before a bar", () => {
    expect(beats("[C] / /| [G] | / /")).toEqual(["C/", "/", "|", "|", "G/", "/"]);
  });

  it("leaves real lyrics alone", () => {
    expect(parseRhythmLine(parseLyricLine("[C]Eres digno de [G]alabar"))).toBeNull();
    expect(parseRhythmLine(parseLyricLine("/ / / |"))).toBeNull();
  });
});
