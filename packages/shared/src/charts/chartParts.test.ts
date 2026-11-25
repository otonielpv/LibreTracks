import { describe, expect, it } from "vitest";

import type { MarkerKind, SectionMarkerSummary, SongChart } from "../models";

import { analyzeSongSheet, textToSourceLines } from "./chartImport";
import { addPart, applyPartEdit, chartPartEntries, chartParts } from "./chartParts";
import { parseChordPro, parseChordProWithPlaces, serializeChordPro } from "./chordChart";
import { chartTextHash } from "./importedChart";
import { canonicalLabel } from "./sectionVocab";

const marker = (id: string, name: string, at: number, kind: MarkerKind = "custom", variant: number | null = null): SectionMarkerSummary => ({
  id,
  name,
  startSeconds: at,
  kind,
  variant,
});

const SONG_MARKERS = [
  marker("m1", "Intro", 0, "intro"),
  marker("m2", "Verso 1", 10, "verse", 1),
  marker("m3", "Coro", 20, "chorus"),
  marker("m4", "Verso 2", 30, "verse", 2),
  marker("m5", "Coro", 40, "chorus"),
  marker("m6", "Puente", 50, "bridge"),
  marker("m7", "Coro", 60, "chorus"),
];

/** Invented lyrics, Planning Center style (title/key header, sections). */
const PC_TEXT = [
  "{title: Canción de prueba}",
  "{key: G}",
  "",
  "{section: Intro}",
  "[G] [D] [Em] [C]",
  "",
  "{section: Verso 1}",
  "[G]Camino por la [D]senda",
  "[Em]Con paso [C]firme",
  "",
  "{section: Coro}",
  "[C]Santo eres [G]tú",
  "[Am]Digno de [D]honor",
  "",
  "{section: Verso 2}",
  "[G]Canto en la [D]mañana",
  "",
  "{section: Puente}",
  "[Em]Siempre [C]fiel",
  "",
].join("\n");

const PC_CHART: SongChart = {
  text: PC_TEXT,
  links: [
    { markerId: "m1", section: 0 },
    { markerId: "m2", section: 1, lineBeats: [0, 8] },
    { markerId: "m3", section: 2, lineBeats: [0, 4] },
    { markerId: "m4", section: 3 },
    { markerId: "m5", section: 2 },
    { markerId: "m6", section: 4 },
    { markerId: "m7", section: 2 },
  ],
  source: { provider: "planningCenter", songId: "1", arrangementId: "2", importedHash: chartTextHash(PC_TEXT) },
};

const CHORUS_PLAIN = ["C          G", "Santo eres tú", "Am       D", "Digno de honor"].join("\n");

/** Rows of every section except `skip`, raw, as they are in the text. */
function otherRows(text: string, skip: number): string[][] {
  const { doc, sectionStarts } = parseChordProWithPlaces(text);
  const rows = text.split("\n");
  return doc.sections
    .map((_, index) => rows.slice(sectionStarts[index], sectionStarts[index + 1] ?? rows.length))
    .filter((_, index) => index !== skip);
}

describe("chartParts", () => {
  it("C1: one part per marker, in song order, each on its own", () => {
    const parts = chartParts(null, SONG_MARKERS);
    expect(parts.map((part) => part.label)).toEqual(["Intro", "Verso 1", "Coro", "Verso 2", "Coro", "Puente", "Coro"]);
    expect(parts.every((part) => part.markerIds.length === 1 && part.times === 1)).toBe(true);
    expect(parts.find((part) => part.label === "Intro")?.sung).toBe(false);
    expect(parts.every((part) => part.section === null && part.plain === "")).toBe(true);
  });

  it("C1: repeats from arrangements and cues are not parts", () => {
    const parts = chartParts(null, [...SONG_MARKERS, marker("m3~1", "Coro", 70, "chorus"), marker("c1", "Aviso", 5, "get_ready")]);
    expect(parts).toHaveLength(7);
  });

  it("C2: a sheet linking several markers to one section shows it in each; saving untouched is identical", () => {
    const parts = chartParts(PC_CHART, SONG_MARKERS);
    expect(parts.filter((part) => part.label === "Coro").map((part) => part.section)).toEqual([2, 2, 2]);
    for (const part of parts) {
      expect(applyPartEdit(PC_CHART, SONG_MARKERS, part.key, part.plain).chart).toBe(PC_CHART);
    }
  });

  it("shows the plain text of each part", () => {
    expect(chartParts(PC_CHART, SONG_MARKERS)[2].plain).toBe(CHORUS_PLAIN);
  });
});

