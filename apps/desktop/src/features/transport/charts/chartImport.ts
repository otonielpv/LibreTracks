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
import type { MarkerKind } from "@libretracks/shared/models";

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
function isInlineChordPro(text: string): boolean {
  const matches = [...text.matchAll(/\[([^\]\s]{1,16})\]/g)].filter((match) => isChord(match[1]));
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

function classify(line: SourceLine, measure: MeasureText): Classified {
  const text = lineText(line);
  if (!text) return { type: "blank" };
  if (META_RE.test(text)) return { type: "meta" };
  // A lone icon ("×", "•", "★") copied from a web page.
  if ([...text].length === 1 && !/[\p{L}\p{N}|/%-]/u.test(text)) return { type: "meta" };
  if (isInlineChordPro(text) && !parseSectionHeader(text)) return { type: "inline", text };
  const header = parseSectionHeader(text);
  if (header) return { type: "header", label: header.label, chords: [] };

  const lineWords = words(line, measure);
  const tokens = lineWords.map((word) => word.text);
  if (isChordTokens(tokens)) {
    return { type: "chords", chords: lineWords.filter((word) => isChord(word.text)) };
  }
  if (isTabLine(text)) return { type: "tab", text: tabText(line, measure) };

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
): ChartSegment[] {
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
  // Leading spaces only existed to align the first chord; they are kept while
  // placing chords and trimmed afterwards.
  const positions = chords.map((chord) => {
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

/** Lines → chart document. Exported for the tests; use the importers below. */
export function analyzeSongSheet(lines: readonly SourceLine[], measure: MeasureText = uniformMeasure): ChartDoc {
  const doc: ChartDoc = { title: null, artist: null, key: null, sections: [] };
  const all = lines.map((line) => ({ line, kind: classify(line, measure) }));
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
  if (preambleLyrics.length > 0) {
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
    const keyMatch = KEY_RE.exec(lineText(line));
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
        if (next && next.kind.type === "lyrics" && !next.line.breakBefore && !consumed.has(next.line)) {
          if (needsOwnSection()) open(unlabeledVerse);
          target().lines.push({ kind: "lyrics", segments: mergeChords(kind.chords, next.line, measure) });
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
  return directives > 0 || inline >= 2;
}

/** Plain text (a .txt, an e-mail, a web page pasted) → lines in characters.
 * Tabs count as 8 columns, as in the editors that aligned the chords. */
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
export function chordProFromText(text: string): string {
  if (looksLikeChordPro(text)) return serializeChordPro(parseChordPro(text));
  return serializeChordPro(analyzeSongSheet(textToSourceLines(text)));
}
