import { describe, expect, it } from "vitest";

import type { SectionMarkerSummary } from "../models";

import { planningCenterExport, planningCenterSequence, toPlanningCenterChart } from "./planningCenterExport";

const TEXT = [
  "{title: Camino}",
  "{key: D}",
  "{section: Verso 1}",
  "[D]Camino por la [A]orilla",
  "{comment: Suave}",
  "",
  "{section: Coro}",
  "[G]Eres mi refugio",
].join("\n");

describe("a chart as Planning Center shows it", () => {
  it("writes headers in capitals and [C] chords, without ChordPro directives", () => {
    expect(toPlanningCenterChart(TEXT)).toBe(
      ["VERSO 1", "[D]Camino por la [A]orilla", "(Suave)", "", "CORO", "[G]Eres mi refugio", ""].join("\n"),
    );
  });
});

describe("the song's sequence for Planning Center", () => {
  const marker = (id: string, start: number): SectionMarkerSummary => ({ id, name: id, startSeconds: start, kind: "custom" });
  it("follows the markers, repeats included, as many times as each plays", () => {
    const markers = [marker("v", 0), marker("inst", 10), marker("c", 20), marker("c~1", 30)];
    const links = [
      { markerId: "v", section: 0 },
      { markerId: "c", section: 1, repeat: 2 },
    ];
    expect(planningCenterSequence(TEXT, links, markers)).toEqual(["Verso 1", "Coro", "Coro", "Coro", "Coro"]);
  });
});

describe("repeats: in the sequence or with slashes in the sheet", () => {
  const marker = (id: string, start: number): SectionMarkerSummary => ({ id, name: id, startSeconds: start, kind: "custom" });
  const text = ["{section: Intro}", "[D] [A]", "{section: Verso 1}", "[D]Uno", "dos", "{section: Coro}", "[G]Luz", "sol"].join("\n");
  const markers = [marker("i", 0), marker("v", 10), marker("c1", 20), marker("c2", 30), marker("c3", 40)];
  const links = [
    { markerId: "i", section: 0, repeat: 2 },
    { markerId: "v", section: 1 },
    { markerId: "c1", section: 2, repeat: 2 },
    { markerId: "c2", section: 2, repeat: 2 },
    { markerId: "c3", section: 2, repeat: 4 },
  ];

  it("in the sequence: each pass is an entry, no slashes", () => {
    const result = planningCenterExport(text, links, markers, "sequence");
    expect(result.sequence).toEqual(["Intro", "Intro", "Verso 1", "Coro", "Coro", "Coro", "Coro", "Coro", "Coro", "Coro", "Coro"]);
    expect(result.chordChart).not.toContain("//");
  });

  it("with slashes: the sheet says the total times and the sequence is not written", () => {
    const result = planningCenterExport(text, links, markers, "marks");
    expect(result.sequence).toBeUndefined();
    // Coro plays 2 + 2 + 4 = 8 times; the intro 2.
    expect(result.chordChart).toBe(
      ["INTRO // D A //", "", "VERSO 1", "[D]Uno", "dos", "", "CORO", "//////// [G]Luz", "sol ////////", ""].join("\n"),
    );
  });
});


describe("markers of another kind on a section's chords", () => {
  const named = (id: string, name: string, start: number): SectionMarkerSummary => ({ id, name, startSeconds: start, kind: "custom" });
  const text = ["{section: Intro}", "[Bm] [D] [G] [A]", "{section: Coro}", "Digno de [G]alabar"].join("\n");
  const markers = [named("i", "Intro", 0), named("c", "Coro", 10), named("v", "Vamp", 20), named("x", "Interludio", 30), named("x2", "Interludio 2", 40)];
  const links = [
    { markerId: "i", section: 0 },
    { markerId: "c", section: 1 },
    { markerId: "v", section: 0 },
    { markerId: "x", section: 0 },
    { markerId: "x2", section: 0 },
  ];

  it("with slashes, a Vamp and an Interludio on the intro are their own sections, where they sound", () => {
    const { chordChart } = planningCenterExport(text, links, markers, "marks");
    expect(chordChart).toBe(
      ["INTRO Bm D G A", "", "CORO", "Digno de [G]alabar", "", "VAMP Bm D G A", "", "INTERLUDIO // Bm D G A //", ""].join("\n"),
    );
  });

  it("in the sequence, each one by its own name", () => {
    const result = planningCenterExport(text, links, markers, "sequence");
    expect(result.sequence).toEqual(["Intro", "Coro", "Vamp", "Interludio", "Interludio"]);
    expect(result.chordChart).toContain("VAMP Bm D G A");
    expect(result.chordChart).not.toContain("//");
  });
});

describe("with slashes, a part that comes back later", () => {
  const named = (id: string, name: string, start: number): SectionMarkerSummary => ({ id, name, startSeconds: start, kind: "custom" });
  const text = ["{section: Coro 2}", "Digno de [G]alabar", "{section: Instrumental}", "[G] [Em]", "{section: Puente}", "Sé [G]exaltado"].join("\n");
  const markers = [named("c", "Coro", 0), named("i1", "Instrumental", 10), named("p", "Puente", 20), named("i2", "Instrumental", 30), named("i3", "Instrumental", 40)];
  const links = [
    { markerId: "c", section: 0 },
    { markerId: "i1", section: 1 },
    { markerId: "p", section: 2 },
    { markerId: "i2", section: 1 },
    { markerId: "i3", section: 1 },
  ];

  it("is written again where it sounds, with the times of that run", () => {
    expect(planningCenterExport(text, links, markers, "marks").chordChart).toBe(
      ["CORO 2", "Digno de [G]alabar", "", "INSTRUMENTAL G Em", "", "PUENTE", "Sé [G]exaltado", "", "INSTRUMENTAL // G Em //", ""].join("\n"),
    );
  });
});
