import type { ChartLink, SectionMarkerSummary } from "../models";

import { parseSectionHeader, type ChartDoc } from "./chordChart";
import { canonicalLabel, chartKind, isLyricless, sectionFamily, vocabTokens } from "./sectionVocab";

/**
 * Which chart section plays at each section marker of a song.
 *
 * The markers are the truth: they sit on the audio (D1). The chart writes each
 * part once and the links make the sequence (D2), so a sheet Intro/Verso/Coro
 * on a song Intro/Verso/Verso/Coro links both verse markers to the one verse.
 *
 * Pure: no I/O, no state. Every source (PDF, pasted text, ChordPro, Planning
 * Center) and every view uses this one function (D3).
 */

export type MatchConfidence = "high" | "medium" | "low";

/** Why a marker got its section, as a code the UI translates. `locked` is a
 * choice the user made in the review. */
export type MatchReason = "number" | "sequence" | "family" | "order" | "lyricless" | "missing" | "locked";

export type MatchItem = {
  markerId: string;
  section: number | null;
  confidence: MatchConfidence;
  reason: MatchReason;
};

export type ChartMatch = {
  links: ChartLink[];
  /** One per original marker, in timeline order. */
  items: MatchItem[];
  /** Sections no marker shows. */
  unusedSections: number[];
};

export type MatchOptions = {
  /** The source's sequence as it labels it ("Verse 1", "C", "V2"): a hint
   * that says which of two verses a plain "Verso" marker is. */
  sourceSequence?: readonly string[];
  /** Links the user fixed (`section: null` = no section): kept as they are,
   * the rest is aligned around them. */
  locked?: ReadonlyArray<{ markerId: string; section: number | null }>;
  /** Later (README, out of v1): extra cost of showing `section` at a marker,
   * from comparing the sheet with the voice guide's words. */
  contentHint?: (markerId: string, section: number) => number;
};

// Costs. Lower is better; tuned on the cases in chartMatch.test.ts.
/** Same number on marker and section ("Estrofa 2" ↔ "Verse 2"). */
const NUMBER_BONUS = -3;
/** Both numbered, differently: possible (the sheet writes fewer verses than
 * the song sings) but never confident. */
const NUMBER_PENALTY = 4;
/** Each section of the family jumped over going forward. */
const SKIP_COST = 1.5;
/** Going back to a section already read (choruses come back). */
const BACK_COST = 1;
/** Going back while the sheet still has sections of the family ahead: the
 * song is more likely reading on (otherwise "go back now" and "go back
 * later" cost the same and the earliest wins). */
const BACK_WITH_AHEAD_COST = 1;
/** Each section of the family jumped over going back. */
const BACK_SKIP_COST = 0.5;
/** A played section (intro, instrumental) may well have no section. */
const NONE_LYRICLESS_COST = 2.5;
/** A sung section without a section is a hole in the lyrics. */
const NONE_MISSING_COST = 20;

type Meaning = { family: string | null; number: number | null; lyricless: boolean };

/** What a marker names: its kind, or for a custom marker ("Coro 2", "Puente")
 * what its name says as a header. A name like "C" or "A2" means nothing. */
function markerMeaning(marker: SectionMarkerSummary): Meaning {
  const kind = marker.kind && marker.kind !== "custom" ? marker.kind : null;
  if (kind) {
    return { family: sectionFamily(kind), number: marker.variant ?? null, lyricless: isLyricless(kind) };
  }
  const header = parseSectionHeader(marker.name);
  return {
    family: sectionFamily(header?.kind),
    number: header?.number ?? marker.variant ?? null,
    lyricless: isLyricless(header?.kind),
  };
}

const numbersAgree = (left: number | null, right: number | null) => left === null || right === null || left === right;

const normalizedLabel = (label: string) => vocabTokens(label).join(" ");

/**
 * The source's sequence labels as section indexes (`null` = no such section).
 * A label written exactly like a header of the sheet wins; otherwise the
 * vocabulary (abbreviations allowed) and the number. When several sections
 * fit, the next one after the previous label's, the way the sequence reads
 * the sheet.
 */
export function resolveSourceSequence(doc: ChartDoc, labels: readonly string[]): Array<number | null> {
  const resolved: Array<number | null> = [];
  let previous = -1;
  const pick = (candidates: number[]) => candidates.find((index) => index > previous) ?? candidates[0] ?? null;
  for (const label of labels) {
    const wanted = normalizedLabel(label);
    let section: number | null = null;
    if (wanted) {
      section = pick(
        doc.sections.flatMap((candidate, index) => (normalizedLabel(candidate.label) === wanted ? [index] : [])),
      );
    }
    if (section === null) {
      const meaning = canonicalLabel(label, "sequence");
      if (meaning) {
        const family = sectionFamily(chartKind(meaning.kind));
        const sameFamily = doc.sections.flatMap((candidate, index) =>
          sectionFamily(candidate.kind) === family ? [index] : [],
        );
        const sameNumber = sameFamily.filter((index) => doc.sections[index].number === meaning.number);
        const compatible = sameFamily.filter((index) => numbersAgree(doc.sections[index].number, meaning.number));
        section = pick(sameNumber.length > 0 ? sameNumber : compatible);
      }
    }
    resolved.push(section);
    if (section !== null) previous = section;
  }
  return resolved;
}

