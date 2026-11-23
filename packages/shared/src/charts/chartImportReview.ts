import {
  getEffectiveBpmAt,
  getSongBaseTimeSignature,
  type SectionMarkerSummary,
  type SongChart,
  type SongView,
} from "../models";
import { parseTimeSignature } from "../timelineMath";

import { matchChartToMarkers, type ChartMatch, type MatchConfidence, type MatchReason } from "./chartMatch";
import { chartLinkFor, chartLinkMarkerId } from "./chartSync";
import { parseChordPro, serializeChordPro, transposeChart, type ChartDoc, type ChartSection } from "./chordChart";
import { keyPrefersFlats, keySemitonesBetween } from "./chordNotation";
import { chartTextHash, normalizeImportedChart, type ImportedChart, type SheetChange } from "./importedChart";
import { isLyricless } from "./sectionVocab";

/**
 * The review of an import (D14), as data: the song marker by marker with what
 * will sound at each one, before anything is saved. Pure, so every view and
 * the tests share it; the dialog only draws it.
 */
export type ReviewRow = {
  markerId: string;
  name: string;
  /** An arrangement repeat (`id~n`): follows its original, not editable. */
  repeatOf: string | null;
  section: number | null;
  confidence: MatchConfidence;
  reason: MatchReason;
  /** First line of words (or of the section) for the chosen section. */
  firstLine: string | null;
  /** Times the section plays inside this marker (from its length). */
  passes: number;
};

export type ImportReview = {
  imported: ImportedChart;
  /** The cleaned ChordPro, in the source's key. */
  text: string;
  doc: ChartDoc;
  sequence: string[] | undefined;
  /** Repeats read from the source's marks, for the matcher (not saved). */
  repeats: number[] | undefined;
  /** What the cleanup changes in the sheet, shown before applying. */
  changes: SheetChange[];
  match: ChartMatch;
  locked: ReadonlyArray<{ markerId: string; section: number | null }>;
  rows: ReviewRow[];
  /** A sung marker was left without a section. */
  hasMissing: boolean;
  noMarkers: boolean;
  key: { source: string | null; song: string | null; semitones: number | null };
  /** Recorded line times to keep, by marker: set by an update (08) for the
   * links whose section has the same lines as before. Used only while the
   * marker still shows that section. */
  keepLineBeats?: Readonly<Record<string, { section: number; lineBeats: number[] }>>;
  /** How long each marker lasts, to tell a chorus sung twice in one marker. */
  timing: ReviewTiming | null;
  /** Passes the user set by hand, by original marker id. */
  passOverrides: Readonly<Record<string, number>>;
  /** Passes per original marker (estimated, or the user's). */
  passes: Readonly<Record<string, number>>;
};

export type ReviewTiming = {
  regionEndSeconds: number;
  /** Seconds per beat at a song position; without it, plain seconds (fine
   * while the tempo does not change). */
  secondsPerBeatAt?: (seconds: number) => number;
  /** Beats per bar at a song position (the meter), to count bars. */
  beatsPerBarAt?: (seconds: number) => number;
};

/**
 * How many times each marker's section plays inside it.
 *
 * With the song's tempo and meter (bars), a pass of a section lasts about one
 * bar per line of words: a 4-line chorus between Planning Center's "// … //"
 * in an 8-bar marker plays twice, in a 4-bar marker once, and never more
 * times than the sheet says. Without bars, the sheet's count is shared by the
 * section's markers by length (a 4x chorus split in two equal markers is
 * 2 + 2). Without a count in the sheet, only a marker clearly twice as long
 * as the shortest of its section plays twice.
 */
