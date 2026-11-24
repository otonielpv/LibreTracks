import type { MarkerKind, SectionMarkerSummary, SongChart } from "../models";

import { looksLikeChordPro, splitSectionHeaderLines } from "./chartImport";
import { matchChartToMarkers, type MatchConfidence } from "./chartMatch";
import { addPart, applyPartEdit, type ChartPart } from "./chartParts";
import { parseChordPro, parseSectionHeader, type ChartDoc, type ChartLine } from "./chordChart";
import { plainToSectionLines, sectionToPlain } from "./plainChart";
import { chartKind } from "./sectionVocab";

/**
 * "Paste the whole song": what was pasted, cut into blocks, each one already
 * proposed for the sections of the song where it goes, for the user to check
 * before applying.
 *
 * Blocks are cut at recognised headers ("CORO", "Verso 2:", "[Puente]",
 * "////// Puente //////", "Puente x6"); with no header at all, at blank lines
 * (one or more), the way Holyrics reads a song. Each block is read like one
 * section of the simple editor (`plainToSectionLines`).
 *
 * Every section has its own lyrics, so a block written once in the paste
 * ("Puente") is COPIED to every section it fits (the six bridges of the song).
 */

export type PastedBlock = {
  /** The header it had, if any. */
  label: string | null;
  kind: MarkerKind | null;
  number: number | null;
  lines: ChartLine[];
  /** As the editor shows it, for the preview. */
  plain: string;
};

export type PasteAssignment = {
  block: number;
  /** The sections (parts) it is copied to, in song order; empty = a new one. */
  partKeys: string[];
  confidence: MatchConfidence;
};

function block(label: string | null, lines: ChartLine[]): PastedBlock {
  const header = label ? parseSectionHeader(label) : null;
  return { label, kind: header?.kind ?? null, number: header?.number ?? null, lines, plain: sectionToPlain({ lines }) };
}

/** A header line with repeat marks around it: "////// Puente //////". */
function headerOf(row: string) {
  const bare = row.replace(/^[\s/|]+|[\s/|]+$/g, "");
  return bare ? parseSectionHeader(bare) : null;
}

export function splitPastedSong(text: string): PastedBlock[] {
  const source = text.replace(/\r\n?/g, "\n");
  if (looksLikeChordPro(source)) {
    // ChordPro sections are already the blocks.
    return parseChordPro(source)
      .sections.filter((section) => section.lines.length > 0)
      .map((section) => block(section.label || null, section.lines));
  }
  const rows = splitSectionHeaderLines(source, false).split("\n");
  const hasHeaders = rows.some((row) => headerOf(row) !== null);
  const blocks: PastedBlock[] = [];
  let label: string | null = null;
  let chunk: string[] = [];
  const flush = () => {
    const lines = plainToSectionLines(chunk.join("\n"));
    if (lines.length > 0) blocks.push(block(label, lines));
    chunk = [];
  };
  for (const row of rows) {
    const header = hasHeaders ? headerOf(row) : null;
    if (header) {
      flush();
      label = header.label;
    } else if (!hasHeaders && !row.trim()) {
      flush();
    } else {
      chunk.push(row);
    }
  }
  flush();
  return blocks;
}

