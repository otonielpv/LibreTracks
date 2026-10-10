import { describe, expect, it } from "vitest";

import { parseChordPro, transposeChart } from "./chordChart";
import {
  chordPrefsFor,
  clampChordPrefs,
  EMPTY_PERSONAL_CHORD_STORE,
  parsePersonalChordStore,
  personalChordShift,
  personalPrefersFlats,
  withChordPrefs,
} from "./personalChords";

function chordsOf(source: string, semitones: number, flats: boolean) {
  const doc = transposeChart(parseChordPro(source), semitones, flats);
  return doc.sections.flatMap((section) =>
    section.lines.flatMap((line) =>
      line.kind === "lyrics" ? line.segments.map((segment) => segment.chord).filter(Boolean) : [],
    ),
  );
}

describe("personal chords", () => {
  it("capo 2 on a song in D shows C shapes", () => {
    const shift = personalChordShift({ capo: 2, transpose: 0 });
    expect(shift).toBe(-2);
    expect(chordsOf("[D]Hola [G]que [A]tal [Bm]bien", shift, false)).toEqual([
      "C",
      "F",
      "G",
      "Am",
    ]);
  });

  it("own transpose +2 and capo 2 cancel out", () => {
    expect(personalChordShift({ capo: 2, transpose: 2 })).toBe(0);
  });

  it("slash chords move both notes", () => {
    expect(chordsOf("[D/F#]x", personalChordShift({ capo: 2, transpose: 0 }), false)).toEqual([
      "C/E",
    ]);
  });

  it("chords it does not recognise stay as written", () => {
    expect(chordsOf("[N.C.]x [Dsus4]y", -2, false)).toEqual(["N.C.", "Csus4"]);
  });

  it("auto spelling follows the key the musician reads in", () => {
    // Song in D, capo 1 → reads in C#/Db: Db major prefers flats.
    expect(personalPrefersFlats("D", -1, "auto")).toBe(true);
    // Song in F (flat key) with no shift stays flat.
    expect(personalPrefersFlats("F", 0, "auto")).toBe(true);
    // Song in G, capo 5 → reads in D: sharps.
    expect(personalPrefersFlats("G", -5, "auto")).toBe(false);
  });

  it("explicit preference wins over the key", () => {
    expect(personalPrefersFlats("G", 0, "flats")).toBe(true);
    expect(personalPrefersFlats("F", 0, "sharps")).toBe(false);
  });

  it("values are clamped to a capo of 0-7 and ±11 semitones", () => {
    expect(clampChordPrefs({ capo: 12, transpose: -30 })).toEqual({ capo: 7, transpose: -11 });
    expect(clampChordPrefs({ capo: -1, transpose: Number.NaN })).toEqual({ capo: 0, transpose: 0 });
  });

  it("prefs are kept per song and a neutral entry is dropped", () => {
    let store = withChordPrefs(EMPTY_PERSONAL_CHORD_STORE, "song-1", { capo: 2, transpose: 0 });
    expect(chordPrefsFor(store, "song-1")).toEqual({ capo: 2, transpose: 0 });
    expect(chordPrefsFor(store, "song-2")).toEqual({ capo: 0, transpose: 0 });
    store = withChordPrefs(store, "song-1", { capo: 0, transpose: 0 });
    expect(store.bySong).toEqual({});
  });

  it("stored data survives a round trip and garbage is ignored", () => {
    const store = withChordPrefs(
      { ...EMPTY_PERSONAL_CHORD_STORE, accidentals: "flats" },
      "s",
      { capo: 3, transpose: -1 },
    );
    expect(parsePersonalChordStore(JSON.stringify(store))).toEqual(store);
    expect(parsePersonalChordStore("{nope")).toEqual(EMPTY_PERSONAL_CHORD_STORE);
    expect(parsePersonalChordStore(JSON.stringify({ accidentals: "x", bySong: { a: { capo: 99 } } }))).toEqual({
      accidentals: "auto",
      bySong: { a: { capo: 7, transpose: 0 } },
    });
  });
});