export function estimatePasses(
  markers: readonly SectionMarkerSummary[],
  links: readonly { markerId: string; section: number }[],
  timing: ReviewTiming | null,
  repeats: readonly number[] | undefined,
  lyricLines: readonly number[] = [],
): Record<string, number> {
  const passes: Record<string, number> = {};
  if (!timing) return passes;
  const beats = new Map<string, number>();
  const bars = new Map<string, number>();
  const barSeconds = new Map<string, number>();
  markers.forEach((marker, index) => {
    if (marker.id.includes("~")) return;
    const end = markers[index + 1]?.startSeconds ?? timing.regionEndSeconds;
    const seconds = Math.max(0, end - marker.startSeconds);
    const perBeat = timing.secondsPerBeatAt?.(marker.startSeconds) ?? 1;
    const length = perBeat > 0 ? seconds / perBeat : seconds;
    beats.set(marker.id, length);
    const perBar = timing.secondsPerBeatAt ? timing.beatsPerBarAt?.(marker.startSeconds) : undefined;
    if (perBar && perBar > 0) {
      bars.set(marker.id, length / perBar);
      barSeconds.set(marker.id, perBeat * perBar);
    }
  });
  const bySection = new Map<number, Array<{ markerId: string; length: number }>>();
  for (const link of links) {
    const value = beats.get(link.markerId);
    if (!value) continue;
    bySection.set(link.section, [...(bySection.get(link.section) ?? []), { markerId: link.markerId, length: value }]);
  }
  for (const [section, entries] of bySection) {
    const sheet = repeats?.[section] ?? 1;
    const lines = lyricLines[section] ?? 0;
    // A part without words (an intro of chords) keeps the sheet's count,
    // shared by its markers, so it goes back to Planning Center as written
    // ("INTRO ////"); Live shows it once all the same (see chartSync).
    const measured = lines > 0 && sheet > 1 && entries.every((entry) => bars.has(entry.markerId));
    if (measured) {
      // A sung line lasts about 3.5 s, rounded to whole bars: one bar at a
      // slow tempo (Digno, 67 BPM), two at a fast one (138 BPM). One pass is
      // that times the section's lines; the marker's bars say how many fit.
      // Not capped by the sheet's count: "////" on a bridge played in three
      // long markers is 2 + 2 + 2.
      for (const entry of entries) {
        const lineBars = Math.max(1, Math.round(SECONDS_PER_LINE / barSeconds.get(entry.markerId)!));
        const times = Math.min(8, Math.max(1, Math.round(bars.get(entry.markerId)! / (lines * lineBars))));
        if (times >= 2) passes[entry.markerId] = times;
      }
      continue;
    }
    const total = entries.reduce((sum, entry) => sum + entry.length, 0);
    const pass = sheet > 1 ? total / sheet : Math.min(...entries.map((entry) => entry.length));
    if (!(pass > 0)) continue;
    for (const entry of entries) {
      const ratio = entry.length / pass;
      const times = sheet > 1 ? Math.round(ratio) : lines > 0 && ratio >= 1.8 ? Math.round(ratio) : 1;
      if (times >= 2) passes[entry.markerId] = Math.min(8, times);
    }
  }
  return passes;
}

/** How long a sung line lasts, about: the unit of a pass. */
const SECONDS_PER_LINE = 3.5;

/** Lines with words of each section (chord-only lines do not count). */
function lyricLineCounts(doc: ChartDoc): number[] {
  return doc.sections.map(
    (section) =>
      section.lines.filter(
        (line) => line.kind === "lyrics" && line.segments.some((segment) => /\p{L}{2}/u.test(segment.text)),
      ).length,
  );
}

/** The timing of a song, for `estimatePasses`: its tempo and meter at each
 * position (time-signature markers included). */
export function reviewTimingForSong(
  song: SongView | null | undefined,
  region: { endSeconds: number },
): ReviewTiming {
  const signatures = [...(song?.timeSignatureMarkers ?? [])].sort((left, right) => left.startSeconds - right.startSeconds);
  return {
    regionEndSeconds: region.endSeconds,
    secondsPerBeatAt: (seconds) => 60 / Math.max(1, getEffectiveBpmAt(song, seconds)),
    beatsPerBarAt: (seconds) => {
      let signature = getSongBaseTimeSignature(song);
      for (const marker of signatures) {
        if (marker.startSeconds <= seconds + 0.001) signature = marker.signature;
        else break;
      }
      return parseTimeSignature(signature).beatsPerBar;
    },
  };
}

function firstLine(section: ChartSection | undefined): string | null {
  if (!section) return null;
  for (const line of section.lines) {
    const text = line.kind === "lyrics" ? line.segments.map((segment) => segment.text).join("") : line.text;
    if (/\p{L}/u.test(text)) return text.trim();
  }
  const any = section.lines[0];
  if (!any) return null;
  return (any.kind === "lyrics" ? any.segments.map((segment) => segment.chord ?? segment.text).join(" ") : any.text).trim() || null;
}

function rowsFor(
  doc: ChartDoc,
  match: ChartMatch,
  markers: readonly SectionMarkerSummary[],
  passes: Readonly<Record<string, number>>,
): ReviewRow[] {
  const items = new Map(match.items.map((item) => [item.markerId, item]));
  return markers.map((marker) => {
    const original = chartLinkMarkerId(marker.id);
    const item = items.get(original);
    const section = chartLinkFor(match.links, marker.id)?.section ?? null;
    return {
      markerId: marker.id,
      name: marker.name,
      repeatOf: original === marker.id ? null : original,
      section,
      confidence: item?.confidence ?? "low",
      reason: item?.reason ?? "missing",
      firstLine: section === null ? null : firstLine(doc.sections[section]),
      passes: section === null ? 1 : (passes[original] ?? 1),
    };
  });
}

