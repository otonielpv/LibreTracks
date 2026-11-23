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
export function toPlanningCenterChart(text: string, marks: ReadonlyMap<number, number> = new Map()): string {
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
    section.lines.forEach((line, index) => {
      if (line.kind === "lyrics") {
        let written = serializeLyricLine(line.segments);
        if (slashes && index === first) written = `${slashes} ${written}`;
        if (slashes && index === last) written = `${written.replace(/\s+$/, "")} ${slashes}`;
        lines.push(written);
      } else if (line.kind === "comment") {
        lines.push(`(${line.text})`);
      } else {
        lines.push(line.text);
      }
    });
    return lines.join("\n");
  });
  return `${blocks.filter((block) => block.trim()).join("\n\n")}\n`;
}

/** The times each marker plays its section (1 when unset). */
function passesOf(link: ChartLink): number {
  return Math.max(1, Math.min(8, Math.floor(link.repeat ?? 1)));
}

/**
 * The chart and the sequence to write to Planning Center. The sequence is the
 * section each marker shows, in timeline order (arrangement repeats
 * included); markers without a section (an instrumental the sheet leaves out)
 * are not in it. The times a section plays inside a marker go in the
 * sequence or, with `marks`, in the sheet: the sheet takes what all the
 * section's markers share (a Coro ×2 everywhere is "// … //") and the
 * sequence repeats the rest, so the total always adds up.
 */
export function planningCenterExport(
  text: string,
  links: readonly ChartLink[],
  markers: readonly SectionMarkerSummary[],
  style: RepeatStyle = "sequence",
): { chordChart: string; sequence: string[] } {
  const doc = parseChordPro(text);
  const played = markers.flatMap((marker) => {
    const link = chartLinkFor(links, marker.id);
    return link && doc.sections[link.section]?.label ? [{ section: link.section, passes: passesOf(link) }] : [];
  });
  const marks = new Map<number, number>();
  if (style === "marks") {
    for (const entry of played) {
      marks.set(entry.section, Math.min(marks.get(entry.section) ?? entry.passes, entry.passes));
    }
  }
  const sequence = played.flatMap((entry) => {
    const inSheet = marks.get(entry.section) ?? 1;
    const times = Math.max(1, Math.round(entry.passes / inSheet));
    return Array.from({ length: times }, () => doc.sections[entry.section].label);
  });
  return { chordChart: toPlanningCenterChart(text, marks), sequence };
}

/** The sequence alone, with the repeats in it. */
export function planningCenterSequence(
  text: string,
  links: readonly ChartLink[],
  markers: readonly SectionMarkerSummary[],
): string[] {
  return planningCenterExport(text, links, markers, "sequence").sequence;
}