/**
 * Needleman-Wunsch between the markers' families and the source's sequence:
 * a marker aligned with an item of its family takes that item's section.
 */
function alignWithSequence(meanings: readonly Meaning[], sequence: ReadonlyArray<number | null>, doc: ChartDoc) {
  const GAP = -1;
  const rows = meanings.length;
  const columns = sequence.length;
  const score = (row: number, column: number): number | null => {
    const meaning = meanings[row];
    const section = sequence[column];
    if (!meaning.family || section === null) return null;
    const target = doc.sections[section];
    if (sectionFamily(target.kind) !== meaning.family || !numbersAgree(meaning.number, target.number)) return null;
    return meaning.number !== null && meaning.number === target.number ? 3 : 2;
  };
  const table: number[][] = Array.from({ length: rows + 1 }, (_, row) =>
    Array.from({ length: columns + 1 }, (_, column) => (row + column) * GAP),
  );
  for (let row = 1; row <= rows; row += 1) {
    for (let column = 1; column <= columns; column += 1) {
      const pair = score(row - 1, column - 1);
      table[row][column] = Math.max(
        pair === null ? -Infinity : table[row - 1][column - 1] + pair,
        table[row - 1][column] + GAP,
        table[row][column - 1] + GAP,
      );
    }
  }
  const pinned = new Map<number, number>();
  let row = rows;
  let column = columns;
  while (row > 0 && column > 0) {
    const pair = score(row - 1, column - 1);
    if (pair !== null && table[row][column] === table[row - 1][column - 1] + pair) {
      pinned.set(row - 1, sequence[column - 1] as number);
      row -= 1;
      column -= 1;
    } else if (table[row][column] === table[row - 1][column] + GAP) {
      row -= 1;
    } else {
      column -= 1;
    }
  }
  return pinned;
}

type Choice = { section: number | null; cost: number };

/**
 * Links each section marker of a song to the chart section it shows.
 *
 * Global, not greedy: a Viterbi walk over the markers where the state is the
 * last section read. Reading on to the next section of the marker's family is
 * free; jumping over sections, or going back, costs a little; the wrong family
 * is impossible; a matching number is a bonus and a different one a penalty.
 * A played section (intro, instrumental) may stay without a section; a sung
 * one is a hole. With the source's sequence, markers aligned with it take its
 * sections first. If no marker means anything (custom "A", "B"), by the
 * sequence when it is as long as the markers, else in order.
 *
 * Only original markers are matched; arrangement repeats (`id~n`) use their
 * original's link (`chartLinkFor`).
 */
