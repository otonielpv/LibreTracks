import { describe, expect, it } from "vitest";

import amazingGrace from "../../../../crates/libretracks-pco/tests/fixtures/arrangement_amazing_grace.json";
import cantaMiAlma from "../../../../crates/libretracks-pco/tests/fixtures/arrangement_canta_mi_alma.json";
import holyLyricsOnly from "../../../../crates/libretracks-pco/tests/fixtures/arrangement_holy_lyrics_only.json";
import holyWithChords from "../../../../crates/libretracks-pco/tests/fixtures/arrangement_holy_with_chords.json";
import pruebaUno from "../../../../crates/libretracks-pco/tests/fixtures/arrangement_prueba_uno.json";
import richChart from "../../../../crates/libretracks-pco/tests/fixtures/arrangement_rich_chart.json";
import testSongTwo from "../../../../crates/libretracks-pco/tests/fixtures/arrangement_test_song_two.json";
import testSongTwoAcoustic from "../../../../crates/libretracks-pco/tests/fixtures/arrangement_test_song_two_acoustic.json";
import planItems from "../../../../crates/libretracks-pco/tests/fixtures/plan_items.json";

import { parseChordPro } from "./chordChart";
import {
  ChartImportError,
  chartTextHash,
  normalizeImportedChart,
  planningCenterToImported,
  type ImportedChart,
  type PcoArrangement,
  type PcoPlanItem,
} from "./importedChart";

/** A recorded JSON:API arrangement as `libretracks-pco` hands it over
 * (the Rust client does this same mapping). */
type Recorded = { data: { id: string; attributes: Record<string, unknown>; relationships?: Record<string, { data?: { id?: string } | null }> } };
function arrangement(recorded: Recorded, songTitle = "Song"): PcoArrangement {
  const attributes = recorded.data.attributes;
  return {
    id: recorded.data.id,
    songId: recorded.data.relationships?.song?.data?.id ?? "song",
    songTitle,
    name: attributes.name as string,
    chordChart: attributes.chord_chart as string | null,
    chordChartKey: attributes.chord_chart_key as string | null,
    lyrics: attributes.lyrics as string | null,
    sequence: attributes.sequence as string[] | null,
    sequenceFull: attributes.sequence_full as PcoArrangement["sequenceFull"],
    bpm: attributes.bpm as number | null,
    meter: attributes.meter as string | null,
    updatedAt: attributes.updated_at as string | null,
  };
}

function planItem(title: string): PcoPlanItem {
  const item = planItems.data.find((entry) => entry.attributes.title?.startsWith(title));
  if (!item) throw new Error(title);
  return {
    id: item.id,
    title: item.attributes.title,
    keyName: (item.attributes as { key_name?: string | null }).key_name ?? null,
    customArrangementSequenceFull: item.attributes.custom_arrangement_sequence_full as PcoPlanItem["customArrangementSequenceFull"],
  };
}

const chart = (text: string, sequence?: string[]): ImportedChart => ({ title: "T", text, sequence });
const labels = (text: string) => parseChordPro(text).sections.map((section) => section.label);

