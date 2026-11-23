import { describe, expect, it } from "vitest";

import type { SectionMarkerSummary } from "../models";

import { buildImportReview } from "./chartImportReview";
import { looksLikeChordPro, splitSectionHeaderLines } from "./chartImport";
import { matchChartToMarkers } from "./chartMatch";
import { parseChordPro } from "./chordChart";
import { normalizeImportedChart, planningCenterToImported } from "./importedChart";

/**
 * Shapes found in real Planning Center sheets of a church's repertoire (the
 * words here are invented): headers that carry a note or chords, spaced
 * repeat marks, a line ending in "x2", sheets mixing [C] lines with chords
 * written over the words, chords typed in Planning Center's proportional
 * font.
 */

const sheet = (chordChart: string) =>
  parseChordPro(normalizeImportedChart(planningCenterToImported({ id: "a", songId: "s", chordChart })).text);
const words = (line: ReturnType<typeof sheet>["sections"][number]["lines"][number]) =>
  line.kind === "lyrics" ? line.segments.map((segment) => segment.text).join("") : line.kind === "comment" ? `(${line.text})` : "";

describe("headers that carry something after the name", () => {
  it.each([
    ["PUENTE SEGUIDO", "Puente", null],
    ["PUENTE (bajamos todos)", "Puente", "bajamos todos"],
    ["INTRO PIANOS: C  G   C  G", "Intro", "PIANOS"],
    ["Intro: E Esus2 E Esus2", "Intro", null],
    ["INSTRUMENTAL: C  G/B", "Instrumental", null],
    ["INTRO |F - Am - G - C/E | F - Am - G - C/E |", "Intro", null],
  ])("%s is the header %s", (line, label, note) => {
    const doc = sheet(`${line}\n\nVERSO\nG\nUna luz`);
    expect(doc.sections[0].label).toBe(label);
    if (note) expect(doc.sections[0].lines.map(words)).toContain(`(${note})`);
  });

  it("a lyric line in capitals is not a header", () => {
    expect(splitSectionHeaderLines("PARAMOS TODOS\nBATERIA 1 2 3", false)).toBe("PARAMOS TODOS\nBATERIA 1 2 3");
  });
});

describe("repeats written in other ways", () => {
  it("spaced slashes / / / are a repeat mark", () => {
    const doc = sheet(
      [
        "PUENTE",
        "     G  C",
        "/ / /    Yo sé que tú",
        "D/F# G",
        "      Yo creo en ti / / /",
        "G  C",
        "Otra vez",
      ].join("\n"),
    );
    const lines = doc.sections[0].lines.map(words);
    expect(lines.filter((line) => line.includes("Yo sé que tú"))).toHaveLength(3);
    expect(lines.join(" ")).not.toContain("/");
  });

  it("a line ending in x2 is written out twice", () => {
    const doc = sheet(["PUENTE", "G", "Una vez más, x2", "C", "Y ya"].join("\n"));
    expect(doc.sections[0].lines.map(words)).toEqual(["Una vez más", "Una vez más", "Y ya"]);
  });
});

describe("mixed sheets", () => {
  it("a [C] line among chords written over the words is still a plain sheet", () => {
    const text = [
      "VERSO 1",
      "Somos la luz de [G]hoy",
      "                    Em",
      "Somos un canto nuevo",
      "VERSO 2",
      "Somos la luz de [G]hoy",
      "                 C",
      "su voz nos llamó",
    ].join("\n");
    expect(looksLikeChordPro(text)).toBe(false);
    const doc = sheet(text);
    // The chord line is a chord over the words, not a line of lyrics.
    expect(doc.sections[0].lines.map(words)).toEqual(["Somos la luz de hoy", "Somos un canto nuevo"]);
  });
});

describe("chords typed in Planning Center's proportional font", () => {
  it("land over the syllable Planning Center draws them on, not after the line", () => {
    const doc = sheet(["CORO", "                  F", "// Santo de verdad", "                          Am", "Eres santo de verdad //"].join("\n"));
    const first = doc.sections[0].lines[0];
    if (first.kind !== "lyrics") throw new Error("lyrics expected");
    expect(first.segments.find((segment) => segment.chord === "F")?.text).toBe("verdad");
  });
});

describe("matching with repeats", () => {
  const marker = (id: string, name: string, kind: SectionMarkerSummary["kind"]): SectionMarkerSummary => ({ id, name, startSeconds: 0, kind });

  it("after a repeated chorus the next chorus marker reads the next chorus", () => {
    const doc = parseChordPro(
      normalizeImportedChart({
        title: "T",
        text: ["CORO 2", "// Uno", "dos //", "CORO 3", "Tres", "PUENTE 1", "// Luz //", "PUENTE 2", "Sol", "PUENTE 3", "/// Mar ///"].join("\n"),
      }).text,
    );
    const song = [marker("a", "Coro", "chorus"), marker("b", "Coro", "chorus"), marker("c", "Puente", "bridge"), marker("d", "Puente", "bridge"), marker("e", "Puente", "bridge")];
    expect(matchChartToMarkers(doc, song).items.map((item) => item.section)).toEqual([0, 1, 2, 3, 4]);
  });

  it("one marker never sings a section more times than the sheet says", () => {
    // 60 BPM in 4/4: 4 s a bar, one bar a line. A 3-line "// … //" chorus in an
    // 8-bar marker would fit nearly 3 passes; the sheet says 2.
    const timing = { regionEndSeconds: 32, secondsPerBeatAt: () => 1, beatsPerBarAt: () => 4 };
    const review = buildImportReview(
      { title: "T", text: ["CORO", "// Uno", "Dos", "Tres //"].join("\n") },
      [{ id: "c", name: "Coro", startSeconds: 0, kind: "chorus" }],
      null,
      [],
      timing,
    );
    expect(review.rows[0].passes).toBe(2);
  });
});

describe("a sheet saved with slashes, imported again", () => {
  it("reads the chords between slashes as a repeated part without words, and the copies by name", () => {
    const imported = normalizeImportedChart(
      planningCenterToImported({
        id: "a",
        songId: "s",
        chordChart: ["INTRO // Bm D G A //", "", "VAMP", "[Bm] [D] [G] [A]", "", "CORO", "Digno de [G]alabar"].join("\n"),
      }),
    );
    const doc = parseChordPro(imported.text);
    expect(doc.sections.map((section) => section.label)).toEqual(["Intro", "Vamp", "Coro"]);
    expect(imported.text).not.toContain("/");
    expect(imported.repeats?.[0]).toBe(2);
  });
});
