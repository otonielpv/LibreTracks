import type { ChartLink, SectionMarkerSummary } from "../models";

import { chartLinkFor } from "./chartSync";
import { parseChordPro, serializeLyricLine, type ChartSection } from "./chordChart";
import { canonicalLabel } from "./sectionVocab";

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

/** A section written again under another name: the intro's chords that the
 * song plays as a "Vamp" or an "Interludio" marker. `source` is the section
 * whose lines it repeats; the map key, the section it is written after. */
export type SectionCopy = { label: string; times: number; source: number };

export function toPlanningCenterChart(
  text: string,
  marks: ReadonlyMap<number, number> = new Map(),
  joinLines = false,
  copies: ReadonlyMap<number, readonly SectionCopy[]> = new Map(),
): string {
  const doc = parseChordPro(text);
  const blocks = doc.sections.flatMap((section, sectionIndex) => [
    writeSection(section, section.label, marks.get(sectionIndex) ?? 1, joinLines),
    ...(copies.get(sectionIndex) ?? []).map((copy) =>
      writeSection(doc.sections[copy.source], copy.label, copy.times, joinLines),
    ),
  ]);
  return `${blocks.filter((block) => block.trim()).join("\n\n")}\n`;
}

function writeSection(section: ChartSection, label: string | null | undefined, times: number, joinLines: boolean): string {
  const slashes = times > 1 ? "/".repeat(times) : "";
  const lyricIndexes = section.lines.flatMap((_, index) => (hasWords(section, index) ? [index] : []));
  // A part without words ("INTRO"): the marks wrap its chords, the same way
  // as a sung part's lines ("// [Bm] [D] [G] [A] //").
  const marked = lyricIndexes.length
    ? lyricIndexes
    : section.lines.flatMap((line, index) =>
        line.kind === "lyrics" && serializeLyricLine(line.segments).trim() ? [index] : [],
      );
  const first = marked[0];
  const last = marked[marked.length - 1];
  // One line of chords and nothing else: the chords go beside the header, as
  // plain text, with the marks if it repeats ("INTERLUDIO Bm D G A",
  // "INTRO // Bm D G A //"); in brackets Planning Center draws them over the
  // slashes.
  const content = section.lines.filter((line) => line.kind !== "lyrics" || serializeLyricLine(line.segments).trim());
  if (label && !lyricIndexes.length && content.length === 1 && content[0].kind === "lyrics") {
    const chords = serializeLyricLine(content[0].segments).replace(/\[([^\]]+)\]/g, " $1 ").replace(/\s+/g, " ").trim();
    return slashes ? `${label.toUpperCase()} ${slashes} ${chords} ${slashes}` : `${label.toUpperCase()} ${chords}`;
  }
  const lines: string[] = [];
  if (label) lines.push(label.toUpperCase());
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
      const repeat = "/".repeat(block.count);
      const joined = [...block.lines];
      joined[0] = `${repeat} ${joined[0]}`;
      joined[joined.length - 1] = `${joined[joined.length - 1].replace(/\s+$/, "")} ${repeat}`;
      lines.push(...joined);
    }
  } else {
    lines.push(...body);
  }
  return lines.join("\n");
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
  // A marker of another kind than the section it shows (a "Vamp" or an
  // "Interludio" on the intro's chords) is its own section in Planning
  // Center, named like the marker: otherwise the intro would read "///"
  // when it opens the song once.
  const kindOf = (label: string) => canonicalLabel(label, "free")?.kind ?? label.trim().toLowerCase();
  const played = markers.flatMap((marker) => {
    const link = chartLinkFor(links, marker.id);
    const label = link ? doc.sections[link.section]?.label : undefined;
    if (!link || !label) return [];
    // Only when both names say what they are: a marker named "c1" or
    // "Guitarra" is just the section it shows.
    const markerKind = canonicalLabel(marker.name, "free")?.kind;
    const sectionKind = canonicalLabel(label, "free")?.kind;
    const own = !markerKind || !sectionKind || markerKind === sectionKind;
    return [{ section: link.section, label: own ? label : stripNumber(marker.name), copy: !own, passes: passesOf(link) }];
  });
  // Each copy goes where it first sounds: after the section of the part
  // played before it ("Interludio" after the first chorus, not after the
  // intro whose chords it uses).
  const copies = new Map<number, SectionCopy[]>();
  const all: SectionCopy[] = [];
  let anchor: number | null = null;
  for (const entry of played) {
    if (!entry.copy) {
      anchor = entry.section;
      continue;
    }
    const found = all.find((copy) => kindOf(copy.label) === kindOf(entry.label));
    if (found) {
      found.times = Math.min(16, found.times + entry.passes);
      continue;
    }
    const copy = { label: entry.label, times: entry.passes, source: entry.section };
    all.push(copy);
    const after = anchor ?? entry.section;
    copies.set(after, [...(copies.get(after) ?? []), copy]);
  }
  if (style === "marks") return { chordChart: marksChart(doc, played, kindOf) };
  const named = new Map(all.map((copy) => [kindOf(copy.label), copy.label] as const));
  const sequence = played.flatMap((entry) =>
    Array.from({ length: entry.passes }, () => (entry.copy ? named.get(kindOf(entry.label)) ?? entry.label : entry.label)),
  );
  const once = new Map([...copies].map(([section, list]) => [section, list.map((copy) => ({ ...copy, times: 1 }))]));
  return { chordChart: toPlanningCenterChart(text, new Map(), false, once), sequence };
}

