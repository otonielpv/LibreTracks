import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { chordProFromText, looksLikeChordPro } from "./chartImport";
import { parseChordPro, parseLyricLine, type ChartLine, type ChartSection } from "./chordChart";
import { lyricToPlain, normalizeChartLine, plainToSectionLines, sectionToPlain, setChordAt, usedChords, usesLatinNotation, appendChord } from "./plainChart";

const here = path.dirname(fileURLToPath(import.meta.url));

const lyrics = (chordPro: string): ChartLine => ({ kind: "lyrics", segments: parseLyricLine(chordPro) });
const sectionOf = (lines: ChartLine[]): ChartSection => ({ label: "Verso", kind: "verse", number: null, lines });
const roundTrip = (lines: ChartLine[]) => plainToSectionLines(sectionToPlain(sectionOf(lines)));
const norm = (lines: ChartLine[]) => lines.map(normalizeChartLine);

/**
 * Every sheet the chart tests already use: string arrays joined with "\n" and
 * multi-line template literals in the test files of this folder and of the
 * desktop chart folder, plus the private Planning Center cases when present.
 */
function fixtureSheets(): Array<{ name: string; text: string }> {
  const sheets: Array<{ name: string; text: string }> = [];
  const folders = [here, path.resolve(here, "../../../../apps/desktop/src/features/transport/charts")];
  for (const folder of folders) {
    if (!existsSync(folder)) continue;
    for (const file of readdirSync(folder).filter((name) => name.endsWith(".test.ts") || name.endsWith(".test.tsx"))) {
      if (file === "plainChart.test.ts") continue;
      const source = readFileSync(path.join(folder, file), "utf8");
      let count = 0;
      for (const match of source.matchAll(/\[\s*((?:"(?:[^"\\\n]|\\.)*"\s*,\s*)+(?:"(?:[^"\\\n]|\\.)*"\s*,?\s*)?)\]\.join\("\\n"\)/g)) {
        const rows = [...match[1].matchAll(/"(?:[^"\\\n]|\\.)*"/g)].map((row) => JSON.parse(row[0]) as string);
        sheets.push({ name: `${file}#array${(count += 1)}`, text: rows.join("\n") });
      }
      for (const match of source.matchAll(/`((?:[^`\\$]|\$(?!\{))*)`/g)) {
        if (match[1].split("\n").length < 3 || /=>|expect\(|function |\bconst /.test(match[1])) continue;
        sheets.push({ name: `${file}#template${(count += 1)}`, text: match[1] });
      }
    }
  }
  const cases = path.resolve(here, "../../../../docs/plans/smart-chart-import/cases");
  if (existsSync(cases)) {
    for (const file of readdirSync(cases).filter((name) => name.endsWith(".json"))) {
      const sheet = (JSON.parse(readFileSync(path.join(cases, file), "utf8")) as { sheet?: string }).sheet;
      if (sheet) sheets.push({ name: `case:${file}`, text: sheet });
    }
  }
  return sheets;
}

describe("plain chart round trip over every fixture sheet", () => {
  const sheets = fixtureSheets();

  it("finds the fixture sheets", () => {
    expect(sheets.length).toBeGreaterThan(20);
  });

  it("every section of every sheet comes back the same", () => {
    const failures: string[] = [];
    let sections = 0;
    for (const sheet of sheets) {
      const docs = [parseChordPro(chordProFromText(sheet.text))];
      if (looksLikeChordPro(sheet.text)) docs.push(parseChordPro(sheet.text));
      for (const doc of docs) {
        doc.sections.forEach((chartSection, index) => {
          sections += 1;
          const back = norm(plainToSectionLines(sectionToPlain(chartSection)));
          const expected = norm(chartSection.lines);
          if (JSON.stringify(back) !== JSON.stringify(expected)) {
            const at = expected.findIndex((line, row) => line !== back[row]);
            failures.push(`${sheet.name} section ${index} "${chartSection.label}" | want ${expected[at] ?? "(end)"} | got ${back[at] ?? "(end)"}`);
          }
        });
      }
    }
    expect(sections).toBeGreaterThan(100);
    expect(failures).toEqual([]);
  });
});

