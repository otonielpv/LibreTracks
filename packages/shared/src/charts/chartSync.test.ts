import { describe, expect, it } from "vitest";

import type { SectionMarkerSummary } from "../models";

import { parseChordPro } from "./chordChart";
import {
  advancePlayHistory,
  autoLinkChart,
  buildPerformanceBlocks,
  formatLineTime,
  moveLineStart,
  parseLineTime,
  PLAY_HISTORY_LIMIT,
  type PlayHistory,
  chartLinkFor,
  chartMarkersForRegion,
  applyLineRecording,
  lineStartSeconds,
  recordLineTap,
  resolveChartPlayback,
} from "./chartSync";

const doc = parseChordPro(
  [
    "{section: Intro}", "[C] [F]",
    "{section: Verso 1}", "uno", "dos", "tres", "cuatro",
    "{section: Coro 1}", "coro a", "coro b",
    "{section: Instrumental}", "[C]",
    "{section: Verso 2}", "cinco", "seis",
    "{section: Coro 2}", "coro c", "coro d",
    "{section: Puente}", "puente",
  ].join("\n"),
);

function marker(
  id: string,
  startSeconds: number,
  kind: SectionMarkerSummary["kind"],
  extra: Partial<SectionMarkerSummary> = {},
): SectionMarkerSummary {
  return { id, name: id, startSeconds, kind, ...extra };
}

describe("auto-linking markers to the sheet", () => {
  it("pairs by meaning and order, reusing the last section the sheet writes out", () => {
    const links = autoLinkChart(doc, [
      marker("intro", 0, "intro"),
      marker("v1", 8, "verse"),
      marker("c1", 24, "chorus"),
      marker("v2", 40, "verse"),
      marker("c2", 56, "chorus"),
      marker("c3", 72, "chorus"),
      marker("end", 90, "ending"),
    ]);
    expect(links).toEqual([
      { markerId: "intro", section: 0 },
      { markerId: "v1", section: 1 },
      { markerId: "c1", section: 2 },
      { markerId: "v2", section: 4 },
      { markerId: "c2", section: 5 },
      { markerId: "c3", section: 5 },
    ]);
  });

  it("reads along: a chorus after the instrumental gets the chorus written after it", () => {
    // The sheet writes each part once, in order, with the last chorus in a
    // new key; the song repeats parts and goes back to the intro.
    const sheet = parseChordPro(
      ["{section: Intro}", "[B]", "{section: Verso}", "a", "{section: Coro}", "b",
        "{section: Solo}", "[Bm]", "{section: Inter}", "[Bm]", "{section: Coro}", "[C#m]c"].join("\n"),
    );
    const song = [
      marker("i1", 0, "intro"), marker("v1", 1, "verse", { variant: 2 }), marker("c1", 2, "chorus"),
      marker("i2", 3, "intro"), marker("v2", 4, "verse", { variant: 2 }), marker("c2", 5, "chorus"),
      marker("solo", 6, "solo"), marker("inst", 7, "instrumental"), marker("c3", 8, "chorus"),
      marker("i3", 9, "intro"), marker("end", 10, "ending"),
    ];
    expect(autoLinkChart(sheet, song).map((link) => `${link.markerId}:${link.section}`)).toEqual([
      "i1:0", "v1:1", "c1:2", "i2:0", "v2:1", "c2:2", "solo:3", "inst:4", "c3:5", "i3:0",
    ]);
  });

  it("uses the marker's number when it has one, and understands custom names", () => {
    const links = autoLinkChart(doc, [
      marker("v2", 0, "verse", { variant: 2 }),
      marker("custom", 10, "custom", { name: "Puente" }),
    ]);
    expect(links).toEqual([
      { markerId: "v2", section: 4 },
      { markerId: "custom", section: 6 },
    ]);
  });

  it("pairs in order when nothing can be matched by meaning", () => {
    const plain = parseChordPro("primera\n{section: Algo}\nsegunda");
    const links = autoLinkChart(plain, [marker("a", 0, "custom"), marker("b", 5, "custom"), marker("c", 9, "custom")]);
    expect(links).toEqual([
      { markerId: "a", section: 0 },
      { markerId: "b", section: 1 },
    ]);
  });

  it("ignores arrangement repeats: they share their original's link", () => {
    const links = autoLinkChart(doc, [marker("c1", 0, "chorus"), marker("c1~2", 10, "chorus")]);
    expect(links).toEqual([{ markerId: "c1", section: 2 }]);
    expect(chartLinkFor(links, "c1~2")?.section).toBe(2);
  });
});

