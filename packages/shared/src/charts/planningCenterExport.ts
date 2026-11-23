import type { ChartLink, SectionMarkerSummary } from "../models";

import { chartLinkFor } from "./chartSync";
import { parseChordPro, serializeLyricLine, type ChartSection } from "./chordChart";

/** How the times a section plays inside a marker go to Planning Center. */
export type RepeatStyle =
  /** In the sequence: a Coro ×2 is "Coro, Coro". The sheet has no marks. */
  | "sequence"
  /** In the sheet, Planning Center's way: "// … //" (×2), "/// … ///" (×3);
   * the sequence names the section once per marker. */
  | "marks";

const hasWords = (section: ChartSection, index: number) => {
  const line = section.lines[index];
  return line?.kind === "lyrics" && line.segments.some((segment) => /\p{L}/u.test(segment.text));
};

/**
 * A chart as Planning Center shows it: it keeps the text as it is written and
 * does not read ChordPro directives (`{section: Coro}` would show as words),
 * but it does read `[C]` chords. So: section headers as their own line in
 * capitals, lines with their `[C]` chords, notes in brackets, a blank line
 * between sections. Title, artist and key go in their own fields. `marks`
 * wraps a section in repeat slashes (2 = "// … //").
 */
/**
 * Lines sung again right after themselves ("A A B", "A B A B C"), joined into
 * one block with its count: what LibreTracks writes out, Planning Center
 * writes once between slashes.
 */
function joinRepeatedLines(lines: readonly string[]): Array<{ lines: string[]; count: number }> {
  const blocks: Array<{ lines: string[]; count: number }> = [];
  let index = 0;
  while (index < lines.length) {
    let best = { length: 1, count: 1 };
    for (let length = 1; index + length * 2 <= lines.length; length += 1) {
      const block = lines.slice(index, index + length);
      if (!block.some((line) => /\p{L}/u.test(line))) continue;
      let count = 1;
      while (lines.slice(index + count * length, index + (count + 1) * length).join("\n") === block.join("\n")) count += 1;
      if (count >= 2 && length * count > best.length * best.count) best = { length, count };
    }
    blocks.push({ lines: lines.slice(index, index + best.length), count: best.count });
    index += best.length * best.count;
  }
  return blocks;
}

export function toPlanningCenterChart(
  text: string,
  marks: ReadonlyMap<number, number> = new Map(),
  joinLines = false,
): string {
  const doc = parseChordPro(text);
  const blocks = doc.sections.map((section, sectionIndex) => {
    const times = marks.get(sectionIndex) ?? 1;
    const slashes = times > 1 ? "/".repeat(times) : "";
    const lyricIndexes = section.lines.flatMap((_, index) => (hasWords(section, index) ? [index] : []));
    const first = lyricIndexes[0];
    const last = lyricIndexes[lyricIndexes.length - 1];
    const lines: string[] = [];
    if (section.label) {
      // A part without words ("INTRO") carries its marks on the header.
      lines.push(`${section.label.toUpperCase()}${slashes && first === undefined ? ` ${slashes}` : ""}`);
    }
    const body: string[] = [];
    section.lines.forEach((line, index) => {
      if (line.kind === "lyrics") {
        let written = serializeLyricLine(line.segments);
        if (slashes && index === first) written = `${slashes} ${written}`;
        if (slashes && index === last) written = `${written.replace(/\s+$/, "")} ${slashes}`;
        body.push(written);
      } else if (line.kind === "comment") {
        body.push(`(${line.text})`);
      } else {
        body.push(line.text);
      }
    });
    if (joinLines && !slashes) {
      for (const block of joinRepeatedLines(body)) {
        if (block.count < 2) {
          lines.push(...block.lines);
          continue;
        }
        const marked = "/".repeat(block.count);
        const joined = [...block.lines];
        joined[0] = `${marked} ${joined[0]}`;
        joined[joined.length - 1] = `${joined[joined.length - 1].replace(/\s+$/, "")} ${marked}`;
        lines.push(...joined);
      }
    } else {
      lines.push(...body);
    }
    return lines.join("\n");
  });
  return `${blocks.filter((block) => block.trim()).join("\n\n")}\n`;
}

/** The times each marker plays its section (1 when unset). */
function passesOf(link: ChartLink): number {
  return Math.max(1, Math.min(8, Math.floor(link.repeat ?? 1)));
}

/**
 * The chart and, with "sequence", the sequence to write to Planning Center.
 *
 * "sequence": the section each marker shows, in timeline order (arrangement
 * repeats included), once per pass; markers without a section are not in
 * it. The sheet has no marks.
 *
 * "marks": the sheet says how many times each section is sung in all
 * ("////" for a bridge sung 2 + 2 in two markers) and the sequence is not
 * written: one or the other, never both.
 */
export function planningCenterExport(
  text: string,
  links: readonly ChartLink[],
  markers: readonly SectionMarkerSummary[],
  style: RepeatStyle = "sequence",
): { chordChart: string; sequence?: string[] } {
  const doc = parseChordPro(text);
  const played = markers.flatMap((marker) => {
    const link = chartLinkFor(links, marker.id);
    return link && doc.sections[link.section]?.label ? [{ section: link.section, passes: passesOf(link) }] : [];
  });
  if (style === "marks") {
    const totals = new Map<number, number>();
    for (const entry of played) totals.set(entry.section, Math.min(16, (totals.get(entry.section) ?? 0) + entry.passes));
    return { chordChart: toPlanningCenterChart(text, totals, true) };
  }
  const sequence = played.flatMap((entry) =>
    Array.from({ length: entry.passes }, () => doc.sections[entry.section].label),
  );
  return { chordChart: toPlanningCenterChart(text), sequence };
}

/** The sequence alone, with the repeats in it. */
export function planningCenterSequence(
  text: string,
  links: readonly ChartLink[],
  markers: readonly SectionMarkerSummary[],
): string[] {
  return planningCenterExport(text, links, markers, "sequence").sequence ?? [];
}
