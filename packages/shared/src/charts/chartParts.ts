import { markerCategory, type ChartLink, type MarkerKind, type SectionMarkerSummary, type SongChart } from "../models";

import { remapChartLinks } from "./chartSync";
import {
  parseChordPro,
  parseChordProWithPlaces,
  parseSectionHeader,
  serializeChordPro,
  type ChartDoc,
  type ChartLine,
} from "./chordChart";
import { normalizeChartLine, plainToSectionLines, sectionToPlain } from "./plainChart";
import { canonicalLabel, chartKind, isLyricless } from "./sectionVocab";

/**
 * What the simple lyrics editor decides, without UI: which parts of the song
 * to show, what each one says, and how the chart looks after editing one.
 *
 * A part is what the user writes once: the song's section markers, in order
 * and without repeats (two "Coro" markers are one part, sung the same). The
 * chart stays ChordPro (`SongChart.text`): editing a part rewrites only its
 * section, every other byte of the text stays as it was.
 */

export type ChartPart = {
  /** Stable while editing: the first marker's id, or the section's index for
   * parts that no marker uses. */
  key: string;
  label: string;
  kind: MarkerKind | null;
  /** The markers that show this part, in timeline order. */
  markerIds: string[];
  /** Times it sounds in the song (its markers; 1 without markers). */
  times: number;
  /** Its section in the chart, or `null` while it has no lyrics yet. */
  section: number | null;
  /** What the editor shows (`sectionToPlain`). */
  plain: string;
  /** Whether it is usually sung (an intro or a solo is not). */
  sung: boolean;
};

type Parsed = { doc: ChartDoc; starts: number[]; rows: string[] };

function parse(text: string): Parsed {
  const { doc, sectionStarts } = parseChordProWithPlaces(text);
  return { doc, starts: sectionStarts, rows: text.replace(/\r\n?/g, "\n").split("\n") };
}

/** What a marker names, as a grouping key: same kind and number = same part. */
function markerName(marker: SectionMarkerSummary): { key: string; kind: MarkerKind | null } {
  if (marker.kind && marker.kind !== "custom") {
    return { key: `${chartKind(marker.kind)}:${marker.variant ?? ""}`, kind: chartKind(marker.kind) };
  }
  const meaning = canonicalLabel(marker.name, "header");
  if (meaning) return { key: `${chartKind(meaning.kind)}:${meaning.number ?? ""}`, kind: chartKind(meaning.kind) };
  return { key: `name:${marker.name.trim().toLowerCase()}`, kind: null };
}

/** Original section markers only: arrangement repeats (`id~n`) and cues out. */
function originalMarkers(markers: readonly SectionMarkerSummary[]): SectionMarkerSummary[] {
  return markers
    .filter((marker) => !marker.id.includes("~") && markerCategory(marker) === "section")
    .sort((left, right) => left.startSeconds - right.startSeconds);
}

export function chartParts(chart: SongChart | null, markers: readonly SectionMarkerSummary[]): ChartPart[] {
  const doc = chart ? parseChordPro(chart.text) : null;
  const sections = doc?.sections ?? [];
  const links = chart?.links ?? [];
  const sectionOf = (markerId: string) => {
    const section = links.find((link) => link.markerId === markerId)?.section;
    return section !== undefined && section >= 0 && section < sections.length ? section : null;
  };
  const partFor = (section: number | null, base: Omit<ChartPart, "section" | "plain">): ChartPart => ({
    ...base,
    section,
    plain: section === null ? "" : sectionToPlain(sections[section]),
  });

  const songMarkers = originalMarkers(markers);
  if (songMarkers.length === 0) {
    return sections.map((section, index) =>
      partFor(index, {
        key: `s:${index}`,
        label: section.label,
        kind: section.kind,
        markerIds: [],
        times: 1,
        sung: !isLyricless(section.kind),
      }),
    );
  }

  // One part per marker, in timeline order, each with its own lyrics
  // (decided 2026-11-24: six bridges are six parts; the same words are copied
  // by hand). A sheet that links several markers to one section shows that
  // section in each, and editing one gives it its own (`applyPartEdit`).
  const parts = songMarkers.map((marker) => {
    const { kind } = markerName(marker);
    return partFor(sectionOf(marker.id), {
      key: `m:${marker.id}`,
      label: marker.name,
      kind,
      markerIds: [marker.id],
      times: 1,
      sung: !isLyricless(kind),
    });
  });
  // Sections no marker shows (an imported sheet with more parts than the
  // song) are still there to edit.
  const shown = new Set(parts.map((part) => part.section));
  sections.forEach((section, index) => {
    if (shown.has(index)) return;
    parts.push(
      partFor(index, {
        key: `s:${index}`,
        label: section.label,
        kind: section.kind,
        markerIds: [],
        times: 0,
        sung: !isLyricless(section.kind),
      }),
    );
  });
  return parts;
}

/** The raw rows a section takes: [from, to). The header row is `from` when the
 * section has one. */
