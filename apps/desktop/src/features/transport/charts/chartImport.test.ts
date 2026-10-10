import { describe, expect, it } from "vitest";

import { analyzeSongSheet, chordProFromText, looksLikeChordPro, textToSourceLines } from "./chartImport";
import { parseChordPro, parseSectionHeader, serializeChordPro, transposeChart } from "@libretracks/shared/charts/chordChart";

const sheet = (text: string) => analyzeSongSheet(textToSourceLines(text));
const firstLine = (text: string, section = 0) => {
  const line = sheet(text).sections[section].lines[0];
  return line.kind === "lyrics" ? line.segments : [];
};

describe("section headers", () => {
  it.each([
    ["VERSO 1", "verse", 1],
    ["Verse 2:", "verse", 2],
    ["[Chorus]", "chorus", null],
    ["(Coro x2)", "chorus", null],
    ["Pre-Coro", "pre_chorus", null],
    ["PRE CHORUS 2", "pre_chorus", 2],
    ["Puente", "bridge", null],
    ["Estribillo:", "chorus", null],
    ["Verse II", "verse", 2],
    ["INSTRUMENTAL", "instrumental", null],
    ["Intro", "intro", null],
    ["Acorde final", "ending", null],
    ["Outro", "outro", null],
  ] as const)("%s is a %s header", (text, kind, number) => {
    expect(parseSectionHeader(text)).toMatchObject({ kind, number });
  });

  it.each(["Solo tú eres digno", "Coro de ángeles canta", "Final de la historia", "Intro to love"])(
    "lyrics that start with a section word are not headers: %s",
    (text) => {
      expect(parseSectionHeader(text)).toBeNull();
    },
  );
});

describe("chords over lyrics in plain text", () => {
  const english = [
    "Morning Light",
    "Some Band",
    "",
    "Verse 1:",
    "G          D/F#       Em",
    "Here in the morning light",
    "     C            G",
    "We lift our voices high",
    "",
    "Chorus",
    "C    G    D",
    "Holy, holy, holy",
    "",
    "CCLI Song # 1234567",
  ].join("\n");

  it("finds title, artist, sections and drops the licence line", () => {
    const doc = sheet(english);
    expect(doc.title).toBe("Morning Light");
    expect(doc.artist).toBe("Some Band");
    expect(doc.sections.map((s) => [s.label, s.kind, s.number])).toEqual([
      ["Verse 1", "verse", 1],
      ["Chorus", "chorus", null],
    ]);
    expect(serializeChordPro(doc)).not.toContain("CCLI");
  });

  it("puts each chord on the syllable under it", () => {
    expect(firstLine(english)).toEqual([
      { chord: "G", text: "Here in the " },
      { chord: "D/F#", text: "morning " },
      { chord: "Em", text: "light" },
    ]);
    const second = sheet(english).sections[0].lines[1];
    expect(second.kind === "lyrics" && second.segments).toEqual([
      { chord: null, text: "We " },
      { chord: "C", text: "lift our voices " },
      { chord: "G", text: "high" },
    ]);
  });

  it("reads Spanish sheets with Latin chords and bracketed headers", () => {
    const spanish = ["[Coro]", "Do          Sol/Si", "Santo es el Señor", "Fa", "Aleluya"].join("\n");
    const doc = sheet(spanish);
    expect(doc.sections[0]).toMatchObject({ label: "Coro", kind: "chorus" });
    expect(firstLine(spanish)[0]).toEqual({ chord: "Do", text: "Santo es el " });
    expect(firstLine(spanish).map((s) => s.chord)).toEqual(["Do", "Sol/Si"]);
  });

  it("keeps the chords of a header line and lines of chords alone", () => {
    const doc = sheet(["INTRO: C | F | C | F", "", "VERSO", "Am   G", "", "Letra sin acordes"].join("\n"));
    const intro = doc.sections[0];
    expect(intro.label).toBe("Intro");
    expect(intro.lines[0].kind === "lyrics" && intro.lines[0].segments.map((s) => s.chord)).toEqual(["C", "F", "C", "F"]);
    // A chord line followed by a blank is not glued to the lyric after it.
    const verse = doc.sections[1].lines;
    expect(verse).toHaveLength(2);
    expect(verse[1]).toEqual({ kind: "lyrics", segments: [{ chord: null, text: "Letra sin acordes" }] });
  });

  it("reads lyrics with no chords and no headers at all", () => {
    const doc = sheet("Primera línea\nSegunda línea");
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0].lines).toHaveLength(2);
  });

  it("aligns chords written with tabs", () => {
    expect(firstLine("C\tF\nUno dos tres cuatro nueve")[1]).toEqual({ chord: "F", text: "tres cuatro nueve" });
  });
});