describe("cleaning an imported chart (D9)", () => {
  it("C1: an empty header of a part already written is a reference", () => {
    const result = normalizeImportedChart(
      chart(["CORO", "Eres mi luz", "", "VERSO 2", "Otra letra", "", "CORO", "", "PUENTE", "Sobre el agua"].join("\n")),
    );
    expect(labels(result.text)).toEqual(["Coro", "Verso 2", "Puente"]);
    expect(result.sequence).toEqual(["Coro", "Verso 2", "Coro", "Puente"]);
  });

  it("C1: a repeat instruction line is a reference too, with its count", () => {
    const result = normalizeImportedChart(
      chart(["CORO", "Eres mi luz", "PUENTE", "Sobre el agua", "(Repetir coro)", "FINAL", "[C]"].join("\n")),
    );
    expect(labels(result.text)).toEqual(["Coro", "Puente", "Final"]);
    expect(result.sequence).toEqual(["Coro", "Puente", "Coro", "Final"]);
    const twice = normalizeImportedChart(chart(["CHORUS", "Sing", "BRIDGE", "Up", "(Repeat Chorus x2)"].join("\n")));
    expect(twice.sequence).toEqual(["Chorus", "Bridge", "Chorus", "Chorus"]);
  });

  it("C1: a 'Coro x2' header with words is a section, not a reference", () => {
    const result = normalizeImportedChart(chart(["VERSO", "Uno", "CORO x2", "Eres mi luz"].join("\n")));
    expect(labels(result.text)).toEqual(["Verso", "CORO x2"]);
    expect(result.sequence).toBeUndefined();
  });

  it("C2: two identical choruses are one; a final chorus that changes a line is kept", () => {
    const same = normalizeImportedChart(chart(["CORO", "Eres mi luz", "VERSO", "Uno", "CORO", "Eres mi luz"].join("\n")));
    expect(labels(same.text)).toEqual(["Coro", "Verso"]);
    expect(same.sequence).toEqual(["Coro", "Verso", "Coro"]);
    const different = normalizeImportedChart(chart(["CORO", "Eres mi luz", "VERSO", "Uno", "CORO", "Eres mi sol"].join("\n")));
    expect(labels(different.text)).toEqual(["Coro", "Verso", "Coro"]);
    expect(different.sequence).toBeUndefined();
  });

  it("keeps the source's own sequence over the implicit one", () => {
    const result = normalizeImportedChart(chart(["CORO", "Luz", "VERSO", "Uno", "CORO"].join("\n"), ["Verso 1", "Coro 1"]));
    expect(result.sequence).toEqual(["Verso 1", "Coro 1"]);
  });
});

