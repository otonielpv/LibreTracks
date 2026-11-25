import { analyzeSongSheet, looksLikeChordPro, textToSourceLines } from "./chartImport";
import { isChord } from "./chordNotation";
import { parseChordPro, serializeLyricLine, type ChartLine, type ChartSection } from "./chordChart";

/**
 * One part of a chart as the casual user sees it in the simple editor, and
 * back: "like on paper", in a monospaced box.
 *
 *   - Lyrics alone are written as they are.
 *   - Chords go on their own line over the lyric, each one over the first
 *     character of the run it starts. A chord longer than its syllable pushes
 *     the next one right: the lyric is padded for it with spaces between words
 *     and with `_` inside a word ("a____mor"); reading back drops the padding.
 *   - A line of only chords (an intro) is just the chord line. A lyric without
 *     chords right after it is separated by a blank line, so reading back does
 *     not put those chords over it.
 *   - Comments are written as ChordPro: `{c: Más suave}` on their own line.
 *   - A line a chord line cannot say (a "chord" that is not a chord name)
 *     is written as inline ChordPro: `[0:00]uno`.
 *   - Tablature goes between `{start_of_tab}` and `{end_of_tab}`, character
 *     for character.
 *
 * Reading back reuses the sheet analyser (`analyzeSongSheet` in exact mode)
 * and `parseChordPro`; there is no parser of its own. Text with ChordPro
 * brackets (`[G]Santo`) is read as ChordPro. Blank lines are ignored (the
 * model does not keep them). A section header typed inside ("CORO") does not
 * open another part: it is ignored, and the chords or note on its line stay.
 * A `_` at the end of a run before a chord is taken as padding.
 */

export function sectionToPlain(section: Pick<ChartSection, "lines">): string {
  const out: string[] = [];
  let previousChordsOnly = false;
  section.lines.forEach((line, index) => {
    if (line.kind === "tab") {
      if (section.lines[index - 1]?.kind !== "tab") out.push("{start_of_tab}");
      out.push(line.text);
      if (section.lines[index + 1]?.kind !== "tab") out.push("{end_of_tab}");
      previousChordsOnly = false;
      return;
    }
    if (line.kind === "comment") {
      out.push(`{c: ${line.text}}`);
      previousChordsOnly = false;
      return;
    }
    const { chords, lyric } = lyricToPlain(line.segments);
    if (chords === null) {
      if (!lyric) return;
      if (previousChordsOnly) out.push("");
      out.push(lyric);
      previousChordsOnly = false;
      return;
    }
    out.push(chords);
    if (lyric) out.push(lyric);
    previousChordsOnly = !lyric;
  });
  return out.join("\n");
}

/** One lyric line as a chord line (or `null` without chords) over its lyric. */
export function lyricToPlain(segments: ReadonlyArray<{ chord: string | null; text: string }>): {
  chords: string | null;
  lyric: string;
} {
  if (!segments.some((segment) => segment.chord)) {
    return { chords: null, lyric: segments.map((segment) => segment.text).join("").trim() };
  }
  // What a chord line cannot say (a "chord" that is no chord name, a `_` or
  // bracket in the lyric right where padding would go) stays inline ChordPro
  // on its line: `[0:00]uno`.
  const unsafe = segments.some(
    (segment, index) =>
      (segment.chord !== null && !isChord(segment.chord)) ||
      /[[\]]/.test(segment.text) ||
      (index < segments.length - 1 && segment.text.endsWith("_")),
  );
  if (unsafe) return { chords: null, lyric: serializeLyricLine(segments).trim() };
  let chordLine = "";
  let lyric = "";
  for (const segment of segments) {
    if (segment.chord) {
      const needed = chordLine.length === 0 ? 0 : chordLine.length + 1;
      if (lyric.length < needed) {
        const pad = needed - lyric.length;
        lyric += lyric === "" || /\s$/.test(lyric) ? " ".repeat(pad) : "_".repeat(pad);
      }
      chordLine += " ".repeat(lyric.length - chordLine.length) + segment.chord;
    }
    lyric += segment.text;
  }
  // Trailing `_` stay: they keep a last chord right after its word ("ón__"
  // under "C/E F"), not after a space.
  lyric = lyric.replace(/\s+$/, "");
  return { chords: chordLine, lyric: /[^\s_]/.test(lyric) ? lyric : "" };
}

const DIRECTIVE_RE = /^\s*\{\s*[a-z_]+\s*(?::.*)?\}\s*$/i;
const TAB_START_RE = /^\s*\{\s*(?:start_of_tab|sot|start_of_grid|sog)\s*\}\s*$/i;
const TAB_END_RE = /^\s*\{\s*(?:end_of_tab|eot|end_of_grid|eog)\s*\}\s*$/i;