/** The words of a block, for telling a repeated chorus. */
function words(lines: readonly ChartLine[]): string[] {
  return lines
    .flatMap((line) => (line.kind === "lyrics" ? line.segments.map((segment) => segment.text) : []))
    .join(" ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9ñ]+/)
    .filter(Boolean);
}

function similar(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const a = new Set(left);
  const b = new Set(right);
  const shared = [...a].filter((word) => b.has(word)).length;
  return shared / new Set([...a, ...b]).size >= 0.7;
}

/** Same kind and number = the same name ("Puente" six times). */
function nameKey(part: ChartPart): string {
  const header = parseSectionHeader(part.label);
  const kind = part.kind ?? (header?.kind ? chartKind(header.kind) : null);
  return kind ? `${kind}:${header?.number ?? ""}` : `name:${part.label.trim().toLowerCase()}`;
}

export function proposePasteAssignment(
  blocks: readonly PastedBlock[],
  parts: readonly ChartPart[],
  markers: readonly SectionMarkerSummary[],
): PasteAssignment[] {
  const withHeaders = blocks.some((entry) => entry.label !== null);
  const songParts = parts.filter((part) => part.markerIds.length > 0);

  if (withHeaders && songParts.length > 0) {
    // The one matcher, with the pasted headers as the source's sequence: each
    // marker gets a block, and a block goes to every marker that got it.
    const doc: ChartDoc = {
      title: null,
      artist: null,
      key: null,
      sections: blocks.map((entry) => ({ label: entry.label ?? "", kind: entry.kind, number: entry.number, lines: entry.lines })),
    };
    const match = matchChartToMarkers(doc, markers, { sourceSequence: blocks.map((entry) => entry.label ?? "") });
    const byMarker = new Map(match.items.map((item) => [item.markerId, item]));
    return blocks.map((_, index) => {
      const fits = songParts.filter((part) => byMarker.get(part.markerIds[0])?.section === index);
      const confidences = fits.map((part) => byMarker.get(part.markerIds[0])?.confidence ?? "low");
      const confidence: MatchConfidence = confidences.includes("low") ? "low" : confidences.includes("medium") ? "medium" : fits.length ? "high" : "low";
      return { block: index, partKeys: fits.map((part) => part.key), confidence };
    });
  }

  if (withHeaders || songParts.length === 0) {
    // A song without markers: same name, same section; the rest are new.
    const used = new Set<string>();
    return blocks.map((entry, index) => {
      const part = parts.find((candidate) => {
        if (used.has(candidate.key) || !entry.label) return false;
        const header = parseSectionHeader(candidate.label);
        return header?.kind === entry.kind && (header?.number ?? null) === entry.number;
      });
      if (part) used.add(part.key);
      return { block: index, partKeys: part ? [part.key] : [], confidence: part ? "high" : "low" };
    });
  }

  // No headers: the block that comes back is the chorus (every chorus of the
  // song); the others go in order to the sung names that follow, each one to
  // every section with that name.
  const blockWords = blocks.map((entry) => words(entry.lines));
  const repeated = blocks.map((_, index) => blockWords.some((other, at) => at !== index && similar(blockWords[index], other)));
  const choruses = songParts.filter((part) => part.kind === "chorus");
  const names: string[] = [];
  for (const part of songParts) {
    if (!part.sung || part.kind === "chorus") continue;
    const key = nameKey(part);
    if (!names.includes(key)) names.push(key);
  }
  let next = 0;
  return blocks.map((_, index) => {
    // Every time it is pasted it points at the choruses; the first one wins.
    if (repeated[index] && choruses.length > 0) {
      return { block: index, partKeys: choruses.map((part) => part.key), confidence: "medium" };
    }
    const name = names[next];
    if (!name) return { block: index, partKeys: [], confidence: "low" };
    next += 1;
    return { block: index, partKeys: songParts.filter((part) => part.sung && nameKey(part) === name).map((part) => part.key), confidence: "medium" };
  });
}

/**
 * Writes the reviewed paste: each block copied into its sections
 * (`applyPartEdit`, the first block wins when several go to the same one),
 * and blocks without a section become new ones at the end.
 */
export function applyPaste(
  chart: SongChart | null,
  markers: readonly SectionMarkerSummary[],
  blocks: readonly PastedBlock[],
  assignments: readonly PasteAssignment[],
  fallbackLanguage: "es" | "en" = "es",
): { chart: SongChart | null; clearedTimes: boolean } {
  let current = chart;
  let clearedTimes = false;
  const done = new Set<string>();
  for (const assignment of assignments) {
    const entry = blocks[assignment.block];
    if (!entry || entry.lines.length === 0) continue;
    let keys = assignment.partKeys;
    if (keys.length === 0) {
      const added = addPart(current, entry.kind ?? "verse", fallbackLanguage, entry.label ?? undefined);
      current = added.chart;
      keys = [added.key];
    }
    for (const key of keys) {
      if (done.has(key)) continue;
      done.add(key);
      const result = applyPartEdit(current, markers, key, entry.plain);
      current = result.chart;
      clearedTimes ||= result.clearedTimes;
    }
  }
  return { chart: current, clearedTimes };
}
