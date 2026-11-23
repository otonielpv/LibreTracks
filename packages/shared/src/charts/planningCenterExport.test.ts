import { describe, expect, it } from "vitest";

import type { SectionMarkerSummary } from "../models";

import { planningCenterSequence, toPlanningCenterChart } from "./planningCenterExport";

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
