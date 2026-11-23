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

  it("with slashes: the sheet takes what all markers share, the sequence the rest", () => {
    const result = planningCenterExport(text, links, markers, "marks");
    // Coro plays 2, 2 and 4: "// … //" in the sheet, the last marker twice.
    expect(result.sequence).toEqual(["Intro", "Verso 1", "Coro", "Coro", "Coro", "Coro"]);
    expect(result.chordChart).toBe(
      ["INTRO //", "[D] [A]", "", "VERSO 1", "[D]Uno", "dos", "", "CORO", "// [G]Luz", "sol //", ""].join("\n"),
    );
  });
});

