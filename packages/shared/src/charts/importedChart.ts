import type { ChartSource } from "../models";

import { chordProFromText, looksLikeChordPro } from "./chartImport";
import { isChord, isChordLineFiller } from "./chordNotation";
import {
  parseChordPro,
  parseSectionHeader,
  sectionRepeat,
  serializeChordPro,
  type ChartLine,
  type ChartSection,
} from "./chordChart";
import { sectionFamily, vocabTokens } from "./sectionVocab";

/**
 * What every chart source delivers (D8): the matcher never knows where a
 * chart came from. `text` is ChordPro; `sequence` is the source's order as it
 * labels it ("Verse 1", "C", "Coro 1"), a hint for `matchChartToMarkers`.
 */
export type ImportedChart = {
  title: string;
  artist?: string | null;
  key?: string | null;
  bpm?: number | null;
  meter?: string | null;
  text: string;
  sequence?: string[];
  /** Filled by the source; `importedHash` is set when the chart is saved. */
  source?: Omit<ChartSource, "importedHash">;
};

/** A chart that cannot be imported, as a code the UI translates. */
export class ChartImportError extends Error {
  constructor(readonly code: "noText") {
    super(code);
    this.name = "ChartImportError";
  }
}

/** Planning Center's page and column marks, never part of the song. */
const LAYOUT_MARK = /^\s*(?:COLUMN_BREAK|PAGE_BREAK)\s*$/i;

/** "(Repetir coro)", "Repeat Chorus x2", "(Se repite el estribillo)". */
const REPEAT_INSTRUCTION =
  /^\(?\s*(?:se\s+)?(?:repetir|repite|repetimos|repeat|rep\.?)\s+(?:(?:el|la|the)\s+)?(.+?)\s*\)?\s*$/i;

function repeatCount(text: string): number {
  const match = /\bx\s?(\d)\b|\b(\d)\s?x\b/i.exec(text);
  const count = Number(match?.[1] ?? match?.[2] ?? 1);
  return count >= 1 && count <= 8 ? count : 1;
}

function stripLayoutMarks(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !LAYOUT_MARK.test(line))
    .join("\n");
}

function lineText(line: ChartLine): string {
  if (line.kind === "lyrics") return line.segments.map((segment) => segment.text).join("").trim();
  return line.text.trim();
}

/** The section a reference ("CORO", "Repeat Chorus") names, as a header. */
function referenceMeaning(label: string) {
  const header = parseSectionHeader(label);
  return header?.kind ? { family: sectionFamily(header.kind), number: header.number } : null;
}

function sameSection(left: ChartSection, right: ChartSection): boolean {
  if (left.kind && right.kind) {
    return sectionFamily(left.kind) === sectionFamily(right.kind) && left.number === right.number;
  }
  return vocabTokens(left.label).join(" ") === vocabTokens(right.label).join(" ");
}

/**
 * The chart as it should reach the matcher (D9):
 * - an empty header whose part was already written ("CORO" after a written
 *   chorus) is a reference, not a section;
 * - "(Repetir coro)", "Repeat Chorus x2" lines are references too;
 * - a section written twice with the same label and words is kept once;
 * - an empty header right before one of the same part (`{soc}` then
 *   "CHORUS") is dropped;
 * - Planning Center's COLUMN_BREAK and PAGE_BREAK go.
 *
 * References and merged copies become the implicit sequence, unless the
 * source sent its own (which wins). Without any, there is no sequence: the
 * written order of a sheet is not a sequence.
 */
/** "INTRO  E  C#m  A   B" (Planning Center's header with the chords on the
 * same line) → the header, and the chords as a line of their own. */
