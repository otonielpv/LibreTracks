import type { ChartLink, SectionMarkerSummary } from "../models";

import { chartLinkFor } from "./chartSync";
import { parseChordPro, serializeLyricLine } from "./chordChart";

/**
 * A chart as Planning Center shows it: it keeps the text as it is written and
 * does not read ChordPro directives (`{section: Coro}` would show as words),
 * but it does read `[C]` chords. So: section headers as their own line in
 * capitals, lines with their `[C]` chords, notes in brackets, a blank line
 * between sections. Title, artist and key go in their own fields.
 */
export function toPlanningCenterChart(text: string): string {
  const doc = parseChordPro(text);
  const blocks = doc.sections.map((section) => {
    const lines: string[] = [];
    if (section.label) lines.push(section.label.toUpperCase());
    for (const line of section.lines) {
      if (line.kind === "lyrics") lines.push(serializeLyricLine(line.segments));
      else if (line.kind === "comment") lines.push(`(${line.text})`);
      else lines.push(line.text);
    }
    return lines.join("\n");
  });
  return `${blocks.filter((block) => block.trim()).join("\n\n")}\n`;
}

/**
 * The song's sequence as Planning Center writes it: the section each marker
 * shows, in timeline order (arrangement repeats included), as many times as
 * it plays inside the marker. Markers without a section (an instrumental the
 * sheet leaves out) are not in it.
 */
export function planningCenterSequence(
  text: string,
  links: readonly ChartLink[],
  markers: readonly SectionMarkerSummary[],
): string[] {
  const doc = parseChordPro(text);
  const sequence: string[] = [];
  for (const marker of markers) {
    const link = chartLinkFor(links, marker.id);
    const section = link ? doc.sections[link.section] : undefined;
    if (!link || !section?.label) continue;
    const times = Math.max(1, Math.min(8, Math.floor(link.repeat ?? 1)));
    for (let time = 0; time < times; time += 1) sequence.push(section.label);
  }
  return sequence;
}
