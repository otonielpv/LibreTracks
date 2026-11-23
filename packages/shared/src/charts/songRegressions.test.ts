import { describe, expect, it } from "vitest";

import type { SectionMarkerSummary } from "../models";

import { buildImportReview, finalizeImport, type ReviewTiming } from "./chartImportReview";
import { buildPerformanceBlocks, chartLinkFor, chartLinkPasses, resolveChartPlayback } from "./chartSync";
import { parseChordPro } from "./chordChart";
import { planningCenterToImported } from "./importedChart";
import { planningCenterExport } from "./planningCenterExport";

/**
 * Two real songs of a real session (TestLetras2): the markers, their times and
 * the tempo are the session's; the sheets have the shape of their Planning
 * Center charts (headers with chords on the line, "// … //" repeats, chords
 * written past the end of a line) with invented words.
 */

type MarkerRow = [seconds: number, kind: SectionMarkerSummary["kind"], name: string];
const markers = (rows: MarkerRow[]): SectionMarkerSummary[] =>
  rows.map(([startSeconds, kind, name], index) => ({ id: `m${index}`, name, startSeconds, kind }));

/** 67.5 BPM in 4/4 until 373.3 s, then 138 BPM (Te doy gloria). */
const timing = (regionEndSeconds: number): ReviewTiming => ({
  regionEndSeconds,
  secondsPerBeatAt: (seconds) => 60 / (seconds >= 373.3 ? 138 : 67.5),
  beatsPerBarAt: () => 4,
});

const DIGNO_MARKERS = markers([
  [7.11, "intro", "Intro"],
  [21.33, "verse", "Verso"],
  [49.78, "vamp", "Vamp"],
  [53.33, "chorus", "Coro"],
  [78.22, "interlude", "Interludio"],
  [92.45, "verse", "Verso"],
  [120.89, "chorus", "Coro"],
  [149.33, "chorus", "Coro"],
  [177.78, "instrumental", "Instrumental"],
  [192.0, "bridge", "Puente"],
  [206.22, "bridge", "Puente"],
  [220.45, "bridge", "Puente"],
  [234.67, "bridge", "Puente"],
  [248.89, "bridge", "Puente"],
  [263.11, "bridge", "Puente"],
  [277.34, "instrumental", "Instrumental"],
  [291.56, "instrumental", "Instrumental"],
  [305.78, "chorus", "Coro"],
  [334.22, "chorus", "Coro"],
  [362.67, "ending", "Final"],
]);

const DIGNO_SHEET = [
  "INTRO // Am  C  F  G  //",
  "",
  "VERSO 1",
  "C               G4            G",
  " Brilla la mañana en el mar",
  "             C               F               C  G",
  "Cantan las piedras, cantan los montes",
  "C            G4         G",
  "Y hoy vuelvo a casa",
  "               C                F              C  G",
  "Siempre en tu camino voy a estar",
  "",
  "CORO 1",
  "                  F",
  "// Santo y fiel",
  " Am G",
  "Rey",
  "                     Em",
  "Luz sin final",
  "                          Am",
  "Eres santo y fiel //",
  "",
  "INTRO // Am  C  F  G  //",
  "",
  "VERSO 2",
  "C                 G4     G",
  " Lejos queda la noche",
  "                 C/E         F                   C  G",
  "Abierta está la puerta del jardín",
  "C                 G4         G",
  " Nueva es la mañana",
  "               C/E           F              C  G",
  "Siempre en tu camino voy a estar",
  "",
  "CORO 2",
  "                        F",
  "//// Santo y fiel",
  "Am  G",
  "Rey",
  "                     Em",
  "Luz sin final",
  "                             Am G",
  "Eres santo y fiel   ////",
  "",
  "INSTRUMENTAL F  Dm  Am G4  C/E",
  "",
  "PUENTE",
  "             F",
  "//// Alto en el cielo estás",
  "          Dm",
  "Llena este lugar",
  "          Am",
  "Eres santo y fiel",
  "               G",
  "No hay nadie igual ////",
  "",
  "CORO 3",
  "                           F",
  "//// Santo y fiel",
  "Am  G",
  "Rey",
  "                    Em",
  "Luz sin final",
  "                             Am G",
  " Eres santo y fiel ////",
  "",
  "FINAL G  F",
].join("\n");