describe("ChordPro", () => {
  it("is recognised and kept as written", () => {
    const text = "{title: Song}\n{key: G}\n{start_of_chorus}\n[G]Holy [C]holy\n{end_of_chorus}";
    expect(looksLikeChordPro(text)).toBe(true);
    const doc = parseChordPro(chordProFromText(text));
    expect(doc).toMatchObject({ title: "Song", key: "G" });
    expect(doc.sections[0]).toMatchObject({ label: "Chorus", kind: "chorus" });
  });

  it("takes {c: Verse 1} as a section, the way many apps write it", () => {
    const doc = parseChordPro("{c: Verse 1}\n[D]One\n{c: play softly}\n[A]Two");
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0].lines[1]).toEqual({ kind: "comment", text: "play softly" });
  });

  it("round-trips", () => {
    const doc = sheet("Title Song\n\nVerse 1\nG    C\nOne two three\nBridge\nEm\nFour");
    expect(parseChordPro(serializeChordPro(doc))).toEqual(doc);
  });

  it("keeps tab blocks through a save and load, untransposed", () => {
    const doc = parseChordPro("{section: Solo}\n{start_of_tab}\nE--3--\nB--5--\n{end_of_tab}\n[C]fin");
    expect(doc.sections[0].lines.map((line) => line.kind)).toEqual(["tab", "tab", "lyrics"]);
    expect(parseChordPro(serializeChordPro(doc))).toEqual(doc);
    expect(transposeChart(doc, 2).sections[0].lines[0]).toEqual({ kind: "tab", text: "E--3--" });
  });

  it("transposes every chord and the key", () => {
    const doc = transposeChart(parseChordPro("{key: C}\n[C]Uno [G/B]dos"), 2);
    expect(doc.key).toBe("D");
    const line = doc.sections[0].lines[0];
    expect(line.kind === "lyrics" && line.segments.map((s) => s.chord)).toEqual(["D", "A/C#"]);
  });
});

describe("sheets from the web", () => {
  it("splits a header with a note, and starts the unlabelled verse after the intro", () => {
    const doc = sheet(
      [
        "INTRO; SON NOTAS PARA TOCAR:",
        "B - B - C# - D",
        "DC#-A-DC#-A//B",
        "",
        "Bm        G",
        "Una línea de la estrofa",
        "Coro:",
        "D         A",
        "Otra línea del coro",
      ].join("\n"),
    );
    expect(doc.sections.map((section) => [section.label, section.kind])).toEqual([
      ["Intro", "intro"],
      ["Verso", "verse"],
      ["Coro", "chorus"],
    ]);
    expect(doc.sections[0].lines).toEqual([
      { kind: "comment", text: "Son notas para tocar" },
      { kind: "lyrics", segments: [
        { chord: "B", text: " " }, { chord: "B", text: " " }, { chord: "C#", text: " " }, { chord: "D", text: "" },
      ] },
      { kind: "tab", text: "DC#-A-DC#-A//B" },
    ]);
  });

  it("keeps guitar tablature verbatim and does not take it for lyrics", () => {
    const doc = sheet(["SOLO:", "E-----------------", "D-14/16-16-14-12--", "G----12-12--------"].join("\n"));
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0].lines.map((line) => line.kind)).toEqual(["tab", "tab", "tab"]);
  });

  it("does not split a labelled verse that opens with a line of chords", () => {
    const doc = sheet(["VERSO", "Am   G", "", "Letra"].join("\n"));
    expect(doc.sections).toHaveLength(1);
  });

  it("places a chord on the character it is drawn over, despite float drift", () => {
    // 4.12 pt per character; the chord sits a hundredth to the right of "a".
    const doc = analyzeSongSheet([
      { fragments: [{ text: "G", x: 131.227, width: 4.12 }], size: 7, breakBefore: true },
      { fragments: [{ text: "de mi adoración", x: 110.607, width: 61.8 }], size: 7, breakBefore: false },
    ]);
    const line = doc.sections[0].lines[0];
    expect(line.kind === "lyrics" && line.segments).toEqual([
      { chord: null, text: "de mi " },
      { chord: "G", text: "adoración" },
    ]);
  });

  it("drops a web page's icons, e-mail and a trailing page of notes", () => {
    const page = (n: number, text: string, size = 7) => ({
      fragments: [{ text, x: 36, width: text.length * 4 }],
      size,
      page: n,
      breakBefore: false,
    });
    const doc = analyzeSongSheet([
      page(0, "×", 10),
      page(0, "Mi Canción", 13),
      page(0, "Mi Banda", 9),
      page(0, "Coro:"),
      page(0, "D        A"),
      page(0, "Letra del coro"),
      page(1, "MI GRUPO FAVORITO #1"),
      page(1, "alguien@example.com"),
      page(1, "cualquier error me avisan"),
    ]);
    expect(doc).toMatchObject({ title: "Mi Canción", artist: "Mi Banda" });
    const text = serializeChordPro(doc);
    expect(text).not.toMatch(/×|example|avisan|FAVORITO/);
  });
});