function lyricMarker(marker: SectionMarkerSummary): boolean {
  return !isLyricless(marker.kind);
}

/** Match again around what the user fixed; the cleaned sheet stays. */
export function relinkImportReview(
  review: ImportReview,
  markers: readonly SectionMarkerSummary[],
  locked: ReadonlyArray<{ markerId: string; section: number | null }>,
  passOverrides: Readonly<Record<string, number>> = review.passOverrides,
): ImportReview {
  const match = matchChartToMarkers(review.doc, markers, {
    sourceSequence: review.sequence,
    locked,
    sectionRepeats: review.repeats,
  });
  const passes = {
    ...estimatePasses(markers, match.links, review.timing, review.repeats, lyricLineCounts(review.doc)),
    ...passOverrides,
  };
  const rows = rowsFor(review.doc, match, markers, passes);
  const byId = new Map(markers.map((marker) => [marker.id, marker]));
  return {
    ...review,
    match,
    locked,
    passOverrides,
    passes,
    rows,
    hasMissing: rows.some((row) => row.section === null && row.reason === "missing" && lyricMarker(byId.get(row.markerId)!)),
  };
}

/**
 * Clean the imported chart (D9) and match it to the song's section markers
 * (in timeline order, repeats included) with the source's sequence as a hint.
 */
export function buildImportReview(
  imported: ImportedChart,
  markers: readonly SectionMarkerSummary[],
  songKey: string | null,
  locked: ReadonlyArray<{ markerId: string; section: number | null }> = [],
  timing: ReviewTiming | null = null,
  passOverrides: Readonly<Record<string, number>> = {},
): ImportReview {
  const normalized = normalizeImportedChart(imported);
  const doc = parseChordPro(normalized.text);
  const source = imported.key ?? doc.key ?? null;
  const base: ImportReview = {
    imported,
    text: normalized.text,
    doc,
    sequence: normalized.sequence,
    repeats: normalized.repeats,
    changes: normalized.changes,
    match: { links: [], items: [], unusedSections: [] },
    locked,
    rows: [],
    hasMissing: false,
    noMarkers: markers.length === 0,
    key: { source, song: songKey, semitones: songKey ? keySemitonesBetween(source, songKey) : null },
    timing,
    passOverrides,
    passes: {},
  };
  return relinkImportReview(base, markers, locked, passOverrides);
}

/**
 * The chart to save. Transposed to the song's key when asked and the keys
 * differ (D11); the links follow the review, or none ("import without
 * linking"); the source remembers where it came from and the saved text's
 * fingerprint (D12).
 */
export function finalizeImport(review: ImportReview, options: { transpose: boolean; linked: boolean }): SongChart {
  const semitones = options.transpose ? (review.key.semitones ?? 0) : 0;
  // The text says which key it is in ({key: D}): adjusting it again later
  // starts from that key, never from the source's, so it is not moved twice.
  const keyNow = semitones ? review.key.song : review.key.source;
  const doc = semitones ? transposeChart(review.doc, semitones, keyPrefersFlats(review.key.song)) : review.doc;
  const text = keyNow && doc.key !== keyNow ? serializeChordPro({ ...doc, key: keyNow }) : semitones ? serializeChordPro(doc) : review.text;
  const source = review.imported.source;
  return {
    text,
    links: options.linked
      ? review.match.links.map((link) => {
          const kept = review.keepLineBeats?.[link.markerId];
          const passes = review.passes[link.markerId] ?? 1;
          const withPasses = passes > 1 ? { ...link, repeat: passes } : link;
          return kept && kept.section === link.section ? { ...withPasses, lineBeats: kept.lineBeats } : withPasses;
        })
      : [],
    ...(source ? { source: { ...source, importedHash: chartTextHash(text) } } : {}),
  };
}

/**
 * A review clear enough to apply without looking (D13): every sung marker has
 * a section with high confidence. Played markers may stay without one.
 */
export function isClearReview(review: ImportReview): boolean {
  if (review.noMarkers || review.hasMissing) return false;
  return review.match.items.every((item) => item.confidence === "high" && item.reason !== "missing");
}