describe("plain chart: hard cases", () => {
  const cases: Array<[string, string[]]> = [
    ["long chord over a short syllable", ["[Gsus4]a[C]mor de [D]Dios"]],
    ["long chord at the end of a word", ["[Gsus4]Santo [C]es"]],
    ["two chords in a row with no lyric between", ["Santo [G][D]es el Se[Em]ñor"]],
    ["chord at the end of the line", ["Santo es el Señor[C]"]],
    ["chords with bass", ["[G/B]Cantan las [C/E]piedras [D/F#]hoy"]],
    ["latin notation", ["[Sol]Santo es el [Re/Fa#]Señor [Mim7]hoy"]],
    ["lyric that looks like chords", ["A mi Dios", "[G]A mi Dios le [D]canto"]],
    ["do re mi as lyrics", ["Do re mi fa sol la"]],
    ["chords only", ["[G] [D] [Em] [C]"]],
    ["lyrics only", ["Santo es el Señor", "Digno de honor"]],
    ["chords only then lyrics only", ["[G] [D]", "Santo es el Señor"]],
  ];
  for (const [name, rows] of cases) {
    it(name, () => {
      const lines = rows.map(lyrics);
      expect(norm(roundTrip(lines))).toEqual(norm(lines));
    });
  }

  it("tablature and comments come back", () => {
    const lines: ChartLine[] = [
      { kind: "comment", text: "Más suave" },
      { kind: "tab", text: "e|--3--5--|" },
      { kind: "tab", text: "B|--------|" },
      lyrics("[G]Santo es el [D]Señor"),
    ];
    expect(roundTrip(lines)).toEqual(lines);
  });

  it("pads a long chord inside a word with _ and between words with spaces", () => {
    expect(lyricToPlain(parseLyricLine("[Gsus4]a[C]mor"))).toEqual({ chords: "Gsus4 C", lyric: "a_____mor" });
    expect(lyricToPlain(parseLyricLine("[Gsus4]Ven [C]ya"))).toEqual({ chords: "Gsus4 C", lyric: "Ven   ya" });
  });

  it("a header typed inside a part does not lose its lines", () => {
    expect(norm(plainToSectionLines("CORO\nG       D\nSanto es el Señor"))).toEqual(norm([lyrics("[G]Santo es [D]el Señor")]));
  });

  it("blank lines are ignored", () => {
    expect(plainToSectionLines("Santo\n\n\nDigno")).toEqual([lyrics("Santo"), lyrics("Digno")]);
  });
});

describe("plain chart: ChordPro in the box", () => {
  it("reads brackets as ChordPro", () => {
    const text = "[G]Santo es el [D]Señor\n[Em]Digno de [C]honor";
    expect(plainToSectionLines(text)).toEqual(parseChordPro(text).sections.flatMap((chartSection) => chartSection.lines));
  });

  it("reads a single bracketed line too", () => {
    expect(plainToSectionLines("[G]Santo es el [D]Señor")).toEqual([lyrics("[G]Santo es el [D]Señor")]);
  });
});

describe("plain chart: columns", () => {
  it("each chord sits over the first character of its run", () => {
    for (const source of ["[G]Santo es el [D]Señor", "[Gsus4]a[C]mor de [D/F#]Dios", "Ven [Am7]ya, [G][D]Señor"]) {
      const segments = parseLyricLine(source);
      const { chords, lyric } = lyricToPlain(segments);
      const columns = [...(chords ?? "").matchAll(/\S+/g)].map((match) => match.index ?? 0);
      const withChord = segments.filter((segment) => segment.chord);
      expect(columns).toHaveLength(withChord.length);
      withChord.forEach((segment, index) => {
        if (segment.text) expect(lyric.slice(columns[index]).startsWith(segment.text)).toBe(true);
      });
    }
  });
});

describe("chord picker operations", () => {
  it("putting, changing and taking off a chord gives the line typed by hand", () => {
    const line = parseLyricLine("Santo es el Señor");
    const put = setChordAt(line, 0, "G");
    expect(put).toEqual(plainToSectionLines("G\nSanto es el Señor")[0]);
    const second = setChordAt(put.kind === "lyrics" ? put.segments : [], 12, "D");
    expect(second).toEqual(plainToSectionLines("G           D\nSanto es el Señor")[0]);
    const changed = setChordAt(second.kind === "lyrics" ? second.segments : [], 12, "Em");
    expect(changed).toEqual(plainToSectionLines("G           Em\nSanto es el Señor")[0]);
    const off = setChordAt(changed.kind === "lyrics" ? changed.segments : [], 0, null);
    expect(off).toEqual(plainToSectionLines("            Em\nSanto es el Señor")[0]);
  });

  it("offers the chords already used, most used first, and tells the notation", () => {
    const lines = [lyrics("[Sol]Santo [Re]es [Sol]el"), lyrics("[Mim]Señor")];
    expect(usedChords(lines)).toEqual(["Sol", "Re", "Mim"]);
    expect(usesLatinNotation(lines)).toBe(true);
    expect(usesLatinNotation([lyrics("[G]Santo")])).toBe(false);
  });
});

describe("appendChord", () => {
  it("adds chords one after another like a typed chord line", () => {
    let line = appendChord([], "C");
    line = appendChord(line.kind === "lyrics" ? line.segments : [], "G");
    line = appendChord(line.kind === "lyrics" ? line.segments : [], "Am");
    expect(normalizeChartLine(line)).toBe(normalizeChartLine(plainToSectionLines("C  G  Am")[0]));
  });
});
