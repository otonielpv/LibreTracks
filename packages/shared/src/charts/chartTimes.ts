import type { ChartLink, SectionMarkerSummary } from "../models";
import { parseChordProWithPlaces, type ChartDoc } from "./chordChart";
import { formatLineTime, lineStartSeconds, parseLineTime } from "./chartSync";

/**
 * Line change times written into the lyrics text, for the editor:
 *
 *     {section: Verso 1}
 *     [0:31.4] [C]Quien rompe el poder del pe[F]cado
 *
 * The stored ChordPro never carries them (times live in the marker links, in
 * beats); the editor adds them when it opens and takes them out on save. The
 * brackets cannot be mistaken for a chord: a chord never looks like a time.
 */

const TIME_PREFIX_RE = /^(\s*)\[(\d+:\d{1,2}(?:[.,]\d+)?)\][ \t]?/;

/** `section:line` → seconds of song time. */
export type ChartLineTimes = Map<string, number>;

export const lineTimeKey = (section: number, line: number) => `${section}:${line}`;

/** The text with each lyric line's time in front, where `timeFor` has one. */
export function addChartTimes(
  text: string,
  timeFor: (section: number, line: number) => number | null,
): string {
  const rawLines = text.replace(/\r\n?/g, "\n").split("\n");
  const { places } = parseChordProWithPlaces(text);
  for (const place of places) {
    const seconds = timeFor(place.section, place.line);
    if (seconds === null) continue;
    rawLines[place.raw] = `[${formatLineTime(seconds)}] ${rawLines[place.raw].replace(/^\s+/, "")}`;
  }
  return rawLines.join("\n");
}

/** The text without the times, and the times that were written. */
export function takeChartTimes(annotated: string): { text: string; times: ChartLineTimes } {
  const prefixes = new Map<number, number>();
  const rawLines = annotated
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line, raw) => {
      const match = TIME_PREFIX_RE.exec(line);
      if (!match) return line;
      const seconds = parseLineTime(match[2]);
      if (seconds !== null) prefixes.set(raw, seconds);
      return match[1] + line.slice(match[0].length);
    });
  const text = rawLines.join("\n");
  const times: ChartLineTimes = new Map();
  for (const place of parseChordProWithPlaces(text).places) {
    const seconds = prefixes.get(place.raw);
    if (seconds !== undefined) times.set(lineTimeKey(place.section, place.line), seconds);
  }
  return { text, times };
}


/** Song timing the editor works with: markers and song bounds are song
 * positions, and line times are shown counted from the song's start. */
export type ChartTiming = {
  markers: readonly SectionMarkerSummary[];
  songStartSeconds: number;
  songEndSeconds: number;
  secondsPerBeatAt: (seconds: number) => number;
};

type Occurrence = { link: ChartLink; offset: number; sectionSeconds: number; secondsPerBeat: number };

/** Each section's linked markers, in timeline order, with their timing. */
function occurrencesBySection(links: readonly ChartLink[], timing: ChartTiming): Map<number, Occurrence[]> {
  const sorted = [...timing.markers].sort((left, right) => left.startSeconds - right.startSeconds);
  const result = new Map<number, Occurrence[]>();
  sorted.forEach((marker, index) => {
    const link = links.find((candidate) => candidate.markerId === marker.id);
    if (!link) return;
    const next = sorted.slice(index + 1).find((candidate) => candidate.startSeconds > marker.startSeconds);
    result.set(link.section, [
      ...(result.get(link.section) ?? []),
      {
        link,
        offset: marker.startSeconds - timing.songStartSeconds,
        sectionSeconds: Math.max(0, (next?.startSeconds ?? timing.songEndSeconds) - marker.startSeconds),
        secondsPerBeat: timing.secondsPerBeatAt(marker.startSeconds),
      },
    ]);
  });
  return result;
}

/**
 * When each line changes, counted from the song's start, as the editor shows
 * it: the times of the section's FIRST appearance (recorded or spread
 * evenly). `null` for a section no marker plays.
 */
export function chartLineTimeFor(
  doc: ChartDoc,
  links: readonly ChartLink[],
  timing: ChartTiming,
): (section: number, line: number) => number | null {
  const bySection = occurrencesBySection(links, timing);
  return (section, line) => {
    const first = bySection.get(section)?.[0];
    const lines = doc.sections[section]?.lines.length ?? 0;
    if (!first || line >= lines) return null;
    const starts = lineStartSeconds(lines, first.sectionSeconds, first.secondsPerBeat, first.link.lineBeats);
    return first.offset + starts[line];
  };
}

/** Line starts with the gaps (lines without a time) spread evenly between
 * the known ones, and never going backwards. */
function fillStarts(known: Array<number | null>, sectionSeconds: number): number[] {
  const starts = [...known];
  starts[0] = 0;
  for (let index = 1; index < starts.length; index += 1) {
    if (starts[index] !== null) continue;
    let end = index;
    while (end < starts.length && starts[end] === null) end += 1;
    const from = starts[index - 1] as number;
    const to = end < starts.length ? (starts[end] as number) : sectionSeconds;
    const step = (to - from) / (end - index + 1);
    for (let gap = index; gap < end; gap += 1) starts[gap] = from + step * (gap - index + 1);
    index = end - 1;
  }
  for (let index = 1; index < starts.length; index += 1) {
    starts[index] = Math.max(starts[index] as number, (starts[index - 1] as number) + 0.1);
  }
  return starts as number[];
}

/**
 * The links after the times typed in the editor text. A section whose times
 * are what the editor showed is left exactly as it was (recordings per marker
 * included). One that changed takes the new times, as offsets from the start
 * of the section, for every marker that plays it. No times at all for a
 * section means the even spread again.
 */
export function applyChartTimes(
  doc: ChartDoc,
  links: readonly ChartLink[],
  timing: ChartTiming,
  times: ChartLineTimes,
): ChartLink[] {
  const shown = chartLineTimeFor(doc, links, timing);
  const bySection = occurrencesBySection(links, timing);
  const replaced = new Map<string, ChartLink>();
  for (const [section, occurrences] of bySection) {
    const lines = doc.sections[section]?.lines.length ?? 0;
    if (lines === 0) continue;
    const typed = Array.from({ length: lines }, (_, line) => times.get(lineTimeKey(section, line)) ?? null);
    const unchanged = typed.every((value, line) => {
      const before = shown(section, line);
      return value === null ? doc.sections[section].lines[line].kind !== "lyrics" : before !== null && Math.abs(value - before) < 0.05;
    });
    if (unchanged) continue;
    const first = occurrences[0];
    const anyTyped = typed.some((value, line) => line > 0 && value !== null);
    const starts = anyTyped
      ? fillStarts(typed.map((value) => (value === null ? null : value - first.offset)), first.sectionSeconds)
      : null;
    for (const occurrence of occurrences) {
      const { lineBeats: _previous, ...rest } = occurrence.link;
      replaced.set(
        occurrence.link.markerId,
        starts
          ? { ...rest, lineBeats: starts.map((start) => Math.round((start / occurrence.secondsPerBeat) * 100) / 100) }
          : rest,
      );
    }
  }
  return links.map((link) => replaced.get(link.markerId) ?? link);
}