function sectionSpan(parsed: Parsed, section: number): { from: number; to: number; header: boolean } {
  const from = parsed.starts[section];
  let to = parsed.starts[section + 1] ?? parsed.rows.length;
  // Blank rows before the next section are separation, not content.
  while (to > from + 1 && !parsed.rows[to - 1].trim()) to -= 1;
  return { from, to, header: parsed.doc.sections[section].label !== "" };
}

/** ChordPro rows of some chart lines, without a section header. */
function linesToRows(lines: ChartLine[]): string[] {
  if (lines.length === 0) return [];
  return serializeChordPro({ title: null, artist: null, key: null, sections: [{ label: "", kind: null, number: null, lines }] })
    .replace(/\n$/, "")
    .split("\n");
}

function joinRows(rows: string[], original: string): string {
  const text = rows.join("\n");
  return original.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text;
}

function sameLines(left: readonly ChartLine[], right: readonly ChartLine[]): boolean {
  return left.length === right.length && left.every((line, index) => normalizeChartLine(line) === normalizeChartLine(right[index]));
}

function appendSection(text: string, label: string, lines: ChartLine[]): string {
  const body = [`{section: ${label}}`, ...linesToRows(lines)].join("\n");
  if (!text.trim()) return `${body}\n`;
  const base = text.endsWith("\n") ? text : `${text}\n`;
  return `${base}\n${body}\n`;
}

/** The chart without one section; links to it go, the rest follow theirs. */
function dropSection(chart: SongChart, section: number): SongChart {
  const parsed = parse(chart.text);
  const { from, to } = sectionSpan(parsed, section);
  const rows = [...parsed.rows];
  let start = from;
  let end = to;
  if (section === parsed.doc.sections.length - 1) {
    // The last one takes its separating blank rows with it.
    while (start > 0 && !rows[start - 1].trim()) start -= 1;
    end = rows.length;
    while (end > to && rows[end - 1] === "") end -= 1;
  } else {
    while (end < rows.length && !rows[end].trim() && end < (parsed.starts[section + 1] ?? rows.length)) end += 1;
  }
  rows.splice(start, end - start);
  let text = joinRows(rows, chart.text);
  if (chart.text.endsWith("\n") && !text.endsWith("\n") && text) text += chart.text.includes("\r\n") ? "\r\n" : "\n";
  const before = parsed.doc;
  const after = parseChordPro(text);
  const kept = chart.links.filter((link) => link.section !== section);
  return { ...chart, text, links: remapChartLinks(before, after, kept) };
}

function withoutTimes(link: ChartLink): ChartLink {
  const { lineBeats: _, ...rest } = link;
  return rest;
}

/**
 * Writes one part. Only its section changes; a part without lyrics yet gets a
 * new section at the end, linked to its marker. A section other markers also
 * show is not touched: the part gets a section of its own with the new lyrics
 * (the others keep theirs). Recorded line times stay while the number of
 * lines does; otherwise this part's go (`clearedTimes`). An emptied part
 * loses its section, or only its link when others still show it.
 */
export function applyPartEdit(
  chart: SongChart | null,
  markers: readonly SectionMarkerSummary[],
  partKey: string,
  plain: string,
): { chart: SongChart | null; clearedTimes: boolean } {
  const part = chartParts(chart, markers).find((candidate) => candidate.key === partKey);
  if (!part) return { chart, clearedTimes: false };
  const lines = plainToSectionLines(plain);

  if (part.section === null) {
    if (lines.length === 0) return { chart, clearedTimes: false };
    const base: SongChart = chart ?? { text: "", links: [] };
    const text = appendSection(base.text, part.label, lines);
    const section = parseChordPro(text).sections.length - 1;
    const links = base.links.filter((link) => !part.markerIds.includes(link.markerId));
    for (const markerId of part.markerIds) links.push({ markerId, section });
    return { chart: { ...base, text, links }, clearedTimes: false };
  }

  const current = chart as SongChart;
  const parsed = parse(current.text);
  const old = parsed.doc.sections[part.section];
  if (sameLines(old.lines, lines)) return { chart: current, clearedTimes: false };
  const shared = current.links.some((link) => link.section === part.section && !part.markerIds.includes(link.markerId));
  if (shared) {
    const mine = current.links.filter((link) => part.markerIds.includes(link.markerId));
    const others = current.links.filter((link) => !part.markerIds.includes(link.markerId));
    if (lines.length === 0) return { chart: { ...current, links: others }, clearedTimes: false };
    const text = appendSection(current.text, part.label, lines);
    const section = parseChordPro(text).sections.length - 1;
    let clearedTimes = false;
    const relinked = mine.map((link) => {
      const moved = { ...link, section };
      if (old.lines.length === lines.length || !(link.lineBeats?.length)) return moved;
      clearedTimes = true;
      return withoutTimes(moved);
    });
    return { chart: { ...current, text, links: [...others, ...relinked] }, clearedTimes };
  }
  if (lines.length === 0) {
    const dropped = dropSection(current, part.section);
    const cleared = current.links.some((link) => link.section === part.section && (link.lineBeats?.length ?? 0) > 0);
    return { chart: dropped, clearedTimes: cleared };
  }

  const { from, to, header } = sectionSpan(parsed, part.section);
  const rows = [...parsed.rows];
  const keep = header ? 1 : 0;
  rows.splice(from + keep, to - from - keep, ...linesToRows(lines));
  const text = joinRows(rows, current.text);

  let clearedTimes = false;
  let links = current.links;
  if (old.lines.length !== lines.length) {
    links = links.map((link) => {
      if (link.section !== part.section || !(link.lineBeats?.length)) return link;
      clearedTimes = true;
      return withoutTimes(link);
    });
  }
  return { chart: { ...current, text, links }, clearedTimes };
}

