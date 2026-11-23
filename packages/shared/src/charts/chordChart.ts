import type { MarkerKind } from "../models";

import { transposeChord, transposeNoteRun } from "./chordNotation";
import { canonicalLabel, chartKind } from "./sectionVocab";

/**
 * A song's lyrics and chords, as LibreTracks understands them.
 *
 * Stored as ChordPro text — the format StageTraxx, OnSong and SongBook share —
 * so it can be read, fixed by hand and exchanged. This is its parsed form.
 */

/** A run of lyrics with the chord played where it starts. */
export type ChartSegment = { chord: string | null; text: string };

export type ChartLine =
  | { kind: "lyrics"; segments: ChartSegment[] }
  | { kind: "comment"; text: string }
  /** Kept character for character: guitar tablature, chord grids, melody
   * notes ("D-C#-A"). Only melody notes are transposed (and drawn as notes). */
  | { kind: "tab"; text: string };

export type ChartSection = {
  label: string;
  /** What the label names, for matching the song's markers. */
  kind: MarkerKind | null;
  /** The number in the label ("Verso 2" → 2), if any. */
  number: number | null;
  lines: ChartLine[];
};

export type ChartDoc = {
  title: string | null;
  artist: string | null;
  key: string | null;
  sections: ChartSection[];
};

export type SectionHeader = { label: string; kind: MarkerKind | null; number: number | null };

/**
 * Whether a whole line is a section header — "VERSO 1", "[Chorus]", "Pre-Coro:",
 * "(Puente x2)", "Verse II" — and what it names. Lyrics never match: the label
 * must be ONLY the section word, an optional number and decoration.
 */
export function parseSectionHeader(raw: string): SectionHeader | null {
  const text = raw
    .replace(/[ ]/g, " ")
    .trim()
    .replace(/^[[({]\s*/, "")
    .replace(/\s*[\])}]\s*[:;.]?$/, "")
    .replace(/\s*[:;.]$/, "")
    .trim();
  if (!text || text.length > 32) return null;
  // The words come from the one vocabulary (Rust `section_vocab.rs`); only the
  // decoration ("[...]", "Coro:", "(x2)") is a chart thing.
  const meaning = canonicalLabel(text, "header");
  if (!meaning) return null;
  return { label: tidyLabel(text), kind: chartKind(meaning.kind), number: meaning.number };
}

/** "VERSO 1" → "Verso 1"; mixed case is left as the author wrote it. */
function tidyLabel(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean !== clean.toUpperCase()) return clean;
  return clean.charAt(0) + clean.slice(1).toLowerCase();
}

function section(label: string): ChartSection {
  const header = parseSectionHeader(label);
  return {
    label,
    kind: header?.kind ?? null,
    number: header?.number ?? null,
    lines: [],
  };
}

const ENVIRONMENT_LABELS: Record<string, string> = {
  verse: "Verse",
  v: "Verse",
  chorus: "Chorus",
  c: "Chorus",
  bridge: "Bridge",
  b: "Bridge",
  tab: "Tab",
  grid: "Grid",
};

/** Parses `[C]lyrics with [F]chords` into segments. */
export function parseLyricLine(line: string): ChartSegment[] {
  const segments: ChartSegment[] = [];
  const pattern = /\[([^\]]*)\]/g;
  let last = 0;
  let chord: string | null = null;
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    const text = line.slice(last, match.index);
    if (text || chord !== null) segments.push({ chord, text });
    chord = match[1].trim() || null;
    last = match.index + match[0].length;
  }
  const tail = line.slice(last);
  if (tail || chord !== null) segments.push({ chord, text: tail });
  return segments;
}

/** Reads ChordPro, including the dialects other apps write. */
export function parseChordPro(source: string): ChartDoc {
  return readChordPro(source);
}

/** Where a lyric line of the source text lands in the parsed document. */
export type LyricLinePlace = { raw: number; section: number; line: number };

/** `parseChordPro`, also saying which raw line of `source` became which
 * section/line — so the editor can put a line's change time next to it. */
export function parseChordProWithPlaces(source: string): { doc: ChartDoc; places: LyricLinePlace[] } {
  const places: LyricLinePlace[] = [];
  const doc = readChordPro(source, (place) => places.push(place));
  return { doc, places };
}

