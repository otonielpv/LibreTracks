import { describe, expect, it } from "vitest";

import type { MarkerKind, SectionMarkerSummary } from "../models";

import { chartParts } from "./chartParts";
import { parseChordPro } from "./chordChart";
import { applyPaste, proposePasteAssignment, splitPastedSong } from "./pasteSong";
import { plainToSectionLines } from "./plainChart";

const marker = (id: string, name: string, at: number, kind: MarkerKind, variant: number | null = null): SectionMarkerSummary => ({
  id,
  name,
  startSeconds: at,
  kind,
  variant,
});

const MARKERS = [
  marker("v1", "Verso 1", 0, "verse", 1),
  marker("c1", "Coro", 10, "chorus"),
  marker("v2", "Verso 2", 20, "verse", 2),
  marker("c2", "Coro", 30, "chorus"),
  marker("b", "Puente", 40, "bridge"),
  marker("c3", "Coro", 50, "chorus"),
];

// Invented lyrics.
const WITH_HEADERS = [
  "VERSO 1",
  "Camino por la senda",
  "Con paso firme",
  "",
  "Coro:",
  "Santo eres tú",
  "Digno de honor",
  "",
  "VERSO 2",
  "Canto en la mañana",
  "",
  "Coro:",
  "Santo eres tú",
  "Digno de honor",
  "",
  "[Puente]",
  "Siempre fiel",
].join("\n");

const HOLYRICS = [
  "Camino por la senda",
  "Con paso firme",
  "",
  "Santo eres tú",
  "Digno de honor",
  "",
  "Canto en la mañana",
  "Te alabo sin cesar",
  "",
  "Santo eres tú",
  "Digno de honor",
  "",
  "",
  "Siempre fiel",
  "Siempre tú",
].join("\n");

const CHORUS = ["Santo eres tú", "Digno de honor"].join("\n");
const plainByLabel = (chart: ReturnType<typeof applyPaste>["chart"], markers = MARKERS) =>
  chartParts(chart, markers).map((part) => [part.label, part.plain]);

