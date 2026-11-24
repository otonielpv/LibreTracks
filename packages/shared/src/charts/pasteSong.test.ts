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

const labelOf = (key: string | null) => chartParts(null, MARKERS).find((part) => part.key === key)?.label ?? null;

describe("pasting a whole song", () => {
  it("C1: headers send each block to its part, even with the chorus repeated", () => {
    const blocks = splitPastedSong(WITH_HEADERS);
    expect(blocks.map((block) => block.label)).toEqual(["Verso 1", "Coro", "Verso 2", "Coro", "Puente"]);
    const assignments = proposePasteAssignment(blocks, chartParts(null, MARKERS), MARKERS);
    expect(assignments.map((assignment) => labelOf(assignment.partKey))).toEqual(["Verso 1", "Coro", "Verso 2", null, "Puente"]);
    const { chart } = applyPaste(null, MARKERS, blocks, assignments.map((assignment, index) => (index === 3 ? { ...assignment, partKey: "m:c1" } : assignment)));
    const parts = chartParts(chart, MARKERS);
    expect(parts.map((part) => part.plain)).toEqual([
      "Camino por la senda\nCon paso firme",
      "Santo eres tú\nDigno de honor",
      "Canto en la mañana",
      "Siempre fiel",
    ]);
  });

  it("C2: without headers, the block that comes back is the chorus and the rest go in order", () => {
    const blocks = splitPastedSong(HOLYRICS);
    expect(blocks).toHaveLength(5);
    const assignments = proposePasteAssignment(blocks, chartParts(null, MARKERS), MARKERS);
    expect(assignments.map((assignment) => labelOf(assignment.partKey))).toEqual(["Verso 1", "Coro", "Verso 2", "Coro", "Puente"]);
    const { chart } = applyPaste(null, MARKERS, blocks, assignments);
    const chorus = chartParts(chart, MARKERS).find((part) => part.label === "Coro");
    expect(chorus?.plain).toBe("Santo eres tú\nDigno de honor");
    expect(chorus?.times).toBe(3);
  });

  it("C3: blocks left over become new parts; nothing is lost", () => {
    const extra = `${HOLYRICS}\n\nOtra estrofa más\n\nY otra más`;
    const blocks = splitPastedSong(extra);
    const assignments = proposePasteAssignment(blocks, chartParts(null, MARKERS), MARKERS);
    expect(assignments.slice(-2).map((assignment) => assignment.partKey)).toEqual([null, null]);
    const { chart } = applyPaste(null, MARKERS, blocks, assignments);
    const doc = parseChordPro(chart!.text);
    const text = doc.sections.flatMap((section) => section.lines).map((line) => (line.kind === "lyrics" ? line.segments.map((s) => s.text).join("") : ""));
    for (const row of ["Otra estrofa más", "Y otra más", "Siempre fiel", "Canto en la mañana"]) expect(text).toContain(row);
  });

  it("C3: fewer blocks than parts leaves the rest empty", () => {
    const blocks = splitPastedSong("Camino por la senda");
    const assignments = proposePasteAssignment(blocks, chartParts(null, MARKERS), MARKERS);
    const { chart } = applyPaste(null, MARKERS, blocks, assignments);
    expect(chartParts(chart, MARKERS).filter((part) => part.section !== null).map((part) => part.label)).toEqual(["Verso 1"]);
  });

  it("C4: chords over the lyric read the same as one part of the editor", () => {
    const verse = "G             D\nCamino por la senda";
    const blocks = splitPastedSong(`VERSO 1\n${verse}\n\nCORO\nC          G\nSanto eres tú`);
    expect(blocks[0].lines).toEqual(plainToSectionLines(verse));
    expect(blocks[1].lines).toEqual(plainToSectionLines("C          G\nSanto eres tú"));
  });

  it("a song without markers gets one part per pasted block", () => {
    const blocks = splitPastedSong(WITH_HEADERS);
    const assignments = proposePasteAssignment(blocks, [], []);
    const { chart } = applyPaste(null, [], blocks, assignments);
    expect(chartParts(chart, []).map((part) => part.label)).toEqual(["Verso 1", "Coro", "Verso 2", "Coro", "Puente"]);
  });
});
