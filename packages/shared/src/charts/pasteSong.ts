import type { MarkerKind, SectionMarkerSummary, SongChart } from "../models";

import { looksLikeChordPro, splitSectionHeaderLines } from "./chartImport";
import { matchChartToMarkers, type MatchConfidence } from "./chartMatch";
import { addPart, applyPartEdit, type ChartPart } from "./chartParts";
import { parseChordPro, parseSectionHeader, type ChartDoc, type ChartLine } from "./chordChart";
import { plainToSectionLines, sectionToPlain } from "./plainChart";

/**
 * "Paste the whole song": what was pasted, cut into blocks, each one already
 * proposed for a part of the song, for the user to check before applying.
 *
 * Blocks are cut at recognised headers ("CORO", "Verso 2:", "[Puente]"); with
 * no header at all, at blank lines (one or more), the way Holyrics reads a
 * song. Each block is read like one part of the simple editor
 * (`plainToSectionLines`): lyrics alone, chords over the lyric, or ChordPro.
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
  /** The part it goes to, or `null` = a new part. */
  partKey: string | null;
  confidence: MatchConfidence;
};

function block(label: string | null, lines: ChartLine[]): PastedBlock {
  const header = label ? parseSectionHeader(label) : null;
  return { label, kind: header?.kind ?? null, number: header?.number ?? null, lines, plain: sectionToPlain({ lines }) };
}

export function splitPastedSong(text: string): PastedBlock[] {
  const source = text.replace(/\r\n?/g, "\n");
  const chordPro = looksLikeChordPro(source);
  if (chordPro) {
    // ChordPro sections are already the blocks.
    return parseChordPro(source)
      .sections.filter((section) => section.lines.length > 0)
      .map((section) => block(section.label || null, section.lines));
  }
  const rows = splitSectionHeaderLines(source, false).split("\n");
  const hasHeaders = rows.some((row) => parseSectionHeader(row) !== null);
  const blocks: PastedBlock[] = [];
  let label: string | null = null;
  let chunk: string[] = [];
  const flush = () => {
    const lines = plainToSectionLines(chunk.join("\n"));
    if (lines.length > 0) blocks.push(block(label, lines));
    chunk = [];
  };
  for (const row of rows) {
    const header = hasHeaders ? parseSectionHeader(row) : null;
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

export function proposePasteAssignment(
  blocks: readonly PastedBlock[],
  parts: readonly ChartPart[],
  markers: readonly SectionMarkerSummary[],
): PasteAssignment[] {
  const withHeaders = blocks.some((entry) => entry.label !== null);
  const songParts = parts.filter((part) => part.markerIds.length > 0);

  if (withHeaders && songParts.length > 0) {
    // The one matcher, with the pasted headers as the source's sequence.
    const doc: ChartDoc = {
      title: null,
      artist: null,
      key: null,
      sections: blocks.map((entry) => ({ label: entry.label ?? "", kind: entry.kind, number: entry.number, lines: entry.lines })),
    };
    const match = matchChartToMarkers(doc, markers, {
      sourceSequence: blocks.map((entry) => entry.label ?? ""),
    });
    const byMarker = new Map(match.items.map((item) => [item.markerId, item]));
    const taken = new Map<number, { partKey: string; confidence: MatchConfidence }>();
    for (const part of songParts) {
      const item = part.markerIds.map((id) => byMarker.get(id)).find((candidate) => candidate && candidate.section !== null);
      if (!item || item.section === null || taken.has(item.section)) continue;
      taken.set(item.section, { partKey: part.key, confidence: item.confidence });
    }
    return blocks.map((_, index) => {
      const found = taken.get(index);
      return found ? { block: index, ...found } : { block: index, partKey: null, confidence: "low" };
    });
  }

  if (withHeaders || songParts.length === 0) {
    // A song without markers: same name, same part; the rest are new parts.
    const used = new Set<string>();
    return blocks.map((entry, index) => {
      const part = parts.find((candidate) => {
        if (used.has(candidate.key) || !entry.label) return false;
        const header = parseSectionHeader(candidate.label);
        return header?.kind === entry.kind && (header?.number ?? null) === entry.number;
      });
      if (part) used.add(part.key);
      return { block: index, partKey: part?.key ?? null, confidence: part ? "high" : "low" };
    });
  }

  // No headers: the block that comes back is the chorus, the rest go in order
  // to the parts that are sung.
  const blockWords = blocks.map((entry) => words(entry.lines));
  const repeated = blocks.map((_, index) => blockWords.some((other, at) => at !== index && similar(blockWords[index], other)));
  const chorus = songParts.find((part) => part.kind === "chorus");
  const others = songParts.filter((part) => part.sung && part !== chorus);
  let next = 0;
  return blocks.map((_, index) => {
    if (repeated[index] && chorus) return { block: index, partKey: chorus.key, confidence: "medium" };
    const part = others[next];
    if (!part) return { block: index, partKey: null, confidence: "low" };
    next += 1;
    return { block: index, partKey: part.key, confidence: "medium" };
  });
}

/**
 * Writes the reviewed paste: each block into its part (`applyPartEdit`), the
 * first block wins when several go to the same part, and blocks without a
 * part become new parts at the end.
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
    let key = assignment.partKey;
    if (key === null) {
      const added = addPart(current, entry.kind ?? "verse", fallbackLanguage, entry.label ?? undefined);
      current = added.chart;
      key = added.key;
    }
    if (done.has(key)) continue;
    done.add(key);
    const result = applyPartEdit(current, markers, key, entry.plain);
    current = result.chart;
    clearedTimes ||= result.clearedTimes;
  }
  return { chart: current, clearedTimes };
}
