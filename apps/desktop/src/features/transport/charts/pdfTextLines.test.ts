import { describe, expect, it } from "vitest";

import { analyzeSongSheet } from "./chartImport";
import { findColumnGutters, pdfTextToSourceLines, usesDotSpaces, type PdfPageText, type PdfTextItem } from "./pdfTextLines";

/** One item per string, 6 pt per character, 12 pt text. */
function item(str: string, x: number, y: number, size = 12): PdfTextItem {
  return { str, x, y, width: str.length * 6, size };
}

/**
 * Two columns whose rows do not line up (the right one starts higher), spaces
 * written as dots, chords as separate items over the lyric — the layout some
 * worship-chart generators print to fit a song on one page.
 */
function twoColumnPage(): PdfPageText {
  const left = 36;
  const right = 321;
  return {
    width: 612,
    height: 792,
    items: [
      item("Mi.Cancion.[G]", 51, 746, 18),
      item("by.Alguien", 51, 728, 9),
      item("VERSO.1", left, 672),
      item("G", left, 660), item("..........", left + 6, 660), item("D", left + 96, 660),
      item("..Camino.por.la.senda", left, 647),
      item("Em", left, 634), item("......", left + 12, 634),
      item("..Con.paso.firme", left, 621),
      item("C", left, 596), item(".........", left + 6, 596),
      item("..Y.no.temo.nada", left, 583),
      item("CORO.1", right, 685),
      item("..........", right, 672), item("C", right + 60, 672), item("....", right + 66, 672), item("G", right + 90, 672),
      item("Santo.eres.tu.Senor", right, 660),
      item("Am", right, 647),
      item("Digno.de.honor", right, 634),
      item("INSTRUMENTAL", right, 609), item(".", right + 72, 609), item("C", right + 78, 609), item("..", right + 84, 609), item("G", right + 96, 609),
    ],
  };
}

describe("PDF text", () => {
  it("recognises dots used as spaces, but not real full stops", () => {
    expect(usesDotSpaces([twoColumnPage()])).toBe(true);
    const normal: PdfPageText = {
      width: 600,
      height: 800,
      items: [item("This is a line.", 10, 700), item("Another one here.", 10, 680), item("And a third.", 10, 660)],
    };
    expect(usesDotSpaces([normal])).toBe(false);
  });

  it("finds the gutter between the columns", () => {
    const gutters = findColumnGutters(twoColumnPage());
    expect(gutters).toHaveLength(1);
    expect(gutters[0]).toBeGreaterThan(200);
    expect(gutters[0]).toBeLessThan(321);
  });

  it("reads the left column, then the right, into a chart", () => {
    const doc = analyzeSongSheet(pdfTextToSourceLines([twoColumnPage()]));
    expect(doc).toMatchObject({ title: "Mi Cancion", key: "G", artist: "Alguien" });
    expect(doc.sections.map((section) => section.label)).toEqual(["Verso 1", "Coro 1", "Instrumental"]);

    const verse = doc.sections[0].lines;
    expect(verse[0]).toEqual({
      kind: "lyrics",
      segments: [
        { chord: "G", text: "Camino por la " },
        { chord: "D", text: "senda" },
      ],
    });
    // A chord over the leading padding goes on the first word.
    expect(verse[1]).toEqual({ kind: "lyrics", segments: [{ chord: "Em", text: "Con paso firme" }] });

    const chorus = doc.sections[1].lines;
    expect(chorus[0]).toEqual({
      kind: "lyrics",
      segments: [
        { chord: null, text: "Santo eres " },
        { chord: "C", text: "tu " },
        { chord: "G", text: "Senor" },
      ],
    });
    const instrumental = doc.sections[2].lines[0];
    expect(instrumental.kind === "lyrics" && instrumental.segments.map((s) => s.chord)).toEqual(["C", "G"]);
  });

  it("keeps a single-column sheet with real spaces in reading order", () => {
    const page: PdfPageText = {
      width: 600,
      height: 800,
      items: [
        item("Verse 1", 40, 700),
        item("A", 40, 686), item("E", 100, 686),
        item("Walking down the road", 40, 674),
        item("Chorus", 40, 640),
        item("Holy is the Lord.", 40, 626),
      ],
    };
    const doc = analyzeSongSheet(pdfTextToSourceLines([page]));
    expect(doc.sections.map((section) => section.label)).toEqual(["Verse 1", "Chorus"]);
    expect(doc.sections[1].lines[0]).toEqual({
      kind: "lyrics",
      segments: [{ chord: null, text: "Holy is the Lord." }],
    });
  });
});