function splitHeaderWithChords(text: string): string {
  return text
    .split("\n")
    .flatMap((line) => {
      if (/[[{]/.test(line) || !line.trim()) return [line];
      const tokens = line.trim().split(/\s+/);
      for (let size = Math.min(3, tokens.length - 1); size >= 1; size -= 1) {
        const header = tokens.slice(0, size).join(" ");
        const rest = tokens.slice(size);
        const chords = rest.every((token) => isChord(token) || isChordLineFiller(token)) && rest.some(isChord);
        if (chords && parseSectionHeader(header)) {
          return [header, rest.map((token) => (isChord(token) ? `[${token}]` : token)).join(" ")];
        }
      }
      return [line];
    })
    .join("\n");
}

const OPEN_MARK = /^\s*(\/{2,})\s*/;
const CLOSE_MARK = /\s*(\/{2,})\s*$/;

/**
 * Planning Center's repeat marks: "// line … line //" is played twice, "///"
 * three times. The slashes go (they are not words) and nothing is written in
 * their place: whether a part is sung twice depends on the song's markers
 * (one long Coro marker, or two), not on the sheet. A whole section between
 * marks, or a header ending in them ("INTRO //"), reports how many times, so
 * the matcher may let two markers in a row stay on it.
 */
function foldRepeatMarks(section: ChartSection): { section: ChartSection; repeat: number } {
  const bare = section.label.replace(/\s*(\/{2,})\s*$/, "");
  const headerMarks = /(\/{2,})\s*$/.exec(section.label)?.[1].length ?? 0;
  const label = parseSectionHeader(bare)?.label ?? bare;
  const lines = section.lines.map((line) =>
    line.kind === "lyrics" ? { ...line, segments: line.segments.map((segment) => ({ ...segment })) } : line,
  );
  const lyricIndexes = lines.flatMap((line, index) =>
    line.kind === "lyrics" && line.segments.some((segment) => segment.text.trim()) ? [index] : [],
  );
  let open: { line: number; count: number } | null = null;
  const blocks: Array<{ from: number; to: number; count: number }> = [];
  for (const index of lyricIndexes) {
    const line = lines[index];
    if (line.kind !== "lyrics") continue;
    const first = line.segments.find((segment) => segment.text.trim());
    const opening = first ? OPEN_MARK.exec(first.text) : null;
    if (first && opening) {
      first.text = first.text.slice(opening[0].length);
      open = { line: index, count: opening[1].length };
    }
    const last = [...line.segments].reverse().find((segment) => segment.text.trim());
    const closing = last ? CLOSE_MARK.exec(last.text) : null;
    if (last && closing) {
      last.text = last.text.slice(0, closing.index);
      blocks.push({ from: open?.line ?? index, to: index, count: open?.count ?? closing[1].length });
      open = null;
    }
  }
  if (open) blocks.push({ from: open.line, to: open.line, count: open.count });
  const whole =
    blocks.length === 1 && blocks[0].from === lyricIndexes[0] && blocks[0].to === lyricIndexes[lyricIndexes.length - 1];
  const repeat = Math.max(headerMarks, whole ? blocks[0].count : 1, sectionRepeat(label));
  return { section: { ...section, label, lines }, repeat };
}

export function normalizeImportedChart(chart: ImportedChart): {
  text: string;
  sequence?: string[];
  /** Times each section of `text` is played in a row, when the sheet says
   * (Planning Center's "// … //"). Import-time only: not stored. */
  repeats?: number[];
} {
  const doc = parseChordPro(splitHeaderWithChords(stripLayoutMarks(chart.text)));
  const folded = doc.sections.map(foldRepeatMarks);
  const repeatOf = new Map(folded.map(({ section, repeat }) => [section, repeat] as const));
  doc.sections = folded.map(({ section }) => section);
  const kept: ChartSection[] = [];
  const keptRepeats: number[] = [];
  const implicit: string[] = [];
  let referenced = false;

  const findKept = (meaning: { family: string | null; number: number | null }) => {
    const sameFamily = kept.filter((section) => sectionFamily(section.kind) === meaning.family);
    const exact = sameFamily.filter((section) => section.number === meaning.number);
    return (exact.length > 0 ? exact : sameFamily).at(-1) ?? null;
  };
  const refer = (label: string, count: number) => {
    const meaning = referenceMeaning(label);
    const target = meaning ? findKept(meaning) : null;
    if (!target) return false;
    for (let time = 0; time < count; time += 1) implicit.push(target.label);
    referenced = true;
    return true;
  };

  doc.sections.forEach((section, index) => {
    const instructions: Array<{ label: string; count: number }> = [];
    const lines = section.lines.filter((line) => {
      const match = line.kind !== "tab" ? REPEAT_INSTRUCTION.exec(lineText(line)) : null;
      if (!match || !referenceMeaning(match[1].replace(/\s*\(?\s*(?:x\s?\d|\d\s?x)\s*\)?\s*$/i, ""))) return true;
      instructions.push({ label: match[1].replace(/\s*\(?\s*(?:x\s?\d|\d\s?x)\s*\)?\s*$/i, ""), count: repeatCount(match[1]) });
      return false;
    });
    // The label was tidied by `foldRepeatMarks` ("VERSE 1" → "Verse 1").
    const cleaned: ChartSection = { ...section, lines };
    const next = doc.sections[index + 1];

    if (cleaned.lines.length === 0 && cleaned.label) {
      if (next && next.lines.length > 0 && sameSection(cleaned, next)) {
        // `{soc}` followed by its own "CHORUS" header.
      } else if (!refer(cleaned.label, repeatCount(cleaned.label))) {
        kept.push(cleaned);
        keptRepeats.push(repeatOf.get(section) ?? 1);
        implicit.push(cleaned.label);
      }
    } else {
      const twin = kept.find(
        (candidate) => sameSection(candidate, cleaned) && JSON.stringify(candidate.lines) === JSON.stringify(cleaned.lines),
      );
      if (twin) {
        implicit.push(twin.label);
        referenced = true;
      } else if (cleaned.label || cleaned.lines.length > 0) {
        kept.push(cleaned);
        keptRepeats.push(repeatOf.get(section) ?? 1);
        implicit.push(cleaned.label);
      }
    }
    for (const instruction of instructions) refer(instruction.label, instruction.count);
  });

  const text = serializeChordPro({ ...doc, sections: kept });
  const sequence = chart.sequence?.length ? chart.sequence : referenced ? implicit : undefined;
  const repeats = keptRepeats.some((count) => count > 1) ? keptRepeats : undefined;
  return { text, ...(sequence ? { sequence } : {}), ...(repeats ? { repeats } : {}) };
}

/** One item of a Planning Center sequence (`sequence_full`): the number comes
 * as text ("1"), and is "1" even when the label had none. */
export type PcoSequenceEntry = { label: string; number?: string | number | null };

/** The attributes of a Planning Center arrangement the import reads, as
 * `libretracks-pco` hands them over (camelCase). */
export type PcoArrangement = {
  id: string;
  songId: string;
  songTitle?: string | null;
  songAuthor?: string | null;
  name?: string | null;
  chordChart?: string | null;
  chordChartKey?: string | null;
  lyrics?: string | null;
  sequence?: string[] | null;
  sequenceFull?: PcoSequenceEntry[] | null;
  bpm?: number | null;
  meter?: string | null;
  updatedAt?: string | null;
};

/** A song item of a Planning Center plan. */
export type PcoPlanItem = {
  id: string;
  title?: string | null;
  songId?: string | null;
  arrangementId?: string | null;
  /** The service's key ("Tono E" → "E"); `null` without one. */
  keyName?: string | null;
  customArrangementSequenceFull?: PcoSequenceEntry[] | null;
};

function sequenceLabels(entries: readonly PcoSequenceEntry[] | null | undefined): string[] | undefined {
  if (!entries?.length) return undefined;
  return entries.map((entry) => {
    const number = entry.number === null || entry.number === undefined ? "" : String(entry.number).trim();
    return number ? `${entry.label} ${number}` : entry.label;
  });
}

/**
 * A Planning Center arrangement (and the plan item, when it comes from a plan)
 * as an `ImportedChart`. The chart text is read with our parser, never
 * Planning Center's `/sections` or `has_chords` (see spike-results.md): ChordPro
 * as it is, chords over lyrics (any notation) through the sheet analyser.
 * Only `lyrics` when there is no chart; neither → `noText`. The item's own
 * sequence and key win over the arrangement's.
 */
export function planningCenterToImported(arrangement: PcoArrangement, item?: PcoPlanItem | null): ImportedChart {
  const chordChart = stripLayoutMarks(arrangement.chordChart ?? "").trim();
  const lyrics = stripLayoutMarks(arrangement.lyrics ?? "").trim();
  const raw = chordChart || lyrics;
  if (!raw) throw new ChartImportError("noText");
  const text = looksLikeChordPro(raw) ? raw : chordProFromText(raw);
  const key = item?.keyName?.trim() || arrangement.chordChartKey?.trim() || null;
  const sequence = sequenceLabels(item?.customArrangementSequenceFull) ?? sequenceLabels(arrangement.sequenceFull);
  return {
    title: arrangement.songTitle?.trim() || item?.title?.trim() || "",
    artist: arrangement.songAuthor ?? null,
    key,
    bpm: arrangement.bpm ?? null,
    meter: arrangement.meter ?? null,
    text,
    ...(sequence ? { sequence } : {}),
    source: {
      provider: "planningCenter",
      songId: arrangement.songId,
      arrangementId: arrangement.id,
      ...(item?.id ? { planItemId: item.id } : {}),
      ...(key ? { key } : {}),
      ...(arrangement.updatedAt ? { updatedAt: arrangement.updatedAt } : {}),
    },
  };
}

/**
 * A stable fingerprint of a chart's text (FNV-1a over the UTF-16 units, line
 * endings normalized, plus the length): `source.importedHash`. Only TS needs
 * it, so Rust stores it as an opaque string.
 */
export function chartTextHash(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}:${normalized.length}`;
}