export function matchChartToMarkers(
  doc: ChartDoc,
  markers: readonly SectionMarkerSummary[],
  options: MatchOptions = {},
): ChartMatch {
  const originals = markers.filter((marker) => !marker.id.includes("~"));
  const sectionCount = doc.sections.length;
  const meanings = originals.map(markerMeaning);
  const locked = new Map<string, number | null>();
  for (const link of options.locked ?? []) {
    if (link.section === null || (link.section >= 0 && link.section < sectionCount)) locked.set(link.markerId, link.section);
  }
  const sequence = options.sourceSequence?.length ? resolveSourceSequence(doc, options.sourceSequence) : null;
  const pinned = sequence ? alignWithSequence(meanings, sequence, doc) : new Map<number, number>();

  const families = doc.sections.map((section) => sectionFamily(section.kind));
  // countBefore[family][i] = sections of that family in [0, i).
  const countBefore = new Map<string, number[]>();
  for (const family of new Set(families)) {
    if (!family) continue;
    const counts = [0];
    families.forEach((candidate, index) => counts.push(counts[index] + (candidate === family ? 1 : 0)));
    countBefore.set(family, counts);
  }
  const between = (family: string, from: number, to: number) => {
    const counts = countBefore.get(family);
    return counts ? counts[Math.max(0, to)] - counts[Math.max(0, from)] : 0;
  };
  /** Cost of reading `section` when the last section read is `position`. */
  const transition = (position: number, section: number) => {
    const family = families[section];
    if (!family) return position < section ? 0 : BACK_COST;
    if (section > position) return SKIP_COST * between(family, position + 1, section);
    const ahead = between(family, position + 1, families.length) > 0 ? BACK_WITH_AHEAD_COST : 0;
    return BACK_COST + ahead + BACK_SKIP_COST * between(family, section + 1, position + 1);
  };
  const emission = (markerIndex: number, section: number): number => {
    const meaning = meanings[markerIndex];
    const target = doc.sections[section];
    if (!meaning.family || families[section] !== meaning.family) return Infinity;
    let cost = 0;
    if (meaning.number !== null && target.number !== null) {
      cost += meaning.number === target.number ? NUMBER_BONUS : NUMBER_PENALTY;
    }
    return cost + (options.contentHint?.(originals[markerIndex].id, section) ?? 0);
  };
  const choicesFor = (markerIndex: number): Choice[] => {
    const marker = originals[markerIndex];
    if (locked.has(marker.id)) return [{ section: locked.get(marker.id) ?? null, cost: 0 }];
    const pin = pinned.get(markerIndex);
    if (pin !== undefined) return [{ section: pin, cost: 0 }];
    const meaning = meanings[markerIndex];
    const choices: Choice[] = [
      { section: null, cost: !meaning.family ? 0 : meaning.lyricless ? NONE_LYRICLESS_COST : NONE_MISSING_COST },
    ];
    for (let section = 0; section < sectionCount; section += 1) {
      const cost = emission(markerIndex, section);
      if (cost < Infinity) choices.push({ section, cost });
    }
    return choices;
  };

  // Viterbi. State p+1 for "last section read is p" (p = -1: nothing yet).
  const states = sectionCount + 1;
  let best = new Array<number>(states).fill(Infinity);
  best[0] = 0;
  const trail: Array<Array<{ from: number; section: number | null } | null>> = [];
  originals.forEach((_, markerIndex) => {
    const next = new Array<number>(states).fill(Infinity);
    const step: Array<{ from: number; section: number | null } | null> = new Array(states).fill(null);
    const choices = choicesFor(markerIndex);
    for (let state = 0; state < states; state += 1) {
      if (best[state] === Infinity) continue;
      const position = state - 1;
      for (const choice of choices) {
        const to = choice.section === null ? state : choice.section + 1;
        const cost =
          best[state] + choice.cost + (choice.section === null ? 0 : transition(position, choice.section));
        // Strictly better only: ties keep the earliest state and section.
        if (cost < next[to]) {
          next[to] = cost;
          step[to] = { from: state, section: choice.section };
        }
      }
    }
    trail.push(step);
    best = next;
  });

  const assigned: Array<number | null> = new Array(originals.length).fill(null);
  let state = best.reduce((winner, cost, index) => (cost < best[winner] ? index : winner), 0);
  for (let markerIndex = originals.length - 1; markerIndex >= 0; markerIndex -= 1) {
    const step = trail[markerIndex][state];
    if (!step) break;
    assigned[markerIndex] = step.section;
    state = step.from;
  }

  // Nothing to match by meaning on one side: markers all custom ("A", "B") or
  // a sheet without a single header it understands.
  const anyMeaning = meanings.some((meaning) => meaning.family !== null);
  const sheetMeans = families.some((family) => family !== null);
  let items: MatchItem[];
  if (!anyMeaning || !sheetMeans) {
    items = fallbackItems(originals, sectionCount, sequence, locked);
  } else {
    let position = -1;
    items = originals.map((marker, index) => {
      const section = assigned[index];
      const meaning = meanings[index];
      const item = describe(marker, section, meaning, {
        locked: locked.has(marker.id),
        pinned: pinned.has(index),
        transition: section === null ? 0 : transition(position, section),
        target: section === null ? null : doc.sections[section].number,
      });
      if (section !== null) position = section;
      return item;
    });
  }

  const links = items.flatMap((item) => (item.section === null ? [] : [{ markerId: item.markerId, section: item.section }]));
  const used = new Set(links.map((link) => link.section));
  return {
    links,
    items,
    unusedSections: doc.sections.flatMap((_, index) => (used.has(index) ? [] : [index])),
  };
}

function describe(
  marker: SectionMarkerSummary,
  section: number | null,
  meaning: Meaning,
  context: { locked: boolean; pinned: boolean; transition: number; target: number | null },
): MatchItem {
  const markerId = marker.id;
  if (context.locked) return { markerId, section, confidence: "high", reason: "locked" };
  if (context.pinned) return { markerId, section, confidence: "high", reason: "sequence" };
  if (section === null) {
    if (meaning.family && meaning.lyricless) return { markerId, section, confidence: "high", reason: "lyricless" };
    return { markerId, section, confidence: "low", reason: "missing" };
  }
  if (meaning.number !== null && context.target !== null) {
    return meaning.number === context.target
      ? { markerId, section, confidence: "high", reason: "number" }
      : { markerId, section, confidence: "medium", reason: "family" };
  }
  return { markerId, section, confidence: context.transition === 0 ? "high" : "medium", reason: "family" };
}

/** Nothing could be matched by meaning: by the source's sequence when it has
 * one item per marker, else in order. Low confidence either way. */
function fallbackItems(
  originals: readonly SectionMarkerSummary[],
  sectionCount: number,
  sequence: ReadonlyArray<number | null> | null,
  locked: ReadonlyMap<string, number | null>,
): MatchItem[] {
  const bySequence = sequence !== null && sequence.length === originals.length;
  return originals.map((marker, index) => {
    if (locked.has(marker.id)) {
      return { markerId: marker.id, section: locked.get(marker.id) ?? null, confidence: "high", reason: "locked" };
    }
    const section = bySequence ? sequence[index] : index < sectionCount ? index : null;
    return section === null
      ? { markerId: marker.id, section: null, confidence: "low", reason: "missing" }
      : { markerId: marker.id, section, confidence: "low", reason: bySequence ? "sequence" : "order" };
  });
}