describe("Planning Center arrangements (recorded fixtures)", () => {
  it("C3: ChordPro with [G] chords and wordless parts", () => {
    const imported = planningCenterToImported(arrangement(amazingGrace, "Amazing Grace"));
    expect(imported).toMatchObject({ title: "Amazing Grace", key: "G", meter: "3/4" });
    expect(imported.sequence).toEqual(["Intro 1", "Verse 1", "Verse 2", "Instrumental 1", "Verse 3", "Ending 1"]);
    expect(imported.source).toMatchObject({ provider: "planningCenter", arrangementId: amazingGrace.data.id });
    const doc = parseChordPro(normalizeImportedChart(imported).text);
    expect(doc.sections.map((section) => section.kind)).toEqual(["intro", "verse", "verse", "instrumental", "verse", "ending"]);
  });

  it("C3: chords over the lyrics, Spanish headers", () => {
    const doc = parseChordPro(normalizeImportedChart(planningCenterToImported(arrangement(pruebaUno))).text);
    expect(doc.sections.map((section) => [section.kind, section.number])).toEqual([
      ["intro", null], ["verse", 1], ["pre_chorus", null], ["chorus", null], ["verse", 2], ["bridge", null],
    ]);
    const firstVerse = doc.sections[1].lines[0];
    expect(firstVerse.kind === "lyrics" && firstVerse.segments.some((segment) => segment.chord === "D")).toBe(true);
  });

  it("C3: lyrics only, no chords", () => {
    const doc = parseChordPro(normalizeImportedChart(planningCenterToImported(arrangement(holyLyricsOnly))).text);
    expect(doc.sections.map((section) => section.kind)).toEqual(["verse", "verse", "verse"]);
    expect(doc.sections.every((section) => section.lines.every((line) => line.kind !== "lyrics" || line.segments.every((segment) => !segment.chord)))).toBe(true);
  });

  it("C3: no text at all is noText", () => {
    const empty = { ...arrangement(amazingGrace), chordChart: "", lyrics: null };
    expect(() => planningCenterToImported(empty)).toThrowError(ChartImportError);
    try {
      planningCenterToImported(empty);
    } catch (error) {
      expect((error as ChartImportError).code).toBe("noText");
    }
  });

  it("C3: only lyrics when there is no chord chart", () => {
    const lyricsOnly = { ...arrangement(holyLyricsOnly), chordChart: null };
    expect(parseChordPro(planningCenterToImported(lyricsOnly).text).sections.length).toBe(3);
  });

  it("C3: the plan item's sequence and key win over the arrangement's", () => {
    const acoustic = planningCenterToImported(arrangement(testSongTwoAcoustic), planItem("Test Song Two"));
    expect(acoustic.sequence).toEqual(["Verse 1", "Chorus 1", "Verse 2", "Chorus 1", "Chorus 1"]);
    expect(acoustic.source?.planItemId).toBe(planItem("Test Song Two").id);
    const withKey = planningCenterToImported(arrangement(pruebaUno), planItem("Canci"));
    expect(withKey.key).toBe("E");
    expect(planningCenterToImported(arrangement(pruebaUno)).key).toBe("D");
  });

  it("C3: Rich Chart Test, directives are not lyrics and layout marks go", () => {
    const text = normalizeImportedChart(planningCenterToImported(arrangement(richChart))).text;
    expect(text).not.toMatch(/COLUMN_BREAK|PAGE_BREAK/);
    const doc = parseChordPro(text);
    const lyricText = doc.sections.flatMap((section) =>
      section.lines.flatMap((line) => (line.kind === "lyrics" ? [line.segments.map((segment) => segment.text).join("")] : [])),
    );
    expect(lyricText.some((line) => /title:|c:|comment:|\{soc\}|\{eoc\}/i.test(line))).toBe(false);
    expect(doc.title).toBe("Rich Chart Test");
    const comments = doc.sections.flatMap((section) => section.lines.filter((line) => line.kind === "comment"));
    expect(comments.map((line) => line.kind === "comment" && line.text)).toContain("Hombres");
  });

  it("C3: Canta Mi Alma, Latin chords are chords and the empty ESTRIBILLO (x2) is a reference", () => {
    const imported = planningCenterToImported(arrangement(cantaMiAlma));
    const doc = parseChordPro(normalizeImportedChart({ ...imported, sequence: undefined }).text);
    const chords = doc.sections.flatMap((section) =>
      section.lines.flatMap((line) => (line.kind === "lyrics" ? line.segments.flatMap((segment) => (segment.chord ? [segment.chord] : [])) : [])),
    );
    expect(chords).toEqual(expect.arrayContaining(["Do", "Sol/Si"]));
    const choruses = doc.sections.filter((section) => section.kind === "chorus");
    expect(choruses).toHaveLength(1);
    const implicit = normalizeImportedChart({ ...imported, sequence: undefined }).sequence ?? [];
    expect(implicit.filter((label) => label === choruses[0].label).length).toBeGreaterThanOrEqual(3);
  });

  it("C4: every header of every fixture is a section the vocabulary knows", () => {
    for (const recorded of [amazingGrace, pruebaUno, holyLyricsOnly, testSongTwo, testSongTwoAcoustic, richChart, cantaMiAlma, holyWithChords]) {
      const doc = parseChordPro(normalizeImportedChart(planningCenterToImported(arrangement(recorded as Recorded))).text);
      const labelled = doc.sections.filter((section) => section.label);
      expect(labelled.length).toBeGreaterThan(0);
      for (const section of labelled) expect([section.label, section.kind]).not.toEqual([section.label, null]);
    }
  });

  it("Test Song Two: the empty CHORUS and the repeat line become the implicit sequence", () => {
    const imported = planningCenterToImported(arrangement(testSongTwo));
    const result = normalizeImportedChart({ ...imported, sequence: undefined });
    expect(labels(result.text)).toEqual(["Verse 1", "Chorus", "Verse 2", "Bridge", "Tag"]);
    expect(result.sequence).toEqual(["Verse 1", "Chorus", "Verse 2", "Chorus", "Bridge", "Chorus", "Chorus", "Tag"]);
  });
});

