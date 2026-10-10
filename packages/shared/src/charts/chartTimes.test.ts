import { describe, expect, it } from "vitest";

import { parseChordPro, serializeChordPro } from "./chordChart";
import {
  addChartTimes,
  applyChartTimes,
  chartLineTimeFor,
  lineTimeKey,
  takeChartTimes,
  type ChartTiming,
} from "./chartTimes";
import type { SectionMarkerSummary } from "../models";

const TEXT = [
  "{title: Canción}",
  "{section: Verso 1}",
  "[C]Primera línea",
  "{comment: suave}",
  "[F]Segunda línea",
  "{section: Solo}",
  "{start_of_tab}",
  "E--3--",
  "{end_of_tab}",
  "{section: Coro}",
  "[G]Coro",
].join("\n");

describe("line times in the lyrics text", () => {
  it("puts each lyric line's time in front of it, and nothing else", () => {
    const annotated = addChartTimes(TEXT, (section, line) => (section === 0 ? 30 + line * 4 : section === 2 ? 60 : null));
    expect(annotated.split("\n")).toEqual([
      "{title: Canción}",
      "{section: Verso 1}",
      "[0:30.0] [C]Primera línea",
      "{comment: suave}",
      // The comment is line 1 of the section: the second lyric line is line 2.
      "[0:38.0] [F]Segunda línea",
      "{section: Solo}",
      "{start_of_tab}",
      "E--3--",
      "{end_of_tab}",
      "{section: Coro}",
      "[1:00.0] [G]Coro",
    ]);
  });

  it("takes them back out, leaving the stored text exactly as it was", () => {
    const annotated = addChartTimes(TEXT, (section, line) => (section === 0 ? 30 + line * 4 : null));
    const { text, times } = takeChartTimes(annotated);
    expect(text).toBe(TEXT);
    expect([...times]).toEqual([
      [lineTimeKey(0, 0), 30],
      [lineTimeKey(0, 2), 38],
    ]);
  });

  it("reads times the user typed, with or without decimals, and ignores the rest", () => {
    const { text, times } = takeChartTimes("{section: Verso}\n[1:05] [C]uno\n[0:70] dos\ntres");
    expect(times.get(lineTimeKey(0, 0))).toBe(65);
    // Not a valid time: the prefix goes, the line stays without a time.
    expect(times.has(lineTimeKey(0, 1))).toBe(false);
    expect(times.has(lineTimeKey(0, 2))).toBe(false);
    expect(parseChordPro(text).sections[0].lines).toHaveLength(3);
  });
});

describe("times typed in the text become marker links", () => {
  // Song from 100 s to 160 s at 120 BPM (0.5 s per beat). The verse plays at
  // 100 s for 20 s; the chorus at 120 s and again at 140 s, 20 s each.
  const doc = parseChordPro("{section: Verso}\nuno\ndos\ntres\ncuatro\n{section: Coro}\na\nb");
  const markers: SectionMarkerSummary[] = [
    { id: "v", name: "Verso", startSeconds: 100, kind: "verse" },
    { id: "c1", name: "Coro", startSeconds: 120, kind: "chorus" },
    { id: "c2", name: "Coro", startSeconds: 140, kind: "chorus" },
  ];
  const timing: ChartTiming = { markers, songStartSeconds: 100, songEndSeconds: 160, secondsPerBeatAt: () => 0.5 };
  const links = [
    { markerId: "v", section: 0 },
    { markerId: "c1", section: 1, lineBeats: [0, 12] },
    { markerId: "c2", section: 1 },
  ];
  const shownTimes = () => {
    const timeFor = chartLineTimeFor(doc, links, timing);
    return takeChartTimes(addChartTimes(serializeChordPro(doc), timeFor)).times;
  };

  it("shows song time from the first appearance of each section", () => {
    const timeFor = chartLineTimeFor(doc, links, timing);
    expect([0, 1, 2, 3].map((line) => timeFor(0, line))).toEqual([0, 5, 10, 15]);
    // The chorus as recorded on its first marker (beat 12 = 6 s).
    expect([0, 1].map((line) => timeFor(1, line))).toEqual([20, 26]);
  });

  it("leaves a section untouched when its times were not changed", () => {
    expect(applyChartTimes(doc, links, timing, shownTimes())).toEqual(links);
  });

  it("applies a changed time to every marker of the section, as an offset", () => {
    const times = shownTimes();
    times.set(lineTimeKey(1, 1), 28); // the chorus's second line 8 s in
    const next = applyChartTimes(doc, links, timing, times);
    expect(next.find((link) => link.markerId === "c1")?.lineBeats).toEqual([0, 16]);
    expect(next.find((link) => link.markerId === "c2")?.lineBeats).toEqual([0, 16]);
    // The verse was not touched.
    expect(next.find((link) => link.markerId === "v")).toEqual({ markerId: "v", section: 0 });
  });

  it("spreads the lines left without a time between the known ones", () => {
    const times = shownTimes();
    times.set(lineTimeKey(0, 1), 2);
    times.delete(lineTimeKey(0, 2));
    times.set(lineTimeKey(0, 3), 14);
    const verse = applyChartTimes(doc, links, timing, times).find((link) => link.markerId === "v");
    expect(verse?.lineBeats).toEqual([0, 4, 16, 28]);
  });

  it("goes back to the even spread when a section has no times left", () => {
    const times = shownTimes();
    times.delete(lineTimeKey(1, 0));
    times.delete(lineTimeKey(1, 1));
    const chorus = applyChartTimes(doc, links, timing, times).filter((link) => link.section === 1);
    expect(chorus.every((link) => link.lineBeats === undefined)).toBe(true);
  });
});
