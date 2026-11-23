import { describe, expect, it } from "vitest";

import type { SectionMarkerSummary } from "../models";

import { buildImportReview, finalizeImport, relinkImportReview } from "./chartImportReview";
import { parseChordPro } from "./chordChart";
import { keySemitonesBetween } from "./chordNotation";
import { chartTextHash, type ImportedChart } from "./importedChart";

const marker = (id: string, name: string, kind: SectionMarkerSummary["kind"] = "custom"): SectionMarkerSummary => ({
  id,
  name,
  startSeconds: 0,
  kind,
});

const imported = (text: string, extra: Partial<ImportedChart> = {}): ImportedChart => ({
  title: "Canción",
  text,
  key: "G",
  source: { provider: "planningCenter", songId: "s1", arrangementId: "a1", updatedAt: "2026-11-20T10:00:00Z", key: "G" },
  ...extra,
});

const SHEET = ["INTRO", "[G] [D]", "VERSO", "[G]Camino por la orilla", "CORO", "[C]Eres mi refugio"].join("\n");
const SONG = [marker("i", "Intro", "intro"), marker("v1", "Verso", "verse"), marker("v2", "Verso", "verse"), marker("c", "Coro", "chorus")];

describe("the import review", () => {
  it("shows every marker with the words that will sound there", () => {
    const review = buildImportReview(imported(SHEET), SONG, "G");
    expect(review.rows.map((row) => [row.name, row.section, row.firstLine])).toEqual([
      ["Intro", 0, "G D"],
      ["Verso", 1, "Camino por la orilla"],
      ["Verso", 1, "Camino por la orilla"],
      ["Coro", 2, "Eres mi refugio"],
    ]);
    expect(review.hasMissing).toBe(false);
  });

  it("includes arrangement repeats, following their original", () => {
    const review = buildImportReview(imported(SHEET), [...SONG, marker("c~1", "Coro", "chorus")], "G");
    expect(review.rows.at(-1)).toMatchObject({ repeatOf: "c", section: 2 });
  });

  it("keeps a fixed choice and saves it", () => {
    const review = buildImportReview(imported(SHEET), SONG, "G");
    const fixed = relinkImportReview(review, SONG, [{ markerId: "v2", section: 2 }]);
    expect(fixed.rows.map((row) => row.section)).toEqual([0, 1, 2, 2]);
    expect(finalizeImport(fixed, { transpose: false, linked: true }).links).toContainEqual({ markerId: "v2", section: 2 });
  });

  it("flags a sung marker left without words", () => {
    const review = buildImportReview(imported(["VERSO", "Uno"].join("\n")), [marker("v", "Verso", "verse"), marker("c", "Coro", "chorus")], null);
    expect(review.hasMissing).toBe(true);
  });

  it("transposes to the song's key when asked, and not otherwise", () => {
    const review = buildImportReview(imported(SHEET), SONG, "A");
    expect(review.key).toEqual({ source: "G", song: "A", semitones: 2 });
    const moved = parseChordPro(finalizeImport(review, { transpose: true, linked: true }).text);
    const chords = (doc: typeof moved) =>
      doc.sections.flatMap((section) => section.lines.flatMap((line) => (line.kind === "lyrics" ? line.segments.map((segment) => segment.chord) : [])));
    expect(chords(moved).filter(Boolean)).toEqual(["A", "E", "A", "D"]);
    const kept = parseChordPro(finalizeImport(review, { transpose: false, linked: true }).text);
    expect(chords(kept).filter(Boolean)).toEqual(["G", "D", "G", "C"]);
  });

  it("imports without linking for a song with no section markers", () => {
    const review = buildImportReview(imported(SHEET), [], "G");
    expect(review.noMarkers).toBe(true);
    expect(finalizeImport(review, { transpose: false, linked: false }).links).toEqual([]);
  });

  it("remembers the source and the fingerprint of the saved text", () => {
    const chart = finalizeImport(buildImportReview(imported(SHEET), SONG, "A"), { transpose: true, linked: true });
    expect(chart.source).toMatchObject({ provider: "planningCenter", songId: "s1", arrangementId: "a1", updatedAt: "2026-11-20T10:00:00Z" });
    expect(chart.source?.importedHash).toBe(chartTextHash(chart.text));
  });

  it("uses the source's sequence", () => {
    const sheet = ["VERSE 1", "Uno", "VERSE 2", "Dos", "CHORUS", "Coro"].join("\n");
    const song = [marker("a", "Verso", "verse"), marker("b", "Verso", "verse"), marker("c", "Coro", "chorus")];
    const guided = buildImportReview(imported(sheet, { sequence: ["Verse 1", "Verse 1", "Chorus 1"] }), song, null);
    expect(guided.rows.map((row) => row.section)).toEqual([0, 0, 2]);
    expect(buildImportReview(imported(sheet), song, null).rows.map((row) => row.section)).toEqual([0, 1, 2]);
  });
});

describe("the interval between two keys", () => {
  it("counts semitones up and refuses mixed modes", () => {
    expect(keySemitonesBetween("G", "A")).toBe(2);
    expect(keySemitonesBetween("A", "G")).toBe(10);
    expect(keySemitonesBetween("Bb", "Do")).toBe(2);
    expect(keySemitonesBetween("Em", "F#m")).toBe(2);
    expect(keySemitonesBetween("G", "Em")).toBeNull();
    expect(keySemitonesBetween("G", null)).toBeNull();
    expect(keySemitonesBetween("Tono E", "E")).toBeNull();
  });
});
