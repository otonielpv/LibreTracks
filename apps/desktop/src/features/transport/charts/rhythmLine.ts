import type { ChartSegment } from "@libretracks/shared/charts/chordChart";

/** One cell of a rhythm line: a chord, a slash beat or a bar line. */
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

  // Chart notation: the chord is the first beat and each slash one more
  // ("Fm / / /" is four beats), so the chord never takes a slash's place.
  const cells: RhythmCell[] = [];
  for (const segment of segments) {
    if (segment.chord) cells.push({ kind: "beat", chord: segment.chord, mark: "" });
    for (const token of segment.text.match(TOKEN) ?? []) {
      cells.push(BAR.test(token) ? { kind: "bar", mark: token } : { kind: "beat", chord: null, mark: token });
    }
  }
  return cells;
}