/** Names for the quick buttons of a song without markers, in the sheet's
 * language. Each one reads back to its kind in the one vocabulary. */
export const QUICK_PART_NAMES: Record<"es" | "en", Partial<Record<MarkerKind, string>>> = {
  es: { intro: "Intro", verse: "Verso", pre_chorus: "Pre-coro", chorus: "Coro", bridge: "Puente", ending: "Final" },
  en: { intro: "Intro", verse: "Verse", pre_chorus: "Pre-chorus", chorus: "Chorus", bridge: "Bridge", ending: "Ending" },
};

/** Spanish sheet: accents or Spanish part names. Empty sheets use `fallback`. */
function sheetLanguage(doc: ChartDoc | null, fallback: "es" | "en"): "es" | "en" {
  if (!doc || doc.sections.length === 0) return fallback;
  const labels = doc.sections.map((section) => section.label.toLowerCase());
  if (labels.some((label) => /^(?:coro|verso|estrofa|puente|pre-?coro|final|estribillo)/.test(label))) return "es";
  if (labels.some((label) => /^(?:chorus|verse|bridge|pre-?chorus|outro)/.test(label))) return "en";
  return fallback;
}

/**
 * A new part for a song without markers: "Verso", then "Verso 2"… at the end
 * of the sheet, in the sheet's language.
 */
export function addPart(
  chart: SongChart | null,
  kind: MarkerKind,
  fallbackLanguage: "es" | "en" = "es",
  /** A name already written (a pasted block's header) instead of a quick one. */
  givenLabel?: string,
): { chart: SongChart; key: string } {
  const doc = chart ? parseChordPro(chart.text) : null;
  const language = sheetLanguage(doc, fallbackLanguage);
  const base = QUICK_PART_NAMES[language][kind] ?? QUICK_PART_NAMES.en[kind] ?? kind;
  const same = (doc?.sections ?? []).filter((section) => {
    const header = parseSectionHeader(section.label);
    return header && chartKind(header.kind ?? "custom") === chartKind(kind);
  }).length;
  const label = givenLabel?.trim() || (same === 0 ? base : `${base} ${same + 1}`);
  const current: SongChart = chart ?? { text: "", links: [] };
  const text = appendSection(current.text, label, []);
  const index = parseChordPro(text).sections.length - 1;
  return { chart: { ...current, text }, key: `s:${index}` };
}

/**
 * One row per section marker of the song, in timeline order, as the simple
 * editor lists them (decided 2026-11-24: "×5" on one row did not say where
 * each one goes). Markers with the same name still share their lyrics: the
 * row edits its part (`partKey`), and `appearance` / `times` say which time
 * of that part it is. A song without markers lists its parts.
 */
export type ChartPartEntry = {
  /** Stable selection key: the marker's id (or the part's key without markers). */
  key: string;
  /** The part it edits (`applyPartEdit`). */
  partKey: string;
  markerId: string | null;
  label: string;
  /** 1-based position in the song. */
  position: number;
  /** Which time of its part this is (1-based) out of `times`. */
  appearance: number;
  times: number;
  section: number | null;
  sung: boolean;
};

export function chartPartEntries(parts: readonly ChartPart[], markers: readonly SectionMarkerSummary[]): ChartPartEntry[] {
  const songMarkers = originalMarkers(markers);
  const byMarker = new Map<string, ChartPart>();
  for (const part of parts) for (const id of part.markerIds) byMarker.set(id, part);
  const entries: ChartPartEntry[] = [];
  for (const marker of songMarkers) {
    const part = byMarker.get(marker.id);
    if (!part) continue;
    entries.push({
      key: marker.id,
      partKey: part.key,
      markerId: marker.id,
      label: marker.name,
      position: entries.length + 1,
      appearance: part.markerIds.indexOf(marker.id) + 1,
      times: part.markerIds.length,
      section: part.section,
      sung: part.sung,
    });
  }
  // Sections no marker shows (or every part, without markers).
  for (const part of parts) {
    if (part.markerIds.length > 0) continue;
    entries.push({
      key: part.key,
      partKey: part.key,
      markerId: null,
      label: part.label,
      position: entries.length + 1,
      appearance: 1,
      times: 1,
      section: part.section,
      sung: part.sung,
    });
  }
  return entries;
}