describe("which line is playing", () => {
  const markers = [marker("v1", 10, "verse"), marker("inst", 26, "instrumental"), marker("c1", 30, "chorus")];
  const links = [
    { markerId: "v1", section: 1 },
    { markerId: "c1", section: 2, lineBeats: [0, 6] },
  ];
  // 120 BPM: half a second per beat.
  const at = (seconds: number) => resolveChartPlayback(doc, links, markers, 40, seconds, () => 0.5);

  it("spreads unrecorded lines evenly over the section", () => {
    // Verse: 16 s, 4 lines → a line every 4 s.
    expect(at(10)).toMatchObject({ section: 1, line: 0, nextSection: null });
    expect(at(14.1)).toMatchObject({ section: 1, line: 1 });
    expect(at(25.9)).toMatchObject({ section: 1, line: 3 });
  });

  it("uses recorded beats", () => {
    expect(at(32.9)).toMatchObject({ section: 2, line: 0 });
    expect(at(33)).toMatchObject({ section: 2, line: 1 });
  });

  it("keeps the last lyrics without a current line through an unlinked part", () => {
    expect(at(27)).toMatchObject({ markerId: "inst", section: 1, line: null, nextSection: 2 });
  });

  it("shows nothing before the first section marker", () => {
    expect(at(5)).toMatchObject({ markerId: null, section: null });
  });

  it("splits what is left after the recorded lines", () => {
    // Line 1 was recorded at 4 s; it and the two after share the other 16 s.
    const starts = lineStartSeconds(4, 20, 0.5, [0, 8]);
    expect(starts.slice(0, 2)).toEqual([0, 4]);
    expect(starts[2]).toBeCloseTo(4 + 16 / 3);
    expect(starts[3]).toBeCloseTo(4 + 32 / 3);
    expect(lineStartSeconds(2, 10, 0.5, [])).toEqual([0, 5]);
    expect(lineStartSeconds(0, 10, 0.5, [])).toEqual([]);
  });
});

it("only section markers of the song move the lyrics", () => {
  const region = { id: "s", name: "s", startSeconds: 0, endSeconds: 30 } as never;
  const markers = [marker("b", 20, "chorus"), marker("a", 0, "verse"), marker("cue", 5, "build"), marker("x", 40, "verse")];
  expect(chartMarkersForRegion(markers, region).map((m) => m.id)).toEqual(["a", "b"]);
});

describe("recording line times", () => {
  it("starts each section at beat 0 and appends taps in order", () => {
    let recording = recordLineTap(new Map(), "c1~2", 4, 3);
    recording = recordLineTap(recording, "c1", 3, 3); // backwards: ignored
    recording = recordLineTap(recording, "c1", 8.004, 3);
    recording = recordLineTap(recording, "c1", 12, 3); // more taps than lines
    expect(recording.get("c1")).toEqual([0, 4, 8]);
  });

  it("writes the recording into the links it belongs to", () => {
    const links = [
      { markerId: "v1", section: 1 },
      { markerId: "c1", section: 2, lineBeats: [0, 2] },
    ];
    const recording = new Map([["c1", [0, 6]], ["ghost", [0, 1]]]);
    expect(applyLineRecording(links, recording)).toEqual([
      { markerId: "v1", section: 1 },
      { markerId: "c1", section: 2, lineBeats: [0, 6] },
    ]);
  });
});