describe("the fingerprint of a saved chart", () => {
  it("is stable, ignores line endings and changes with the text", () => {
    expect(chartTextHash("a\r\nb")).toBe(chartTextHash("a\nb"));
    expect(chartTextHash("Coro")).toBe(chartTextHash("Coro"));
    expect(chartTextHash("Coro")).not.toBe(chartTextHash("Coro!"));
  });
});

describe("Planning Center repeat marks", () => {
  // Invented words, with the shape of a real Planning Center chart.
  const SHEET = [
    "INTRO  E  C#m  A   B",
    "",
    "VERSO 1",
    "[E]Camino al a[B]manecer",
    "[E]Luz en el [C#m]valle",
    "",
    "CORO 1",
    "Te [E]canto hoy",
    "porque [C#m]tú me esperas",
    "",
    "COLUMN_BREAK",
    "CORO 2",
    "// Te [E]canto hoy",
    "porque [C#m]tú me esperas //",
    "",
    "PUENTE",
    "/// Ahora [E]vuelvo   Ahora [C#m]canto",
    "Y tu ca[B]mino es mi [A]casa ///",
    "",
    "Ahora [C#m]vuelvo   Ahora [G#m]canto",
    "Y tu ca[B]mino es mi [A]casa [B]",
    "",
    "CORO 3",
    "// Te [E]canto hoy",
    "porque [C#m]tú me esperas // [E]",
  ].join("\n");

  const doc = () => parseChordPro(normalizeImportedChart(chart(SHEET)).text);
  const words = (line: ReturnType<typeof doc>["sections"][number]["lines"][number]) =>
    line.kind === "lyrics" ? line.segments.map((segment) => segment.text).join("") : "";

  it("the slashes go and nothing is written in their place", () => {
    const sections = doc().sections;
    expect(sections.map((section) => section.label)).toEqual(["Intro", "Verso 1", "Coro 1", "Coro 2", "Puente", "Coro 3"]);
    expect(sections[3].lines.map(words)).toEqual(["Te canto hoy", "porque tú me esperas"]);
    expect(sections[4].lines.map(words)).toEqual([
      "Ahora vuelvo   Ahora canto",
      "Y tu camino es mi casa",
      "Ahora vuelvo   Ahora canto",
      "Y tu camino es mi casa ",
    ]);
  });

  it("reports how many times a whole section is played, for the matcher only", () => {
    // A partial block (the bridge) is not the whole section.
    expect(normalizeImportedChart(chart(SHEET)).repeats).toEqual([1, 1, 1, 2, 1, 2]);
  });

  it("a header with its chords on the same line keeps the chords as a line", () => {
    const intro = doc().sections[0];
    expect(intro.kind).toBe("intro");
    expect(intro.lines[0].kind === "lyrics" && intro.lines[0].segments.map((segment) => segment.chord)).toEqual(["E", "C#m", "A", "B"]);
  });

  it("a header ending in slashes keeps its name and reports its count", () => {
    const result = normalizeImportedChart(chart("INTRO //\n[Am] [C]\nVERSO\nUno"));
    expect(parseChordPro(result.text).sections[0].label).toBe("Intro");
    expect(result.repeats).toEqual([2, 1]);
  });
});

describe("what the cleanup reports", () => {
  it("lists each change so nothing changes unseen", () => {
    const text = [
      "INTRO  E  C#m",
      "VERSO",
      "[E]Uno",
      "CORO",
      "// [E]Luz //",
      "COLUMN_BREAK",
      "CORO",
      "",
      "PUENTE",
      "[A]Dos",
      "(Repetir coro)",
    ].join("\n");
    expect(normalizeImportedChart(chart(text)).changes).toEqual([
      { kind: "layout", count: 1 },
      { kind: "headerChords", label: "Intro" },
      { kind: "repeatMarks", label: "Coro" },
      { kind: "reference", label: "Coro" },
      { kind: "repeatLine", label: "(Repetir coro)" },
    ]);
    expect(normalizeImportedChart(chart(["VERSO", "[G]Uno"].join("\n"))).changes).toEqual([]);
  });
});