function readChordPro(source: string, onLyricLine?: (place: LyricLinePlace) => void): ChartDoc {
  const doc: ChartDoc = { title: null, artist: null, key: null, sections: [] };
  let current: ChartSection | null = null;
  const open = (label: string) => {
    current = section(label);
    doc.sections.push(current);
    return current;
  };
  const target = () => current ?? open("");

  let inTab = false;
  const rawLines = source.replace(/\r\n?/g, "\n").split("\n");
  for (let raw = 0; raw < rawLines.length; raw += 1) {
    const rawLine = rawLines[raw];
    const line = rawLine.replace(/\s+$/, "");
    const directive = /^\s*\{\s*([a-z_]+)\s*(?::\s*(.*?))?\s*\}\s*$/i.exec(line);
    const directiveName = directive?.[1].toLowerCase() ?? "";
    if (inTab) {
      if (directiveName === "end_of_tab" || directiveName === "eot" || directiveName === "end_of_grid" || directiveName === "eog") {
        inTab = false;
      } else if (line.trim()) {
        target().lines.push({ kind: "tab", text: line });
      }
      continue;
    }
    if (!line.trim()) continue;
    if (line.trimStart().startsWith("#")) continue;

    if (directive) {
      const name = directiveName;
      const value = (directive[2] ?? "").trim();
      if (name === "start_of_tab" || name === "sot" || name === "start_of_grid" || name === "sog") {
        inTab = true;
        continue;
      }
      if (name === "title" || name === "t") doc.title = value || doc.title;
      else if (name === "subtitle" || name === "st" || name === "artist") doc.artist = value || doc.artist;
      else if (name === "key") doc.key = value || doc.key;
      else if (name === "section") open(value);
      else if (name.startsWith("start_of_") || /^so[a-z]$/.test(name)) {
        const environment = name.startsWith("start_of_") ? name.slice(9) : name.slice(2);
        open(value || ENVIRONMENT_LABELS[environment] || "");
      } else if (name === "comment" || name === "c" || name === "ci" || name === "cb" || name === "highlight") {
        // Many apps write sections as comments: {c: Chorus}.
        if (parseSectionHeader(value)) open(value);
        else if (value) target().lines.push({ kind: "comment", text: value });
      }
      // end_of_*, chord definitions, capo, tempo…: nothing to show.
      continue;
    }

    if (parseSectionHeader(line)) {
      open(line.trim().replace(/:$/, ""));
      continue;
    }
    const into = target();
    into.lines.push({ kind: "lyrics", segments: parseLyricLine(line) });
    onLyricLine?.({ raw, section: doc.sections.indexOf(into), line: into.lines.length - 1 });
  }
  return doc;
}

export function serializeLyricLine(segments: readonly ChartSegment[]): string {
  return segments.map((segment) => (segment.chord ? `[${segment.chord}]` : "") + segment.text).join("");
}

/** Writes ChordPro that `parseChordPro` reads back to the same document. */
export function serializeChordPro(doc: ChartDoc): string {
  const out: string[] = [];
  if (doc.title) out.push(`{title: ${doc.title}}`);
  if (doc.artist) out.push(`{artist: ${doc.artist}}`);
  if (doc.key) out.push(`{key: ${doc.key}}`);
  for (const chartSection of doc.sections) {
    if (out.length > 0) out.push("");
    if (chartSection.label) out.push(`{section: ${chartSection.label}}`);
    chartSection.lines.forEach((line, index) => {
      if (line.kind === "tab") {
        // Consecutive tab lines share one {start_of_tab} block.
        if (chartSection.lines[index - 1]?.kind !== "tab") out.push("{start_of_tab}");
        out.push(line.text);
        if (chartSection.lines[index + 1]?.kind !== "tab") out.push("{end_of_tab}");
        return;
      }
      out.push(line.kind === "comment" ? `{comment: ${line.text}}` : serializeLyricLine(line.segments));
    });
  }
  return `${out.join("\n")}\n`;
}

/** The same document with every chord moved by `semitones`. */
export function transposeChart(doc: ChartDoc, semitones: number, flats = false): ChartDoc {
  if (!semitones) return doc;
  return {
    ...doc,
    key: doc.key ? transposeChord(doc.key, semitones, flats) : doc.key,
    sections: doc.sections.map((chartSection) => ({
      ...chartSection,
      lines: chartSection.lines.map((line) =>
        line.kind === "lyrics"
          ? {
              kind: "lyrics" as const,
              segments: line.segments.map((segment) => ({
                ...segment,
                chord: segment.chord ? transposeChord(segment.chord, semitones, flats) : null,
              })),
            }
          : line.kind === "tab"
            ? { kind: "tab" as const, text: transposeNoteRun(line.text, semitones, flats) }
            : line,
      ),
    })),
  };
}

/**
 * The chart transposed `semitones`, spelled with sharps and with flats. A song
 * that modulates is read in a different key in each part (D up to Eb: the last
 * chorus wants `Ab`, not `G#`), so the reader picks the spelling per block from
 * the key sounding where it starts. Without a transposition the chords stay as
 * written and both are the same document.
 */
export type SpelledChart = { sharps: ChartDoc; flats: ChartDoc };

export function spellChart(doc: ChartDoc, semitones: number): SpelledChart {
  return {
    sharps: transposeChart(doc, semitones, false),
    flats: transposeChart(doc, semitones, true),
  };
}
