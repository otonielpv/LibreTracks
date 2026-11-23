import { describe, expect, it } from "vitest";

import type { SectionMarkerSummary } from "../models";

import { matchChartToMarkers, type MatchOptions } from "./chartMatch";
import { chartLinkFor } from "./chartSync";
import { parseChordPro } from "./chordChart";

/** A sheet with these headers, each with a line of words (or chords for the
 * played parts). */
function sheet(...headers: string[]) {
  return parseChordPro(headers.map((header, index) => `{section: ${header}}\nlinea ${index}`).join("\n"));
}

/** Markers named like a person would, in timeline order: a custom marker is
 * read from its name, like a marker created by typing. */
function markers(...names: string[]): SectionMarkerSummary[] {
  const seen = new Map<string, number>();
  return names.map((name, index) => {
    const [base, repeat] = name.split("~");
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const id = repeat !== undefined ? `${base}#1~${repeat}` : `${base}#${count}`;
    return { id, name: base, startSeconds: index * 10, kind: "custom" };
  });
}

function sections(doc: ReturnType<typeof sheet>, names: string[], options?: MatchOptions) {
  return matchChartToMarkers(doc, markers(...names), options).items.map((item) => item.section);
}

describe("matching a sheet to the song's markers", () => {
  it("C1: follows the song when it repeats a part the sheet writes once", () => {
    const result = matchChartToMarkers(sheet("Intro", "Verso", "Coro"), markers("Intro", "Verso", "Verso", "Coro"));
    expect(result.items.map((item) => item.section)).toEqual([0, 1, 1, 2]);
    expect(result.items[1].confidence).not.toBe("low");
    expect(result.items[2].confidence).not.toBe("low");
  });

  it("C2: understands synonyms across languages", () => {
    const doc = sheet("Intro", "Verse 1", "Pre-Chorus", "Chorus", "Interlude", "Verse 2", "Bridge", "Outro");
    expect(
      sections(doc, [
        "Introducción", "Estrofa 1", "Precoro", "Estribillo", "Instrumental", "Estrofa 2",
        "Pre-coro", "Estribillo", "Puente", "Estribillo", "Final",
      ]),
    ).toEqual([0, 1, 2, 3, 4, 5, 2, 3, 6, 3, 7]);
  });

  it("C3: plain markers read a numbered sheet in order", () => {
    expect(sections(sheet("Verso 1", "Coro", "Verso 2"), ["Verso", "Coro", "Verso", "Coro"])).toEqual([0, 1, 2, 1]);
  });

  it("C3: a numbered marker prefers the section with its number to an unnumbered one", () => {
    const result = matchChartToMarkers(sheet("Verso", "Verso 2"), markers("Verso 2"));
    expect(result.items).toEqual([{ markerId: "Verso 2#1", section: 1, confidence: "high", reason: "number" }]);
  });

  it("C4: a number the sheet does not have takes the nearest verse, never with high confidence", () => {
    const result = matchChartToMarkers(sheet("Verso 1", "Verso 2", "Coro"), markers("Verso 1", "Coro", "Verso 3", "Coro"));
    expect(result.items.map((item) => item.section)).toEqual([0, 2, 1, 2]);
    expect(result.items[2].confidence).toBe("medium");
  });

  it("C5: the source's sequence says which verse a plain marker is", () => {
    const doc = sheet("Verse 1", "Verse 2", "Chorus");
    const song = ["Verso", "Verso", "Coro", "Verso", "Coro"];
    const guided = matchChartToMarkers(doc, markers(...song), { sourceSequence: ["V1", "V1", "C", "V2", "C"] });
    expect(guided.items.map((item) => item.section)).toEqual([0, 0, 2, 1, 2]);
    expect(guided.items.every((item) => item.confidence === "high" && item.reason === "sequence")).toBe(true);
    expect(sections(doc, song)).toEqual([0, 1, 2, 1, 2]);
  });

  it("C6: markers that mean nothing follow the sequence, or the order, with low confidence", () => {
    const doc = sheet("Verse 1", "Chorus", "Verse 2", "Bridge");
    const names = ["A", "B", "A2", "B2", "C"];
    const guided = matchChartToMarkers(doc, markers(...names), { sourceSequence: ["V1", "C", "V2", "C", "B"] });
    expect(guided.items.map((item) => item.section)).toEqual([0, 1, 2, 1, 3]);
    expect(guided.items.every((item) => item.confidence === "low")).toBe(true);
    const ordered = matchChartToMarkers(doc, markers(...names));
    expect(ordered.items.map((item) => item.section)).toEqual([0, 1, 2, 3, null]);
    expect(ordered.items.slice(0, 4).every((item) => item.confidence === "low" && item.reason === "order")).toBe(true);
  });

  it("C7: a played part may have no section; a sung one is a hole", () => {
    const result = matchChartToMarkers(sheet("Verso", "Puente"), markers("Verso", "Instrumental", "Coro"));
    expect(result.items.slice(1)).toEqual([
      { markerId: "Instrumental#1", section: null, confidence: "high", reason: "lyricless" },
      { markerId: "Coro#1", section: null, confidence: "low", reason: "missing" },
    ]);
  });

  it("C8: says which sections no marker shows", () => {
    const result = matchChartToMarkers(sheet("Intro", "Verso", "Coro", "Puente"), markers("Verso", "Coro"));
    expect(result.unusedSections).toEqual([0, 3]);
  });

  it("C9: families join names of the same part and nothing else", () => {
    expect(sections(sheet("Interludio"), ["Turnaround"])).toEqual([0]);
    expect(sections(sheet("Instrumental"), ["Interludio"])).toEqual([0]);
    expect(sections(sheet("Coro"), ["Refrán"])).toEqual([0]);
    expect(sections(sheet("Coro"), ["Vamp"])).toEqual([null]);
    expect(sections(sheet("Pre-coro"), ["Puente"])).toEqual([null]);
  });

  it("C10: an early choice does not drag the rest, the bridge always gets its section", () => {
    // After the bridge the song plays a chorus: the closest one written before
    // where the reading stands is "Coro final" (going back to it is the
    // cheapest step back), which is also what bands play after a bridge.
    const doc = sheet("Verso 1", "Coro", "Verso 2", "Coro final", "Puente");
    expect(sections(doc, ["Verso", "Coro", "Verso", "Puente", "Coro"])).toEqual([0, 1, 2, 4, 3]);
  });

  it("C11: arrangement repeats are not matched; they use their original's link", () => {
    const result = matchChartToMarkers(sheet("Verso", "Coro"), markers("Verso", "Coro", "Coro~1"));
    expect(result.links).toEqual([
      { markerId: "Verso#1", section: 0 },
      { markerId: "Coro#1", section: 1 },
    ]);
    expect(chartLinkFor(result.links, "Coro#1~1")?.section).toBe(1);
  });

  it("C12: a link the user fixed stays, the rest stays coherent around it", () => {
    const doc = sheet("Verso 1", "Coro", "Verso 2");
    const result = matchChartToMarkers(doc, markers("Verso", "Coro", "Verso", "Coro"), {
      locked: [{ markerId: "Verso#2", section: 1 }],
    });
    expect(result.items.map((item) => item.section)).toEqual([0, 1, 1, 1]);
    expect(result.items[2]).toMatchObject({ confidence: "high", reason: "locked" });
  });

  it("C13: a marker called C is not a chorus without the source's sequence", () => {
    const doc = sheet("Verso", "Coro");
    const song: SectionMarkerSummary[] = [
      { id: "v", name: "Verso", startSeconds: 0, kind: "verse" },
      { id: "c", name: "C", startSeconds: 10, kind: "custom" },
    ];
    expect(matchChartToMarkers(doc, song).items.map((item) => item.section)).toEqual([0, null]);
  });

  it("C15: 60 markers against 40 sections in a few milliseconds", () => {
    const kinds = ["Verso", "Pre-coro", "Coro", "Puente", "Instrumental"];
    const doc = sheet(...Array.from({ length: 40 }, (_, index) => `${kinds[index % 5]} ${Math.floor(index / 5) + 1}`));
    const song = markers(...Array.from({ length: 60 }, (_, index) => kinds[index % 5]));
    matchChartToMarkers(doc, song); // warm up
    const runs = 20;
    const started = performance.now();
    for (let run = 0; run < runs; run += 1) matchChartToMarkers(doc, song);
    const perRun = (performance.now() - started) / runs;
    console.info(`matchChartToMarkers 60×40: ${perRun.toFixed(2)} ms`);
    expect(perRun).toBeLessThan(5);
  });

  it("two markers in a row stay on a section the sheet marks as repeated", () => {
    const doc = sheet("Verso 1", "Coro 1", "Verso 2", "Coro 2 (x2)", "Puente", "Coro 3");
    expect(sections(doc, ["Verso", "Coro", "Verso", "Coro", "Coro", "Puente", "Coro"])).toEqual([0, 1, 2, 3, 3, 4, 5]);
    // Without the mark, the second chorus goes back to the closest one.
    const plain = sheet("Verso 1", "Coro 1", "Verso 2", "Coro 2", "Puente", "Coro 3");
    expect(sections(plain, ["Verso", "Coro", "Verso", "Coro", "Coro", "Puente", "Coro"])).not.toEqual([0, 1, 2, 3, 3, 4, 5]);
  });

  it("a section written once and played many times is not a doubt", () => {
    const result = matchChartToMarkers(sheet("Verso", "Coro", "Puente"), markers("Verso", "Coro", "Puente", "Puente", "Puente"));
    expect(result.items.slice(2).map((item) => [item.section, item.confidence])).toEqual([
      [2, "high"],
      [2, "high"],
      [2, "high"],
    ]);
  });
});