const TDG_MARKERS = markers([
  [376.81, "intro", "Intro"],
  [390.73, "verse", "Verso"],
  [418.55, "pre_chorus", "Pre Coro"],
  [432.47, "chorus", "Coro"],
  [460.29, "verse", "Verso"],
  [488.12, "pre_chorus", "Pre Coro"],
  [502.03, "chorus", "Coro"],
  [529.86, "instrumental", "Instrumental"],
  [543.77, "bridge", "Puente"],
  [557.69, "bridge", "Puente"],
  [571.6, "bridge", "Puente"],
  [585.51, "chorus", "Coro"],
  [599.43, "chorus", "Coro"],
  [613.34, "chorus", "Coro"],
  [627.25, "chorus", "Coro"],
  [641.17, "ending", "Final"],
  [658.56, "ending", "Final"],
]);

const TDG_SHEET = [
  "INTRO //// G ////",
  "",
  "VERSO 1",
  "G                            D",
  "Que bueno es el camino,",
  "                    Em                          C",
  "son tus pasos, es tu luz.",
  "                   G                       D",
  "Que bueno es el camino,",
  "                 Em            C",
  "es tu voz y tu canción.",
  "",
  "PRECORO 1",
  "                             G                     D",
  "La que me llamó, me buscó;",
  "               Em                         C",
  "un momento aquí me dio verdad.",
  "",
  "CORO 1",
  "                G",
  "// Te canto hoy, canto,",
  "                D",
  "Te canto hoy, canto,",
  "               Em",
  "Te canto hoy, canto",
  "            C",
  "a ti, Señor //",
  "",
  "VERSO 2",
  "G                            D",
  "Que bueno es el camino,",
  "                    Em                          C",
  "son tus pasos, es tu luz.",
  "                   G                       D",
  "Que bueno es el camino,",
  "                 Em            C",
  "es tu voz y tu canción.",
  "",
  "PRECORO 2",
  "                             G                     D",
  "La que me llamó, me buscó;",
  "               Em                         C",
  "un momento aquí me dio verdad.",
  "",
  "CORO 2",
  "                G",
  "// Te canto hoy, canto,",
  "                D",
  "Te canto hoy, canto,",
  "               Em",
  "Te canto hoy, canto",
  "            C",
  "a ti, Señor //",
  "",
  "PUENTE",
  "           G                          D",
  "//// Con una luz de mañana",
  "       Em                    C",
  "te hiciste Rey por siempre. ////",
  "",
  "CORO 3",
  "                G",
  "// Te canto hoy, canto,",
  "                D",
  "Te canto hoy, canto,",
  "               Em",
  "Te canto hoy, canto",
  "            C",
  "a ti, Señor //",
].join("\n");

const review = (sheet: string, songMarkers: SectionMarkerSummary[], songKey: string, end: number, key = "C") =>
  buildImportReview(planningCenterToImported({ id: "a", songId: "s", chordChart: sheet, chordChartKey: key }), songMarkers, songKey, [], timing(end));

const labelsAndPasses = (built: ReturnType<typeof review>) =>
  built.rows.map((row) => [row.name, row.section === null ? null : built.doc.sections[row.section].label, row.passes]);

describe("Digno (67.5 BPM)", () => {
  const built = review(DIGNO_SHEET, DIGNO_MARKERS, "D", 373.34);

  it("each marker gets its section and the times it is sung", () => {
    expect(labelsAndPasses(built)).toEqual([
      ["Intro", "Intro", 1],
      ["Verso", "Verso 1", 1],
      ["Vamp", null, 1],
      ["Coro", "Coro 1", 2],
      ["Interludio", "Instrumental", 1],
      ["Verso", "Verso 2", 1],
      ["Coro", "Coro 2", 2],
      ["Coro", "Coro 2", 2],
      ["Instrumental", "Instrumental", 1],
      ["Puente", "Puente", 1],
      ["Puente", "Puente", 1],
      ["Puente", "Puente", 1],
      ["Puente", "Puente", 1],
      ["Puente", "Puente", 1],
      ["Puente", "Puente", 1],
      ["Instrumental", "Instrumental", 1],
      ["Instrumental", "Instrumental", 1],
      ["Coro", "Coro 3", 2],
      ["Coro", "Coro 3", 2],
      ["Final", "Final", 1],
    ]);
  });

  it("transposes once, from C to the song's D, and says so in the text", () => {
    const chart = finalizeImport(built, { transpose: true, linked: true });
    const doc = parseChordPro(chart.text);
    expect(doc.key).toBe("D");
    const intro = doc.sections[0].lines[0];
    expect(intro.kind === "lyrics" && intro.segments.map((segment) => segment.chord)).toEqual(["Bm", "D", "G", "A"]);
  });
});

