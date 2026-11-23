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

describe("how many times a section plays inside its marker", () => {
  // Song markers in seconds at a steady tempo, like Digno: a chorus marker
  // twice as long as one pass, and a 4x chorus split into two markers.
  const song: SectionMarkerSummary[] = [
    { id: "v1", name: "Verso", startSeconds: 0, kind: "verse" },
    { id: "c1", name: "Coro", startSeconds: 14, kind: "chorus" },
    { id: "v2", name: "Verso", startSeconds: 42, kind: "verse" },
    { id: "c2", name: "Coro", startSeconds: 56, kind: "chorus" },
    { id: "c3", name: "Coro", startSeconds: 84, kind: "chorus" },
  ];
  const timing = { regionEndSeconds: 112 };

  it("splits the sheet's count over the markers by their length", () => {
    const sheet = ["VERSO 1", "Uno", "CORO 1", "// Luz", "luz //", "VERSO 2", "Dos", "CORO 2", "//// Sol", "sol ////"].join("\n");
    const review = buildImportReview(imported(sheet), song, null, [], timing);
    expect(review.rows.map((row) => [row.markerId, row.section, row.passes])).toEqual([
      ["v1", 0, 1],
      ["c1", 1, 2],
      ["v2", 2, 1],
      ["c2", 3, 2],
      ["c3", 3, 2],
    ]);
    const links = finalizeImport(review, { transpose: false, linked: true }).links;
    expect(links.find((link) => link.markerId === "c2")?.repeat).toBe(2);
    expect(links.find((link) => link.markerId === "v1")?.repeat).toBeUndefined();
  });

  it("without marks, a marker twice as long as the shortest of its section is two passes", () => {
    const review = buildImportReview(imported(["VERSO", "Uno", "CORO", "Luz"].join("\n")), song, null, [], timing);
    // c1 is 28 s, c2 and c3 28 s too: all one pass (no shorter chorus).
    expect(review.rows.filter((row) => row.markerId.startsWith("c")).map((row) => row.passes)).toEqual([1, 1, 1]);
    const short = song.map((marker) => (marker.id === "c3" ? { ...marker, startSeconds: 98 } : marker));
    const uneven = buildImportReview(imported(["VERSO", "Uno", "CORO", "Luz"].join("\n")), short, null, [], timing);
    expect(uneven.rows.find((row) => row.markerId === "c3")?.passes).toBe(1);
    expect(uneven.rows.find((row) => row.markerId === "c1")?.passes).toBe(2);
  });

  it("keeps the passes the user set", () => {
    const review = buildImportReview(imported(["VERSO", "Uno", "CORO", "Luz"].join("\n")), song, null, [], timing);
    const fixed = relinkImportReview(review, song, review.locked, { c2: 3 });
    expect(fixed.rows.find((row) => row.markerId === "c2")?.passes).toBe(3);
  });
});

describe("passes from the marker's length", () => {
  // A sung line lasts about 3.5 s: at 60 BPM in 4/4 (4 s a bar) one bar a line.
  const timing = { regionEndSeconds: 100, secondsPerBeatAt: () => 1, beatsPerBarAt: () => 4 };
  const sheet = ["VERSO", "Uno", "CORO", "// Luz uno", "Luz dos", "Luz tres", "Luz cuatro //"].join("\n");
  const song = (chorusBars: number): SectionMarkerSummary[] => [
    { id: "v", name: "Verso", startSeconds: 0, kind: "verse" },
    { id: "c", name: "Coro", startSeconds: 8, kind: "chorus" },
    { id: "end", name: "Final", startSeconds: 8 + chorusBars * 4, kind: "ending" },
  ];

  it("a 4-line chorus marked // … // plays twice in 8 bars and once in 4", () => {
    const passesOf = (bars: number) =>
      buildImportReview(imported(sheet), song(bars), null, [], timing).rows.find((row) => row.markerId === "c")?.passes;
    expect(passesOf(8)).toBe(2);
    expect(passesOf(4)).toBe(1);
  });
});

describe("a sheet adjusted twice", () => {
  it("says its key once transposed, so a second adjust does not move it again", () => {
    const first = finalizeImport(buildImportReview(imported(SHEET), SONG, "A"), { transpose: true, linked: true });
    expect(parseChordPro(first.text).key).toBe("A");
    // Adjusting again starts from the key the text says, not the source's.
    const again = buildImportReview({ title: "T", text: first.text, key: parseChordPro(first.text).key }, SONG, "A");
    expect(again.key.semitones).toBe(0);
    const twice = finalizeImport(again, { transpose: true, linked: true });
    expect(twice.text).toBe(first.text);
  });
});