describe("pasting a whole song", () => {
  it("C1: headers send each block to every section it fits, the chorus to all choruses", () => {
    const blocks = splitPastedSong(WITH_HEADERS);
    expect(blocks.map((entry) => entry.label)).toEqual(["Verso 1", "Coro", "Verso 2", "Coro", "Puente"]);
    const assignments = proposePasteAssignment(blocks, chartParts(null, MARKERS), MARKERS);
    const { chart } = applyPaste(null, MARKERS, blocks, assignments);
    expect(plainByLabel(chart)).toEqual([
      ["Verso 1", ["Camino por la senda", "Con paso firme"].join("\n")],
      ["Coro", CHORUS],
      ["Verso 2", "Canto en la mañana"],
      ["Coro", CHORUS],
      ["Puente", "Siempre fiel"],
      ["Coro", CHORUS],
    ]);
  });

  it("a bridge pasted once (with repeat marks) is copied to the six bridges", () => {
    const markers = [
      marker("v", "Verso", 0, "verse"),
      ...[1, 2, 3, 4, 5, 6].map((n) => marker(`p${n}`, "Puente", 10 * n, "bridge")),
    ];
    const blocks = splitPastedSong(["VERSO", "Camino por la senda", "", "////// PUENTE //////", "Siempre fiel"].join("\n"));
    expect(blocks.map((entry) => entry.label)).toEqual(["Verso", "Puente"]);
    const assignments = proposePasteAssignment(blocks, chartParts(null, markers), markers);
    expect(assignments[1].partKeys).toEqual(["m:p1", "m:p2", "m:p3", "m:p4", "m:p5", "m:p6"]);
    const { chart } = applyPaste(null, markers, blocks, assignments);
    const parts = chartParts(chart, markers);
    expect(parts.filter((part) => part.label === "Puente").map((part) => part.plain)).toEqual(Array(6).fill("Siempre fiel"));
    // Each one its own section: editing one later leaves the others.
    expect(new Set(parts.filter((part) => part.label === "Puente").map((part) => part.section)).size).toBe(6);
  });

  it("C2: without headers, the block that comes back goes to every chorus and the rest to the names in order", () => {
    const blocks = splitPastedSong(HOLYRICS);
    expect(blocks).toHaveLength(5);
    const assignments = proposePasteAssignment(blocks, chartParts(null, MARKERS), MARKERS);
    expect(assignments.map((assignment) => assignment.partKeys)).toEqual([
      ["m:v1"],
      ["m:c1", "m:c2", "m:c3"],
      ["m:v2"],
      ["m:c1", "m:c2", "m:c3"],
      ["m:b"],
    ]);
    const { chart } = applyPaste(null, MARKERS, blocks, assignments);
    expect(chartParts(chart, MARKERS).filter((part) => part.label === "Coro").map((part) => part.plain)).toEqual(Array(3).fill(CHORUS));
  });

  it("C3: blocks left over become new sections; nothing is lost", () => {
    const extra = `${HOLYRICS}\n\nOtra estrofa más\n\nY otra más`;
    const blocks = splitPastedSong(extra);
    const assignments = proposePasteAssignment(blocks, chartParts(null, MARKERS), MARKERS);
    expect(assignments.slice(-2).map((assignment) => assignment.partKeys)).toEqual([[], []]);
    const { chart } = applyPaste(null, MARKERS, blocks, assignments);
    const doc = parseChordPro(chart!.text);
    const text = doc.sections.flatMap((section) => section.lines).map((line) => (line.kind === "lyrics" ? line.segments.map((s) => s.text).join("") : ""));
    for (const row of ["Otra estrofa más", "Y otra más", "Siempre fiel", "Canto en la mañana"]) expect(text).toContain(row);
  });

  it("C3: fewer blocks than sections leaves the rest empty", () => {
    const blocks = splitPastedSong("Camino por la senda");
    const assignments = proposePasteAssignment(blocks, chartParts(null, MARKERS), MARKERS);
    const { chart } = applyPaste(null, MARKERS, blocks, assignments);
    expect(chartParts(chart, MARKERS).filter((part) => part.section !== null).map((part) => part.label)).toEqual(["Verso 1"]);
  });

  it("C4: chords over the lyric read the same as one section of the editor", () => {
    const verse = ["G             D", "Camino por la senda"].join("\n");
    const blocks = splitPastedSong(["VERSO 1", verse, "", "CORO", "C          G", "Santo eres tú"].join("\n"));
    expect(blocks[0].lines).toEqual(plainToSectionLines(verse));
    expect(blocks[1].lines).toEqual(plainToSectionLines(["C          G", "Santo eres tú"].join("\n")));
  });

  it("a song without markers gets one section per pasted block", () => {
    const blocks = splitPastedSong(WITH_HEADERS);
    const assignments = proposePasteAssignment(blocks, [], []);
    const { chart } = applyPaste(null, [], blocks, assignments);
    expect(chartParts(chart, []).map((part) => part.label)).toEqual(["Verso 1", "Coro", "Verso 2", "Coro", "Puente"]);
  });

  describe("two different verses for two markers both called Verso", () => {
    const markers = [
      marker("v1", "Verso", 0, "verse"),
      marker("c1", "Coro", 10, "chorus"),
      marker("v2", "Verso", 20, "verse"),
      marker("c2", "Coro", 30, "chorus"),
      marker("p1", "Puente", 40, "bridge"),
      marker("p2", "Puente", 50, "bridge"),
    ];
    const expected = [
      ["Verso", "Primer verso"],
      ["Coro", "El coro"],
      ["Verso", "Segundo verso"],
      ["Coro", "El coro"],
      ["Puente", "El puente"],
      ["Puente", "El puente"],
    ];
    const pasted = (text: string) => {
      const blocks = splitPastedSong(text);
      return applyPaste(null, markers, blocks, proposePasteAssignment(blocks, chartParts(null, markers), markers)).chart;
    };

    it("with headers the first goes to the first verse and the second to the second", () => {
      const chart = pasted(["VERSO", "Primer verso", "", "CORO", "El coro", "", "VERSO", "Segundo verso", "", "PUENTE", "El puente"].join("\n"));
      expect(plainByLabel(chart, markers)).toEqual(expected);
    });

    it("without headers too; the bridges left copy the first one", () => {
      const chart = pasted(["Primer verso", "", "El coro", "", "Segundo verso", "", "El coro", "", "El puente"].join("\n"));
      expect(plainByLabel(chart, markers)).toEqual(expected);
    });
  });
});
