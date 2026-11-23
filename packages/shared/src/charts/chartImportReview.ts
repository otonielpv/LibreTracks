import type { SectionMarkerSummary, SongChart } from "../models";

import { matchChartToMarkers, type ChartMatch, type MatchConfidence, type MatchReason } from "./chartMatch";
import { chartLinkFor, chartLinkMarkerId } from "./chartSync";
import { parseChordPro, serializeChordPro, transposeChart, type ChartDoc, type ChartSection } from "./chordChart";
import { keyPrefersFlats, keySemitonesBetween } from "./chordNotation";
import { chartTextHash, normalizeImportedChart, type ImportedChart } from "./importedChart";
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
};

export type ImportReview = {
  imported: ImportedChart;
  /** The cleaned ChordPro, in the source's key. */
  text: string;
  doc: ChartDoc;
  sequence: string[] | undefined;
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
};

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

function rowsFor(doc: ChartDoc, match: ChartMatch, markers: readonly SectionMarkerSummary[]): ReviewRow[] {
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
): ImportReview {
  const match = matchChartToMarkers(review.doc, markers, { sourceSequence: review.sequence, locked });
  const rows = rowsFor(review.doc, match, markers);
  const byId = new Map(markers.map((marker) => [marker.id, marker]));
  return {
    ...review,
    match,
    locked,
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
): ImportReview {
  const normalized = normalizeImportedChart(imported);
  const doc = parseChordPro(normalized.text);
  const source = imported.key ?? doc.key ?? null;
  const base: ImportReview = {
    imported,
    text: normalized.text,
    doc,
    sequence: normalized.sequence,
    match: { links: [], items: [], unusedSections: [] },
    locked,
    rows: [],
    hasMissing: false,
    noMarkers: markers.length === 0,
    key: { source, song: songKey, semitones: songKey ? keySemitonesBetween(source, songKey) : null },
  };
  return relinkImportReview(base, markers, locked);
}

/**
 * The chart to save. Transposed to the song's key when asked and the keys
 * differ (D11); the links follow the review, or none ("import without
 * linking"); the source remembers where it came from and the saved text's
 * fingerprint (D12).
 */
export function finalizeImport(review: ImportReview, options: { transpose: boolean; linked: boolean }): SongChart {
  const semitones = options.transpose ? (review.key.semitones ?? 0) : 0;
  const text = semitones
    ? serializeChordPro(transposeChart(review.doc, semitones, keyPrefersFlats(review.key.song)))
    : review.text;
  const source = review.imported.source;
  return {
    text,
    links: options.linked
      ? review.match.links.map((link) => {
          const kept = review.keepLineBeats?.[link.markerId];
          return kept && kept.section === link.section ? { ...link, lineBeats: kept.lineBeats } : link;
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