describe("applyPartEdit", () => {
  it("C3: Planning Center sheet, the rest of the text stays byte for byte", () => {
    const verse = chartParts(PC_CHART, SONG_MARKERS)[1];
    const { chart } = applyPartEdit(PC_CHART, SONG_MARKERS, verse.key, ["G               D", "Camino por la senda", "Em       C", "Con paso firme y fiel"].join("\n"));
    expect(chart?.text).not.toBe(PC_TEXT);
    expect(otherRows(chart!.text, 1)).toEqual(otherRows(PC_TEXT, 1));
    expect(chart!.text.startsWith(["{title: Canción de prueba}", "{key: G}", ""].join("\n"))).toBe(true);
    expect(parseChordPro(chart!.text).sections[1].lines[1]).toEqual({
      kind: "lyrics",
      segments: [
        { chord: "Em", text: "Con paso " },
        { chord: "C", text: "firme y fiel" },
      ],
    });
  });

  it("C3: sheet imported from a PDF-like layout, the rest stays byte for byte", () => {
    const sheet = ["VERSO 1", "G             D", "Camino por la senda", "CORO", "C          G", "Santo eres tú", "PUENTE", "Em      C", "Siempre fiel"].join("\n");
    const text = serializeChordPro(analyzeSongSheet(textToSourceLines(sheet)));
    const markers = [marker("a", "Verso 1", 0, "verse", 1), marker("b", "Coro", 10, "chorus"), marker("c", "Puente", 20, "bridge")];
    const chart: SongChart = { text, links: [{ markerId: "a", section: 0 }, { markerId: "b", section: 1 }, { markerId: "c", section: 2 }] };
    const { chart: edited } = applyPartEdit(chart, markers, "m:b", "Santo eres tú, Señor");
    expect(otherRows(edited!.text, 1)).toEqual(otherRows(text, 1));
  });

  it("editing one of several markers sharing a section gives it its own; the others keep theirs", () => {
    const { chart } = applyPartEdit(PC_CHART, SONG_MARKERS, "m:m7", "Otra letra al final");
    expect(chart!.text.startsWith(PC_TEXT)).toBe(true);
    expect(chartParts(chart, SONG_MARKERS).filter((part) => part.label === "Coro").map((part) => part.plain)).toEqual([
      CHORUS_PLAIN,
      CHORUS_PLAIN,
      "Otra letra al final",
    ]);
    // Emptying one that still shares only unlinks it.
    const emptied = applyPartEdit(PC_CHART, SONG_MARKERS, "m:m5", "");
    expect(emptied.chart!.text).toBe(PC_TEXT);
    expect(emptied.chart!.links.some((link) => link.markerId === "m5")).toBe(false);
  });

  it("C4: same number of lines keeps the times; another number clears only this part's", () => {
    const same = applyPartEdit(PC_CHART, SONG_MARKERS, "m:m2", ["Camino", "Paso firme"].join("\n"));
    expect(same.clearedTimes).toBe(false);
    expect(same.chart?.links).toEqual(PC_CHART.links);

    const longer = applyPartEdit(PC_CHART, SONG_MARKERS, "m:m2", ["Camino", "Paso firme", "Siempre"].join("\n"));
    expect(longer.clearedTimes).toBe(true);
    expect(longer.chart?.links.find((link) => link.markerId === "m2")?.lineBeats).toBeUndefined();
    expect(longer.chart?.links.find((link) => link.markerId === "m3")?.lineBeats).toEqual([0, 4]);

    const sharedLonger = applyPartEdit(PC_CHART, SONG_MARKERS, "m:m3", ["Santo", "Digno", "Siempre"].join("\n"));
    expect(sharedLonger.clearedTimes).toBe(true);
    expect(sharedLonger.chart?.links.find((link) => link.markerId === "m3")?.lineBeats).toBeUndefined();
  });

  it("C5: a song without a chart gets the section and the link of its marker", () => {
    const { chart } = applyPartEdit(null, SONG_MARKERS, "m:m3", ["C          G", "Santo eres tú"].join("\n"));
    expect(chart?.text).toBe(["{section: Coro}", "[C]Santo eres [G]tú", ""].join("\n"));
    expect(chart?.links).toEqual([{ markerId: "m3", section: 0 }]);
    const after = chartParts(chart!, SONG_MARKERS);
    expect(after[2].section).toBe(0);
    expect(after[4].section).toBeNull();
  });

  it("C8: emptying a part does not move the other parts' links", () => {
    const { chart } = applyPartEdit(PC_CHART, SONG_MARKERS, "m:m2", "   ");
    const doc = parseChordPro(chart!.text);
    expect(doc.sections.map((section) => section.label)).toEqual(["Intro", "Coro", "Verso 2", "Puente"]);
    const label = (markerId: string) => {
      const link = chart!.links.find((entry) => entry.markerId === markerId);
      return link ? doc.sections[link.section].label : null;
    };
    expect(["m1", "m2", "m3", "m4", "m5", "m6", "m7"].map(label)).toEqual(["Intro", null, "Coro", "Verso 2", "Coro", "Puente", "Coro"]);
    expect(chart!.links.find((link) => link.markerId === "m3")?.lineBeats).toEqual([0, 4]);
  });

  it("C9: the source is not touched (edited here shows by the text hash)", () => {
    const { chart } = applyPartEdit(PC_CHART, SONG_MARKERS, "m:m2", "Otra letra");
    expect(chart?.source).toBe(PC_CHART.source);
    expect(chartTextHash(chart!.text)).not.toBe(PC_CHART.source?.importedHash);
  });
});