/**
 * With slashes there is no sequence: the sheet is read top to bottom, so a
 * part is written where it sounds, once per run of markers in a row, with
 * the times of that run. An Instrumental after the second chorus and two
 * more after the bridges are "INSTRUMENTAL" there and "INSTRUMENTAL //"
 * after the bridge, not one "///". The first run of a section of the sheet
 * is the section itself; later runs, and markers of another kind (a Vamp on
 * the intro's chords), are written again after the part played before them.
 */
function marksChart(
  doc: ReturnType<typeof parseChordPro>,
  played: ReadonlyArray<{ section: number; label: string; copy: boolean; passes: number }>,
  kindOf: (label: string) => string,
): string {
  type Item = { source: number; label: string | null | undefined; times: number };
  // The sheet's own sections; `items` is the order they are written in, with
  // the copies spliced in (indexes there move, so never look up by section).
  const originals: Item[] = doc.sections.map((section, index) => ({ source: index, label: section.label, times: 1 }));
  const items = [...originals];
  const started = new Set<string>();
  let previousKey: string | null = null;
  let current: Item | null = null;
  for (const entry of played) {
    const key = `${entry.section}|${entry.copy ? kindOf(entry.label) : ""}`;
    if (key === previousKey && current) {
      current.times = Math.min(16, current.times + entry.passes);
      continue;
    }
    let next: Item;
    if (!entry.copy && !started.has(key)) {
      next = originals[entry.section];
      next.times = entry.passes;
    } else {
      next = { source: entry.section, label: entry.label, times: entry.passes };
      const at = items.indexOf(current ?? originals[entry.section]) + 1;
      items.splice(at, 0, next);
    }
    started.add(key);
    previousKey = key;
    current = next;
  }
  const blocks = items.map((item) => writeSection(doc.sections[item.source], item.label, item.times, true));
  return `${blocks.filter((block) => block.trim()).join("\n\n")}\n`;
}

/** "Interludio 2" -> "Interludio": the copy is one section for all of them. */
function stripNumber(name: string): string {
  return name.trim().replace(/\s+\d+$/, "");
}

/** The sequence alone, with the repeats in it. */
export function planningCenterSequence(
  text: string,
  links: readonly ChartLink[],
  markers: readonly SectionMarkerSummary[],
): string[] {
  return planningCenterExport(text, links, markers, "sequence").sequence ?? [];
}