/** What the user typed for one part → its chart lines. */
export function plainToSectionLines(text: string): ChartLine[] {
  const rows = text.replace(/\r\n?/g, "\n").split("\n");
  const body = rows.filter((row) => !DIRECTIVE_RE.test(row));
  if (looksLikeChordPro(body.join("\n"))) return linesOfChordPro(text);

  const out: ChartLine[] = [];
  let plain: string[] = [];
  const flush = () => {
    if (plain.some((row) => row.trim())) {
      const doc = analyzeSongSheet(textToSourceLines(plain.join("\n")), undefined, { exact: true });
      for (const chartSection of doc.sections) out.push(...chartSection.lines);
    }
    plain = [];
  };
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (TAB_START_RE.test(row)) {
      flush();
      let end = index + 1;
      while (end < rows.length && !TAB_END_RE.test(rows[end])) end += 1;
      out.push(...linesOfChordPro(rows.slice(index, end + 1).join("\n")));
      index = end;
    } else if (DIRECTIVE_RE.test(row)) {
      flush();
      out.push(...linesOfChordPro(row));
    } else {
      plain.push(row);
    }
  }
  flush();
  return out;
}

function linesOfChordPro(text: string): ChartLine[] {
  return parseChordPro(text).sections.flatMap((chartSection) => chartSection.lines);
}

/**
 * Two lines are the same for the editor if they read the same: runs of
 * spaces, spaces at the ends, spaces right after a chord and empty segments
 * are layout, not content.
 */
export function normalizeChartLine(line: ChartLine): string {
  if (line.kind !== "lyrics") return `${line.kind}:${line.text}`;
  const text = serializeLyricLine(line.segments.filter((segment) => segment.chord || segment.text))
    .replace(/\]\s+\[/g, "][")
    .replace(/(\[[^\]]*\])(\s+)/g, " $1")
    .replace(/\s+/g, " ")
    .trim();
  return `lyrics:${text}`;
}

type Segments = ReadonlyArray<{ chord: string | null; text: string }>;

/** The chords of a lyric line by the character they start on. */
export function chordsByIndex(segments: Segments): Map<number, string> {
  const out = new Map<number, string>();
  let at = 0;
  for (const segment of segments) {
    if (segment.chord) out.set(at, segment.chord);
    at += segment.text.length;
  }
  return out;
}

/**
 * The line with `chord` put on (or, with `null`, taken off) the character at
 * `index`: what the chord picker does when a syllable is tapped. The words
 * stay as they are.
 */
export function setChordAt(segments: Segments, index: number, chord: string | null): ChartLine {
  const text = segments.map((segment) => segment.text).join("");
  const chords = chordsByIndex(segments);
  const at = Math.max(0, Math.min(index, text.length));
  if (chord) chords.set(at, chord);
  else chords.delete(at);
  const starts = [...chords.keys()].sort((left, right) => left - right);
  const out: Array<{ chord: string | null; text: string }> = [];
  if (starts.length === 0 || starts[0] > 0) out.push({ chord: null, text: text.slice(0, starts[0] ?? text.length) });
  starts.forEach((start, position) => {
    out.push({ chord: chords.get(start) ?? null, text: text.slice(start, starts[position + 1] ?? text.length) });
  });
  return { kind: "lyrics", segments: out.filter((segment, position) => segment.chord !== null || segment.text || position === 0) };
}

/** Chords the part or song already uses, most used first: offered first. */
export function usedChords(lines: readonly ChartLine[]): string[] {
  const counts = new Map<string, number>();
  for (const line of lines) {
    if (line.kind !== "lyrics") continue;
    for (const segment of line.segments) if (segment.chord) counts.set(segment.chord, (counts.get(segment.chord) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([chord]) => chord);
}

/** Whether the chords are written in Latin notation (Do, Re, Sol…). */
export function usesLatinNotation(lines: readonly ChartLine[]): boolean {
  return usedChords(lines).some((chord) => /^(?:Do|Re|Mi|Fa|Sol|La|Si)/.test(chord));
}

/** A chord added at the end of a line (a part played, not sung: "C G Am"
 * one chord after another), written like a line of chords typed by hand. */
export function appendChord(segments: Segments, chord: string): ChartLine {
  const out = segments.map((segment) => ({ ...segment }));
  const last = out[out.length - 1];
  if (last && last.chord && !last.text) last.text = " ";
  out.push({ chord, text: "" });
  return { kind: "lyrics", segments: out.filter((segment, position) => segment.chord !== null || segment.text || position === 0) };
}