describe("addPart", () => {
  it("C7: numbers parts by kind, in the sheet's language, at the end", () => {
    let chart: SongChart | null = null;
    const keys: string[] = [];
    for (const kind of ["verse", "chorus", "verse"] as MarkerKind[]) {
      const added = addPart(chart, kind, "es");
      chart = added.chart;
      keys.push(added.key);
    }
    expect(chartParts(chart, []).map((part) => part.label)).toEqual(["Verso", "Coro", "Verso 2"]);
    expect(keys).toEqual(["s:0", "s:1", "s:2"]);
    const english = addPart({ text: ["{section: Chorus}", "Holy", ""].join("\n"), links: [] }, "verse", "es");
    expect(chartParts(english.chart, []).map((part) => part.label)).toEqual(["Chorus", "Verse"]);
  });

  it("C7: without markers the sheet's order rules and editing writes its section", () => {
    const chart: SongChart = { text: ["{section: Coro}", "Santo", "", "{section: Verso}", "Camino", ""].join("\n"), links: [] };
    const parts = chartParts(chart, []);
    expect(parts.map((part) => part.label)).toEqual(["Coro", "Verso"]);
    const { chart: edited } = applyPartEdit(chart, [], parts[1].key, "Camino por la senda");
    expect(edited?.text).toBe(["{section: Coro}", "Santo", "", "{section: Verso}", "Camino por la senda", ""].join("\n"));
  });

  it("the quick names read back to their kind", () => {
    for (const kind of ["intro", "verse", "pre_chorus", "chorus", "bridge", "ending"] as MarkerKind[]) {
      const { chart } = addPart(null, kind, "es");
      expect(canonicalLabel(chartParts(chart, [])[0].label, "header")?.kind).toBe(kind);
    }
  });
});

describe("chartPartEntries", () => {
  it("one row per marker, in song order, each its own part", () => {
    const entries = chartPartEntries(chartParts(PC_CHART, SONG_MARKERS), SONG_MARKERS);
    expect(entries.map((entry) => [entry.position, entry.label, entry.partKey])).toEqual([
      [1, "Intro", "m:m1"],
      [2, "Verso 1", "m:m2"],
      [3, "Coro", "m:m3"],
      [4, "Verso 2", "m:m4"],
      [5, "Coro", "m:m5"],
      [6, "Puente", "m:m6"],
      [7, "Coro", "m:m7"],
    ]);
  });

  it("without markers, one row per part", () => {
    const chart: SongChart = { text: ["{section: Coro}", "Santo", "", "{section: Verso}", "Camino", ""].join("\n"), links: [] };
    expect(chartPartEntries(chartParts(chart, []), []).map((entry) => [entry.key, entry.label])).toEqual([
      ["s:0", "Coro"],
      ["s:1", "Verso"],
    ]);
  });
});
