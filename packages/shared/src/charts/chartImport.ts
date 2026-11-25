import {
  parseChordPro,
  parseLyricLine,
  parseSectionHeader,
  serializeChordPro,
  type ChartDoc,
  type ChartLine,
  type ChartSection,
  type ChartSegment,
} from "./chordChart";
import type { MarkerKind } from "../models";

import { isChord, isChordLineFiller } from "./chordNotation";

/**
 * Turns a song sheet into a chart, whatever it came from.
 *
 * Every source is first reduced to the same thing — lines of text fragments
 * with a horizontal position — and one analyser does the rest:
 *   - a PDF gives fragments with x in points (see `pdfTextLines.ts`);
 *   - a text file or pasted text gives one fragment per line, x in characters.
 *
 * The analyser knows what a song sheet looks like, not what one particular
 * program prints: section headers in Spanish or English with any decoration,
 * chord lines in either notation, chords placed over the syllable they fall
 * on, lines of inline ChordPro, and the clutter around them (CCLI, copyright,
 * page numbers).
 */

export type SourceFragment = {
  text: string;
  /** Left edge, in the line's unit (points or characters). */
  x: number;
  /** Width in the same unit. */
  width: number;
};

export type SourceLine = {
  fragments: SourceFragment[];
  /** Page it came from (PDF); text sources are one page. */
  page?: number;
  /** Font size; the title is usually the biggest text on the first page. */
  size: number;
  /** A vertical gap above this line (a blank line in text). */
  breakBefore: boolean;
};

/** Per-character left offsets of `text` rendered `width` wide. The PDF layer
 * measures real glyphs; without a measurer characters are equally wide, which
 * is exact for text files and close enough for most fonts. */
export type MeasureText = (text: string, width: number) => number[];

const uniformMeasure: MeasureText = (text, width) => {
  const step = text.length > 0 ? width / text.length : 0;
  return Array.from({ length: text.length }, (_, index) => index * step);
};

/**
 * Planning Center shows chord lines in a proportional font, where a space is
 * about half as wide as a letter: chords typed over the words there sit, in
 * plain columns, far to the right of them ("                             G"
 * over a 28-letter line). Measuring both lines this way puts each chord back
 * over the syllable Planning Center draws it on. Offsets in letter widths,
 * the same for every line.
 */
export const proportionalMeasure: MeasureText = (text) => {
  const offsets: number[] = [];
  let x = 0;
  for (let index = 0; index < text.length; index += 1) {
    offsets.push(x);
    x += text[index] === " " ? 0.55 : 1;
  }
  return offsets;
};

const META_RE =
  /\bccli\b|©|\(c\)\s*\d{4}|copyright|derechos reservados|all rights reserved|www\.|https?:\/\/|[\w.+-]+@[\w-]+\.[\w.]+|\bprohib|uso (?:exclusivo|privado|personal)|fines comerciales|personal use only|educational purposes|^\s*(?:page|p[aá]gina|p[aá]g\.?)\s*\d+|^\s*\d+\s*(?:\/|of|de)\s*\d+\s*$|^\s*\d{1,3}\s*$|^\s*-\s*\d+\s*-\s*$/i;