describe("Te doy gloria (138 BPM)", () => {
  const built = review(TDG_SHEET, TDG_MARKERS, "G", 665.51, "G");

  it("each marker gets its section and the times it is sung", () => {
    expect(labelsAndPasses(built)).toEqual([
      ["Intro", "Intro", 1],
      ["Verso", "Verso 1", 1],
      ["Pre Coro", "Precoro 1", 1],
      ["Coro", "Coro 1", 2],
      ["Verso", "Verso 2", 1],
      ["Pre Coro", "Precoro 2", 1],
      ["Coro", "Coro 2", 2],
      ["Instrumental", null, 1],
      ["Puente", "Puente", 2],
      ["Puente", "Puente", 2],
      ["Puente", "Puente", 2],
      ["Coro", "Coro 3", 1],
      ["Coro", "Coro 3", 1],
      ["Coro", "Coro 3", 1],
      ["Coro", "Coro 3", 1],
      ["Final", null, 1],
      ["Final", null, 1],
    ]);
  });

  it("chords written past the end of the pre-chorus lines land over the words", () => {
    const precoro = built.doc.sections.find((section) => section.label === "Precoro 1")!;
    const first = precoro.lines[0];
    if (first.kind !== "lyrics") throw new Error("expected lyrics");
    // G over the middle of the line, D at its end: not both piled at the end.
    const g = first.segments.findIndex((segment) => segment.chord === "G");
    expect(g).toBeGreaterThan(0);
    expect(first.segments.slice(g).map((segment) => segment.text).join("").length).toBeGreaterThan(4);
  });

  it("Live shows each bridge pass: six bridges in three markers", () => {
    const chart = finalizeImport(built, { transpose: false, linked: true });
    const doc = parseChordPro(chart.text);
    const passes = (markerId: string) => chartLinkPasses(chartLinkFor(chart.links, markerId));
    const { blocks } = buildPerformanceBlocks(doc, chart.links, TDG_MARKERS, [], null, false, passes);
    expect(blocks.filter((block) => block.label === "Puente")).toHaveLength(6);
    expect(blocks.filter((block) => block.label === "Coro")).toHaveLength(2 + 2 + 4);
    // Playing the second half of the first bridge marker: its second block.
    const bridge = TDG_MARKERS.find((marker) => marker.name === "Puente")!;
    const playback = resolveChartPlayback(doc, chart.links, TDG_MARKERS, 665.51, bridge.startSeconds + 10, () => 60 / 138);
    expect(playback.pass).toBe(1);
    const history = [{ seq: 0, markerId: bridge.id }];
    const playing = buildPerformanceBlocks(doc, chart.links, TDG_MARKERS, history, null, false, passes, playback.pass);
    expect(playing.blocks[playing.current]).toMatchObject({ label: "Puente", pass: 1, passes: 2 });
  });

  it("saving with slashes writes the total times in the sheet and no sequence", () => {
    const chart = finalizeImport(built, { transpose: false, linked: true });
    const marks = planningCenterExport(chart.text, chart.links, TDG_MARKERS, "marks");
    expect(marks.sequence).toBeUndefined();
    // Bridge 2 + 2 + 2; Coro 3 once in each of four markers; Coro 1 twice.
    expect(marks.chordChart).toContain("PUENTE\n////// [G]Con una luz");
    expect(marks.chordChart).toMatch(/CORO 3\n\/\/\/\/ /);
    expect(marks.chordChart).toMatch(/CORO 1\n\/\/ /);
    const sequence = planningCenterExport(chart.text, chart.links, TDG_MARKERS, "sequence");
    expect(sequence.chordChart).not.toContain("//");
    expect(sequence.sequence?.filter((label) => label === "Puente")).toHaveLength(6);
  });
});