describe("lyrics in playing order", () => {
  const markers = [
    marker("intro", 0, "intro", { name: "Intro" }),
    marker("verse", 8, "verse", { name: "Estrofa" }),
    marker("chorus", 24, "chorus", { name: "Coro" }),
    marker("intro~2", 40, "intro", { name: "Intro" }),
    marker("end", 48, "ending", { name: "Final" }),
  ];
  const links = [
    { markerId: "intro", section: 0 },
    { markerId: "verse", section: 1 },
    { markerId: "chorus", section: 2 },
  ];
  const play = (...ids: string[]) => ids.reduce<PlayHistory>((history, id) => advancePlayHistory(history, id), []);
  const labels = (result: { blocks: { label: string; queued: boolean }[] }) =>
    result.blocks.map((b) => `${b.queued ? "→" : ""}${b.label}`);

  it("before the song starts, shows it in timeline order", () => {
    const result = buildPerformanceBlocks(doc, links, markers, [], null);
    expect(result.current).toBe(-1);
    expect(labels(result)).toEqual(["Intro", "Estrofa", "Coro", "Intro", "Final"]);
  });

  it("follows the timeline, so the intro that comes back sits below the chorus", () => {
    const result = buildPerformanceBlocks(doc, links, markers, play("intro", "verse", "chorus"), null);
    expect(result.blocks.map((b) => [b.label, b.section])).toEqual([
      ["Intro", 0],
      ["Estrofa", 1],
      ["Coro", 2],
      ["Intro", 0],
      // A part the sheet has no words for keeps its place, without lines.
      ["Final", null],
    ]);
    expect(result.current).toBe(2);
    expect(new Set(result.blocks.map((b) => b.key)).size).toBe(result.blocks.length);
  });

  it("puts a scheduled jump right after the block playing", () => {
    const result = buildPerformanceBlocks(doc, links, markers, play("intro", "verse", "chorus"), "verse");
    expect(labels(result)).toEqual(["Intro", "Estrofa", "Coro", "→Estrofa", "→Coro", "→Intro", "→Final"]);
  });

  it("once the jump lands, the song goes on below it: the preview becomes the current block", () => {
    const before = buildPerformanceBlocks(doc, links, markers, play("intro", "verse", "chorus"), "verse");
    const after = buildPerformanceBlocks(doc, links, markers, play("intro", "verse", "chorus", "verse"), null);
    expect(labels(after)).toEqual(["Intro", "Estrofa", "Coro", "Estrofa", "Coro", "Intro", "Final"]);
    expect(after.current).toBe(3);
    // Same keys, same order: the block on screen does not move.
    expect(after.blocks.map((b) => b.key)).toEqual(before.blocks.map((b) => b.key));
  });

  it("keeps only the last parts played above the current one", () => {
    let history: PlayHistory = [];
    for (let round = 0; round < 5; round += 1) {
      history = advancePlayHistory(history, "verse");
      history = advancePlayHistory(history, "chorus");
    }
    expect(history).toHaveLength(PLAY_HISTORY_LIMIT + 1);
    expect(advancePlayHistory(history, "chorus")).toBe(history);
    expect(advancePlayHistory(history, null)).toBe(history);
  });

  it("ignores a jump to another song", () => {
    const result = buildPerformanceBlocks(doc, links, markers, play("verse"), "other-song");
    expect(result.blocks.some((b) => b.queued)).toBe(false);
  });
});

describe("line change times in the editor", () => {
  it("formats and reads m:ss.d", () => {
    expect(formatLineTime(0)).toBe("0:00.0");
    expect(formatLineTime(72.55)).toBe("1:12.6");
    expect(formatLineTime(59.96)).toBe("1:00.0");
    expect(parseLineTime("1:12.5")).toBe(72.5);
    expect(parseLineTime("1:12,5")).toBe(72.5);
    expect(parseLineTime("12")).toBe(12);
    expect(parseLineTime("0:75")).toBeNull();
    expect(parseLineTime("abc")).toBeNull();
  });

  it("moves a line without crossing its neighbours, and never the first", () => {
    const starts = [0, 4, 8, 12];
    expect(moveLineStart(starts, 2, 6, 16)).toEqual([0, 4, 6, 12]);
    expect(moveLineStart(starts, 2, 2, 16)[2]).toBeCloseTo(4.1);
    expect(moveLineStart(starts, 3, 99, 16)[3]).toBeCloseTo(15.9);
    expect(moveLineStart(starts, 0, 3, 16)).toEqual(starts);
  });
});