const KEY_RE = /^\s*(?:key|tono|tonalidad|clave)\s*[:=-]\s*([A-G](?:#|b)?m?|(?:Do|Re|Mi|Fa|Sol|La|Si)(?:#|b)?m?)\b/i;

function lineText(line: SourceLine): string {
  return line.fragments
    .map((fragment) => fragment.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

type Word = { text: string; x: number };

/** The words of a line with their x, splitting fragments at whitespace. */
function words(line: SourceLine, measure: MeasureText): Word[] {
  const out: Word[] = [];
  for (const fragment of line.fragments) {
    const offsets = measure(fragment.text, fragment.width);
    const pattern = /\S+/g;
    for (let match = pattern.exec(fragment.text); match; match = pattern.exec(fragment.text)) {
      out.push({ text: match[0], x: fragment.x + (offsets[match.index] ?? 0) });
    }
  }
  return out;
}

function chordShare(tokens: readonly string[]): { chords: number; other: number } {
  let chords = 0;
  let other = 0;
  for (const token of tokens) {
    if (isChord(token)) chords += 1;
    else if (!isChordLineFiller(token)) other += 1;
  }
  return { chords, other };
}

/** A line made of chords (and bar lines, repeats…), not words. */
function isChordTokens(tokens: readonly string[]): boolean {
  const { chords, other } = chordShare(tokens);
  return chords > 0 && other === 0;
}

/**
 * "[C]Quien rompe [F]el poder": chords in brackets inside the lyric. One
 * bracketed chord at the very end ("Gracia Sublime [C]") is a key annotation,
 * not inline chords.
 */
function isInlineChordPro(text: string, exact = false): boolean {
  // Typed in the simple editor, brackets always mean ChordPro, even around
  // something that is not a chord name.
  const matches = exact
    ? [...text.matchAll(/\[([^\]]{1,16})\]/g)]
    : [...text.matchAll(/\[([^\]\s]{1,16})\]/g)].filter((match) => isChord(match[1]));
  if (matches.length === 0) return false;
  if (matches.length >= 2) return true;
  const match = matches[0];
  return match.index + match[0].length < text.trimEnd().length;
}

/** Parts that carry no words: lyrics after one of them start a new part. */
const WORDLESS_KINDS = new Set<MarkerKind>([
  "intro", "solo", "instrumental", "interlude", "breakdown", "turnaround", "outro", "ending",
]);

/**
 * Tablature ("G--12-12--") and melody notes ("D-C#-A-D-C#//B"): text that only
 * makes sense character for character. Kept verbatim, never merged with
 * chords. Bar lines and chord names alone are a chord line, not this.
 */
function isTabLine(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 6) return false;
  // A string of a tab: "e|--3--", "G-14-14--", "B:---".
  if (
    /^[A-Ga-g][#b]?[|:]?-[-0-9hpbrvVx/\~()|.*]+$/.test(compact) &&
    (compact.match(/-/g)?.length ?? 0) >= compact.length * 0.3
  ) {
    return true;
  }
  // Notes joined by dashes: every piece is one or more note names.
  if (!/[-]/.test(compact)) return false;
  const pieces = text.split(/[\s\-/|]+/).filter(Boolean);
  return pieces.length >= 3 && pieces.every((piece) => /^(?:[A-G][#b♯♭]?)+$/.test(piece)) &&
    pieces.some((piece) => /^(?:[A-G][#b♯♭]?){2,}$/.test(piece));
}

type Classified =
  | { type: "blank" }
  | { type: "meta" }
  | { type: "tab"; text: string }
  | { type: "header"; label: string; chords: Word[]; comment?: string }
  | { type: "chords"; chords: Word[] }
  | { type: "inline"; text: string }
  | { type: "lyrics"; line: SourceLine };

function classify(line: SourceLine, measure: MeasureText, exact = false): Classified {
  const text = lineText(line);
  if (!text) return { type: "blank" };
  if (!exact && META_RE.test(text)) return { type: "meta" };
  // A lone icon ("×", "•", "★") copied from a web page.
  if (!exact && [...text].length === 1 && !/[\p{L}\p{N}|/%-]/u.test(text)) return { type: "meta" };
  if (isInlineChordPro(text, exact) && !parseSectionHeader(text)) return { type: "inline", text };
  const header = parseSectionHeader(text);
  if (header) return { type: "header", label: header.label, chords: [] };

  const lineWords = words(line, measure);
  const tokens = lineWords.map((word) => word.text);
  if (isChordTokens(tokens)) {
    return { type: "chords", chords: lineWords.filter((word) => isChord(word.text)) };
  }
  if (isTabLine(text)) return { type: "tab", text: tabText(line, measure) };
  // One part typed by hand: a header is a line with only the name; "INTRO
  // C G" written inside a part is text, not a new part.
  if (exact) return { type: "lyrics", line };

  // "INTRO; son notas para mejor comprensión" / "Coro: más suave": a header,
  // then a note for the musician.
  const punctuated = /^([^:;]{2,24})[:;]\s*(.+)$/.exec(text);
  if (punctuated) {
    const parsed = parseSectionHeader(punctuated[1]);
    const rest = punctuated[2].trim();
    if (parsed && rest) {
      const restTokens = rest.split(/\s+/);
      if (isChordTokens(restTokens)) {
        const restWords = lineWords.filter((word) => isChord(word.text));
        return { type: "header", label: parsed.label, chords: restWords };
      }
      return { type: "header", label: parsed.label, chords: [], comment: sentenceCase(rest) };
    }
  }
  // "INTRO  C  F  C  F" or "Verso 1: G D Em": a header with its chords.
  for (let split = Math.min(4, tokens.length - 1); split >= 1; split -= 1) {
    const head = tokens.slice(0, split).join(" ");
    const parsed = parseSectionHeader(head);
    if (parsed && isChordTokens(tokens.slice(split))) {
      return {
        type: "header",
        label: parsed.label,
        chords: lineWords.slice(split).filter((word) => isChord(word.text)),
      };
    }
  }
  return { type: "lyrics", line };
}

/** Places chords over a lyric line by horizontal position. */
function mergeChords(
  chords: readonly Word[],
  lyric: SourceLine,
  measure: MeasureText,
  exact = false,
): ChartSegment[] {
  if (exact) return mergeChordsExact(chords, lyric);
  // The lyric as one string, with each character's x.
  let text = "";
  const xs: number[] = [];
  let previousEnd: number | null = null;
  const sorted = [...lyric.fragments].sort((left, right) => left.x - right.x);
  for (const fragment of sorted) {
    if (previousEnd !== null && fragment.x - previousEnd > 0.5 && !/\s$/.test(text)) {
      text += " ";
      xs.push(previousEnd);
    }
    const offsets = measure(fragment.text, fragment.width);
    for (let index = 0; index < fragment.text.length; index += 1) {
      text += fragment.text[index];
      xs.push(fragment.x + (offsets[index] ?? 0));
    }
    previousEnd = fragment.x + fragment.width;
  }
  // A chord line much longer than its lyric (Planning Center's editor lays
  // chords out in a proportional font, so in columns they land far past the
  // words): spread the chords over the lyric the way Planning Center draws
  // them. A last chord just after the words is left where it is.
  // Planning Center's closing repeat marks ("… fiel ////") are not words: no
  // chord goes inside them, and they do not count as the line's length.
  const marks = /\s*\/{2,}\s*$/.exec(text);
  const wordsLength = marks ? marks.index : text.length;
  // Where the words end: trailing spaces (tabs after "Jesús,") and repeat
  // marks are not words.
  const lastWord = text.slice(0, wordsLength).search(/\s*$/);
  const lyricEnd = lastWord > 0 ? xs[lastWord - 1] + 1 : (previousEnd ?? 0);
  const furthest = Math.max(...chords.map((chord) => chord.x));
  // Several chords running past the words (a single last chord after them is
  // a real "after the line" chord and stays there).
  const scale = lyricEnd > 0 && chords.length >= 2 && furthest > lyricEnd * 1.15 ? lyricEnd / (furthest + 1) : 1;
  const placed = scale === 1 ? chords : chords.map((chord) => ({ ...chord, x: chord.x * scale }));
  // Leading spaces only existed to align the first chord; they are kept while
  // placing chords and trimmed afterwards.
  const positions = placed.map((chord) => {
    // The character nearest the chord's left edge. Not "the first one at or
    // after it": positions come from font metrics, and a chord drawn exactly
    // over a character is often a hundredth of a point to its right.
    let index = text.length;
    let best = Number.POSITIVE_INFINITY;
    xs.forEach((x, at) => {
      const distance = Math.abs(x - chord.x);
      if (distance < best) {
        best = distance;
        index = at;
      }
    });
    const lineEnd = previousEnd ?? 0;
    if (chord.x > lineEnd) index = text.length;
    if (index > wordsLength) index = wordsLength;
    // Over the gap between words: it belongs to the word that follows.
    while (index < text.length && text[index] === " ") index += 1;
    // Snap to the start of the word the chord sits over, if it is in its
    // first two characters (chords drift by a glyph in proportional fonts).
    let start = index;
    while (start > 0 && text[start - 1] !== " " && index - start < 2) start -= 1;
    if (start > 0 && text[start - 1] !== " ") start = index;
    return { chord: chord.text, index: start };
  });

  const segments: ChartSegment[] = [];
  let cursor = 0;
  let pending: string | null = null;
  for (const { chord, index } of positions.sort((left, right) => left.index - right.index)) {
    const at = Math.max(cursor, index);
    if (at > cursor || pending !== null) {
      segments.push({ chord: pending, text: text.slice(cursor, at) });
    }
    pending = chord;
    cursor = at;
  }
  segments.push({ chord: pending, text: text.slice(cursor) });
  return trimSegments(segments);
}

/**
 * Text typed in a monospaced box (the simple lyrics editor): every chord sits
 * exactly over the character it starts on, so nothing is snapped or spread.
 * A chord longer than its syllable pushes the next one right; the editor pads
 * the lyric for it with spaces between words and with `_` inside a word
 * ("Gsus4 C" over "a____mor"), and that padding is dropped here.
 */
function mergeChordsExact(chords: readonly Word[], lyric: SourceLine): ChartSegment[] {
  const words = [...lyric.fragments].sort((left, right) => left.x - right.x).map((fragment) => fragment.text).join("");
  // A chord past the end of the words keeps the space before it ("casa [B]").
  const text = words.padEnd(Math.max(0, ...chords.map((chord) => Math.round(chord.x))), " ");
  const positions = chords
    .map((chord) => ({ chord: chord.text, index: Math.max(0, Math.round(chord.x)) }))
    .sort((left, right) => left.index - right.index);
  const segments: ChartSegment[] = [];
  let cursor = 0;
  let pending: string | null = null;
  for (const { chord, index } of positions) {
    if (index > cursor || pending !== null) segments.push({ chord: pending, text: text.slice(cursor, index) });
    pending = chord;
    cursor = index;
  }
  segments.push({ chord: pending, text: text.slice(cursor) });
  return trimSegments(
    segments.map((segment, index) =>
      index < segments.length - 1 ? { ...segment, text: segment.text.replace(/_+$/, "") } : segment,
    ),
  );
}

/** Drops the alignment padding at both ends and collapses inner runs of spaces. */
function trimSegments(segments: ChartSegment[]): ChartSegment[] {
  const out = segments.map((segment) => ({ ...segment, text: segment.text.replace(/\s{2,}/g, " ") }));
  while (out.length > 0 && out[0].chord === null && !out[0].text.trim()) out.shift();
  if (out.length > 0) out[0] = { ...out[0], text: out[0].text.replace(/^\s+/, "") };
  const last = out.length - 1;
  if (last >= 0) out[last] = { ...out[last], text: out[last].text.replace(/\s+$/, "") };
  return out.filter((segment, index) => segment.chord !== null || segment.text || index === 0);
}

/** "SON NOTAS PARA MEJOR COMPRENSION:" → "Son notas para mejor comprension". */
function sentenceCase(text: string): string {
  const clean = text.replace(/[:;]\s*$/, "").trim();
  if (clean !== clean.toUpperCase()) return clean;
  return clean.charAt(0) + clean.slice(1).toLowerCase();
}

/** A tab line rebuilt with its horizontal spacing, in characters. */
function tabText(line: SourceLine, measure: MeasureText): string {
  const sorted = [...line.fragments].sort((left, right) => left.x - right.x);
  if (sorted.length === 1) return sorted[0].text.replace(/\s+$/, "");
  // Character width from the line itself (tab fonts are monospaced).
  const charWidth =
    sorted.reduce((sum, fragment) => sum + fragment.width, 0) /
    Math.max(1, sorted.reduce((sum, fragment) => sum + fragment.text.length, 0));
  let text = "";
  const left = sorted[0].x;
  for (const fragment of sorted) {
    const column = Math.round((fragment.x - left) / Math.max(0.01, charWidth));
    if (column > text.length) text += " ".repeat(column - text.length);
    text += fragment.text;
  }
  void measure;
  return text.replace(/\s+$/, "");
}

function chordOnlyLine(chords: readonly Word[]): ChartLine {
  return {
    kind: "lyrics",
    segments: chords.map((chord, index) => ({
      chord: chord.text,
      text: index < chords.length - 1 ? " " : "",
    })),
  };
}

function plainLyric(line: SourceLine): ChartLine {
  return { kind: "lyrics", segments: [{ chord: null, text: lineText(line) }] };
}

export type AnalyzeOptions = {
  /**
   * The body of one part typed in a monospaced box, not a whole sheet: chords
   * sit exactly over their character (no snapping), there is no title, key or
   * clutter to find, and every line the user wrote is kept.
   */
  exact?: boolean;
};

/** Lines → chart document. Exported for the tests; use the importers below. */
export function analyzeSongSheet(
  lines: readonly SourceLine[],
  measure: MeasureText = uniformMeasure,
  options: AnalyzeOptions = {},
): ChartDoc {
  const exact = options.exact === true;
  const doc: ChartDoc = { title: null, artist: null, key: null, sections: [] };
  const all = lines.map((line) => ({ line, kind: classify(line, measure, exact) }));
  const musicPages = new Set<number>();
  const lyricsPerPage = new Map<number, number>();
  for (const { line, kind } of all) {
    const page = line.page ?? 0;
    if (kind.type === "header" || kind.type === "chords" || kind.type === "inline" || kind.type === "tab") {
      musicPages.add(page);
    } else if (kind.type === "lyrics") {
      lyricsPerPage.set(page, (lyricsPerPage.get(page) ?? 0) + 1);
    }
  }
  const classified = all.filter(({ line }) => {
    const page = line.page ?? 0;
    return page === 0 || musicPages.has(page) || (lyricsPerPage.get(page) ?? 0) >= 6;
  });
  const spanish = lines.some((line) => /[ñáéíóú¿¡]/i.test(lineText(line))) ||
    all.some(({ kind }) => kind.type === "header" && /^(?:coro|verso|estrofa|puente|estribillo)/i.test(kind.label));

  // Title: the biggest text before the first section or chord line; the line
  // right after it, if smaller, is the artist/subtitle.
  const firstContent = classified.findIndex(
    ({ kind }) => kind.type === "header" || kind.type === "chords" || kind.type === "inline",
  );
  const preamble = classified.slice(0, firstContent < 0 ? Math.min(3, classified.length) : firstContent);
  const preambleLyrics = preamble.filter(
    ({ kind, line }) => kind.type === "lyrics" && /\p{L}{2}/u.test(lineText(line)),
  );
  const consumed = new Set<SourceLine>();
  if (!exact && preambleLyrics.length > 0) {
    const biggest = preambleLyrics.reduce((best, entry) => (entry.line.size > best.line.size ? entry : best));
    const others = preambleLyrics.filter((entry) => entry !== biggest);
    const bodySize = lines.reduce((sum, line) => sum + line.size, 0) / Math.max(1, lines.length);
    // Only a real title: bigger than the body, or alone before the content.
    if (biggest.line.size > bodySize * 1.15 || firstContent > 0) {
      const raw = lineText(biggest.line);
      const keyInTitle = /\s*[[(]\s*([A-G](?:#|b)?m?|(?:Do|Re|Mi|Fa|Sol|La|Si)(?:#|b)?m?)\s*[\])]\s*$/.exec(raw);
      doc.title = keyInTitle ? raw.slice(0, keyInTitle.index).trim() : raw;
      if (keyInTitle) doc.key = keyInTitle[1];
      consumed.add(biggest.line);
      // The next biggest line after the title, not just the next one: sheets
      // often put a small "arrangement notes" line before the artist.
      const artist = others
        .filter((entry) => entry.line.size <= biggest.line.size)
        .reduce<(typeof others)[number] | null>((best, entry) => (!best || entry.line.size > best.line.size ? entry : best), null);
      if (artist) {
        doc.artist = lineText(artist.line).replace(/^(?:by|de|por)\s+/i, "");
        consumed.add(artist.line);
      }
      for (const entry of others) consumed.add(entry.line);
    }
  }

  let current: ChartSection | null = null;
  /** Lyrics right after a part with no words (an intro of chords, a solo):
   * a verse the sheet did not label. */
  const needsOwnSection = () =>
    current !== null &&
    current.kind !== null &&
    WORDLESS_KINDS.has(current.kind) &&
    current.lines.length > 0 &&
    !current.lines.some(
      (line) => line.kind === "lyrics" && line.segments.some((segment) => /\p{L}/u.test(segment.text)),
    );
  const unlabeledVerse = spanish ? "Verso" : "Verse";
  const open = (label: string): ChartSection => {
    const header = parseSectionHeader(label);
    current = { label, kind: header?.kind ?? null, number: header?.number ?? null, lines: [] };
    doc.sections.push(current);
    return current;
  };
  const target = (): ChartSection => current ?? open("");

  for (let index = 0; index < classified.length; index += 1) {
    const { line, kind } = classified[index];
    if (consumed.has(line)) continue;
    // Many sheets repeat the title at the top of every page.
    if (doc.title && lineText(line).startsWith(doc.title) && kind.type !== "header") continue;
    const keyMatch = exact ? null : KEY_RE.exec(lineText(line));
    if (keyMatch) {
      doc.key ??= keyMatch[1];
      continue;
    }
    switch (kind.type) {
      case "blank":
      case "meta":
        break;
      case "header": {
        const opened = open(kind.label);
        if (kind.comment) opened.lines.push({ kind: "comment", text: kind.comment });
        if (kind.chords.length > 0) opened.lines.push(chordOnlyLine(kind.chords));
        break;
      }
      case "tab":
        target().lines.push({ kind: "tab", text: kind.text });
        break;
      case "inline":
        target().lines.push({ kind: "lyrics", segments: parseLyricLine(kind.text) });
        break;
      case "chords": {
        const next = classified[index + 1];
        // In a typed part, a lyric that happens to be a part's name ("Coro"
        // under its chord) is still the lyric of that chord line.
        const lyricNext = next && (next.kind.type === "lyrics" || (exact && next.kind.type === "header"));
        if (next && lyricNext && !next.line.breakBefore && !consumed.has(next.line)) {
          if (needsOwnSection()) open(unlabeledVerse);
          target().lines.push({ kind: "lyrics", segments: mergeChords(kind.chords, next.line, measure, exact) });
          index += 1;
        } else {
          target().lines.push(chordOnlyLine(kind.chords));
        }
        break;
      }
      case "lyrics":
        if (needsOwnSection()) open(unlabeledVerse);
        target().lines.push(plainLyric(line));
        break;
    }
  }

  doc.sections = doc.sections.filter((chartSection) => chartSection.label || chartSection.lines.length > 0);
  return doc;
}

/** Whether pasted or loaded text is already ChordPro. */
export function looksLikeChordPro(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const directives = lines.filter((line) => /^\s*\{[a-z_]+(?::.*)?\}\s*$/i.test(line)).length;
  const inline = lines.filter((line) => /\[[^\]\s]{1,12}\][^\s[]/.test(line) || /\[[^\]\s]{1,12}\]\s*$/.test(line)).length;
  // A sheet of chords written over the words with a few [C] lines in it (one
  // "Somos el pueblo de [G]Dios" among chord lines) is a plain sheet: the
  // analyser reads both kinds of line.
  const chordLines = lines.filter(isChordOnlyLine).length;
  return directives > 0 || (inline >= 2 && chordLines < inline);
}

/** A line of only chords and bar marks ("C   G/B", "| F - Am |"). */
function isChordOnlyLine(line: string): boolean {
  const tokens = line.replace(/\|/g, " | ").trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.some(isChord) && tokens.every((token) => isChord(token) || isChordLineFiller(token));
}

/**
 * Section header lines that carry something after the name, split so the
 * name is a header of its own: "PUENTE (bajamos todos)", "PUENTE SEGUIDO",
 * "INTRO PIANOS: C G C G", "Intro: E Esus2", "INTRO |F - Am - G - C/E |".
 * The rest stays: chords as a line of chords (`[C]` in ChordPro), anything
 * else as a note. Spaced repeat marks ("/ / /") are joined ("///").
 */
export function splitSectionHeaderLines(text: string, chordPro = looksLikeChordPro(text)): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .flatMap((raw) => {
      const line = raw.replace(/(^|\s)\/(?:\s+\/)+(?=\s|$)/g, (match, lead: string) => `${lead}${match.replace(/\s+/g, "")}`.replace(/^(\s?)\s*/, "$1"));
      if (/[[{]/.test(line) || !line.trim() || parseSectionHeader(line)) return [line];
      const words = line.trim().split(/\s+/);
      for (let size = Math.min(3, words.length - 1); size >= 1; size -= 1) {
        const head = words.slice(0, size).join(" ");
        const colon = head.endsWith(":");
        const name = head.replace(/:$/, "");
        const header = parseSectionHeader(name);
        if (!header) continue;
        const rest = words.slice(size).join(" ").replace(/^:\s*/, "");
        const restTokens = rest.replace(/\|/g, " | ").split(/\s+/).filter(Boolean);
        const chordsAt = restTokens.findIndex(isChord);
        const chords = chordsAt >= 0 && restTokens.slice(chordsAt).every((token) => isChord(token) || isChordLineFiller(token));
        const note = chordsAt > 0 ? restTokens.slice(0, chordsAt).join(" ").replace(/:$/, "") : chordsAt < 0 ? rest : "";
        const parenthetical = /^\(.*\)$/.test(rest.trim());
        const caps = line === line.toUpperCase() && /\p{L}/u.test(rest) && rest.split(/\s+/).length <= 3;
        if (!chords && !colon && !parenthetical && !caps) continue;
        const out = [name];
        const noteText = note.replace(/^\((.*)\)$/, "$1").trim();
        if (noteText) out.push(chordPro ? `{comment: ${noteText}}` : `(${noteText})`);
        if (chords) {
          const chordTokens = restTokens.slice(chordsAt);
          out.push(chordPro ? chordTokens.map((token) => (isChord(token) ? `[${token}]` : token)).join(" ") : chordTokens.join(" "));
        }
        return out;
      }
      return [line];
    })
    .join("\n");
}

/** Plain text (a .txt, an e-mail, a web page pasted) → lines in characters.
 * Tabs count as 8 columns, as in the editors that aligned the chords. */
/**
 * `splitSectionHeaderLines` for lines read from a PDF: a header line that
 * carries something after the name ("PUENTE (bajamos todos)", "INTRO: Bm D G
 * A") becomes the header and, below it, its note or chords. Other lines are
 * left as they are, positions and all (chords sit by those positions).
 */
export function splitSectionHeaderSourceLines(lines: readonly SourceLine[]): SourceLine[] {
  return lines.flatMap((line) => {
    const fragments = [...line.fragments].sort((left, right) => left.x - right.x);
    const text = fragments.map((fragment) => fragment.text.trim()).filter(Boolean).join(" ");
    const pieces = splitSectionHeaderLines(text, false).split("\n");
    if (pieces.length < 2) return [line];
    const x = fragments[0]?.x ?? 0;
    const unit = fragments.length && text.length ? Math.max(0.01, (fragments[fragments.length - 1].x + fragments[fragments.length - 1].width - x) / text.length) : 1;
    return pieces.map((piece, index) => ({
      ...line,
      fragments: [{ text: piece, x, width: piece.length * unit }],
      breakBefore: index === 0 ? line.breakBefore : false,
    }));
  });
}

export function textToSourceLines(text: string): SourceLine[] {
  const out: SourceLine[] = [];
  let blank = false;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    let line = "";
    for (const char of raw) line += char === "\t" ? " ".repeat(8 - (line.length % 8)) : char;
    if (!line.trim()) {
      blank = true;
      continue;
    }
    out.push({ fragments: [{ text: line, x: 0, width: line.length }], size: 1, breakBefore: blank });
    blank = false;
  }
  return out;
}

/** Any text → ChordPro: kept as is if it already is ChordPro, analysed if not. */
export function chordProFromText(text: string, measure: MeasureText = uniformMeasure): string {
  const chordPro = looksLikeChordPro(text);
  const split = splitSectionHeaderLines(text, chordPro);
  if (chordPro) return serializeChordPro(parseChordPro(split));
  return serializeChordPro(analyzeSongSheet(textToSourceLines(split), measure));
}
