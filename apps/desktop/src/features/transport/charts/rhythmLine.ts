import type { ChartSegment } from "@libretracks/shared/charts/chordChart";

/** One cell of a rhythm line: a beat (with the chord that starts on it) or a bar line. */
export type RhythmCell =
  | { kind: "beat"; chord: string | null; mark: string }
  | { kind: "bar"; mark: string };

/** Text that only holds beats and bars: `/ / / |`, `% |`, `|: / - / :|`. */
const RHYTHM_TEXT = /^[\s/|%.\-:]*$/;
const TOKEN = /:?\|+:?|[^\s|]+/g;
const BAR = /^:?\|+:?$/;

/**
 * `[Ab] / / / | [Fm] / / / |` → one cell per beat and per bar, so the line is
 * drawn as an even grid instead of proportional text with chords over it.
 * Returns null for anything that is not a pure rhythm line (real lyrics).
 */
export function parseRhythmLine(segments: readonly ChartSegment[]): RhythmCell[] | null {
  if (!segments.some((segment) => segment.chord)) return null;
  if (!segments.every((segment) => RHYTHM_TEXT.test(segment.text))) return null;
  if (!segments.some((segment) => segment.text.includes("/"))) return null;

  const cells: RhythmCell[] = [];
  let pending: string | null = null;
  for (const segment of segments) {
    if (segment.chord) {
      // Two chords with no beat between them: the first still gets its cell.
      if (pending) cells.push({ kind: "beat", chord: pending, mark: "" });
      pending = segment.chord;
    }
    for (const token of segment.text.match(TOKEN) ?? []) {
      if (BAR.test(token)) {
        cells.push({ kind: "bar", mark: token });
      } else {
        cells.push({ kind: "beat", chord: pending, mark: token });
        pending = null;
      }
    }
  }
  if (pending) cells.push({ kind: "beat", chord: pending, mark: "" });
  return cells;
}
