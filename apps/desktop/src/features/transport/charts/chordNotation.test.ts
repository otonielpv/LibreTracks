import { describe, expect, it } from "vitest";

import { isChord, isChordLineFiller, keyPrefersFlats, transposeChord } from "./chordNotation";

describe("isChord", () => {
  it.each([
    "C", "Am", "F#m7", "Bb", "Bbmaj7", "Csus4", "Dsus", "G/B", "C/E", "Am7/G",
    "Eadd9", "Cmaj9", "C°", "Bdim", "Caug", "C+", "Bø", "E7(b9)", "C2", "D-7",
    "Do", "Rem", "Fa#m7", "Sib/Re", "Sol7", "Lam", "Mi/Sol#", "(C)", "[G]", "Asus2*",
  ])("recognises %s", (token) => {
    expect(isChord(token)).toBe(true);
  });

  it.each([
    "Quien", "rompe", "amor", "Gracia", "VERSO", "Coro", "la", "mi", "Hello", "Go",
    "Cielo", "Dios", "Amen", "Hm", "", "x2", "Bridge",
  ])("does not take %s for a chord", (token) => {
    expect(isChord(token)).toBe(false);
  });

  it("lets bar lines and repeat marks sit in a chord line", () => {
    for (const filler of ["|", "||", "|:", ":|", "/", "-", "x2", "(x3)", "2x", "N.C.", "%", "..."]) {
      expect(isChordLineFiller(filler)).toBe(true);
    }
    expect(isChordLineFiller("amor")).toBe(false);
  });
});

describe("transposeChord", () => {
  it("moves root and bass and keeps the quality", () => {
    expect(transposeChord("C", 2)).toBe("D");
    expect(transposeChord("Am7/G", 2)).toBe("Bm7/A");
    expect(transposeChord("F#m", -1)).toBe("Fm");
    expect(transposeChord("Bbmaj7", 2)).toBe("Cmaj7");
    expect(transposeChord("E7(b9)", 1)).toBe("F7(b9)");
  });

  it("spells with flats when asked", () => {
    expect(transposeChord("C", 3)).toBe("D#");
    expect(transposeChord("C", 3, true)).toBe("Eb");
  });

  it("keeps Latin notation Latin", () => {
    expect(transposeChord("Do", 2)).toBe("Re");
    expect(transposeChord("Sib/Re", 2)).toBe("Do/Mi");
    expect(transposeChord("Lam7", 3)).toBe("Dom7");
  });

  it("keeps decoration and leaves non-chords alone", () => {
    expect(transposeChord("(G)", 2)).toBe("(A)");
    expect(transposeChord("x2", 2)).toBe("x2");
    expect(transposeChord("C", 0)).toBe("C");
    expect(transposeChord("C", 12)).toBe("C");
    expect(transposeChord("C", -14)).toBe("A#");
  });

  it("knows which keys are spelled with flats", () => {
    expect(keyPrefersFlats("F")).toBe(true);
    expect(keyPrefersFlats("Dm")).toBe(true);
    expect(keyPrefersFlats("G")).toBe(false);
    expect(keyPrefersFlats(null)).toBe(false);
  });
});
