import { describe, expect, it } from "vitest";

import { parseLyricLine } from "@libretracks/shared/charts/chordChart";
import { parseRhythmLine } from "./rhythmLine";

const beats = (line: string) =>
  parseRhythmLine(parseLyricLine(line))?.map((cell) =>
    cell.kind === "bar" ? cell.mark : `${cell.chord ?? ""}${cell.mark}`,
  );

describe("parseRhythmLine", () => {
  it("keeps every slash: the chord is a beat of its own", () => {
    expect(beats("[Fm] / / / | [Cm] / [Eb] / / / |")).toEqual([
      "Fm", "/", "/", "/", "|",
      "Cm", "/", "Eb", "/", "/", "/", "|",
    ]);
  });

  it("splits bars glued to beats", () => {
    expect(beats("[C] / /| [G] |: / :|")).toEqual(["C", "/", "/", "|", "G", "|:", "/", ":|"]);
  });

  it("leaves real lyrics alone", () => {
    expect(parseRhythmLine(parseLyricLine("[C]Eres digno de [G]alabar"))).toBeNull();
    expect(parseRhythmLine(parseLyricLine("/ / / |"))).toBeNull();
  });
});
