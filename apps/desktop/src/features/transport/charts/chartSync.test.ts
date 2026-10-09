import { describe, expect, it } from "vitest";

import type { SectionMarkerSummary } from "@libretracks/shared/models";

import { parseChordPro } from "./chordChart";
import {
  autoLinkChart,
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
