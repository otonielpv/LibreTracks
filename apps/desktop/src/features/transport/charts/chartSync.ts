import {
  markerCategory,
  type ChartLink,
  type MarkerKind,
  type SectionMarkerSummary,
  type SongRegionSummary,
} from "@libretracks/shared/models";

import { parseSectionHeader, type ChartDoc } from "./chordChart";

/** The stored id of a link: arrangements give repeats `"{id}~{n}"`, and a
 * repeat uses the link of its original marker. Mirrors Rust
 * `chart_link_marker_id`. */
export function chartLinkMarkerId(markerId: string): string {
  const cut = markerId.indexOf("~");
  return cut < 0 ? markerId : markerId.slice(0, cut);
}

export function chartLinkFor(links: readonly ChartLink[], markerId: string): ChartLink | null {
  const base = chartLinkMarkerId(markerId);
  return links.find((link) => link.markerId === base) ?? null;
}

/** The section markers of a song, in timeline order. Cues (warnings, one-shot
 * announcements) never move the lyrics. */
export function chartMarkersForRegion(
  markers: readonly SectionMarkerSummary[],
  region: SongRegionSummary | null,
): SectionMarkerSummary[] {
  if (!region) return [];
  return markers
    .filter(
      (marker) =>
        markerCategory(marker) === "section" &&
        marker.startSeconds >= region.startSeconds - 0.001 &&
        marker.startSeconds < region.endSeconds,
    )
    .sort((left, right) => left.startSeconds - right.startSeconds);
}

/** Kinds that name the same part of a song in different sheets. */
const KIND_FAMILY: Partial<Record<MarkerKind, string>> = {
  chorus: "chorus",
  refrain: "chorus",
  outro: "end",
  ending: "end",
  instrumental: "instrumental",
  interlude: "instrumental",
};

function family(kind: MarkerKind | null | undefined): string | null {
  if (!kind || kind === "custom") return null;
  return KIND_FAMILY[kind] ?? kind;
}

/** What a marker names: its kind, or — for a custom marker called "Coro 2" —
 * what its name says. */
function markerMeaning(marker: SectionMarkerSummary): { family: string | null; number: number | null } {
  const fromKind = family(marker.kind);
  if (fromKind) return { family: fromKind, number: marker.variant ?? null };
  const header = parseSectionHeader(marker.name);
  return { family: family(header?.kind), number: header?.number ?? marker.variant ?? null };
}

/**
 * Links each marker of a song to the chart section it most likely shows.
 *
 * Markers and sheet are walked in step, the way a musician reads along: each
 * marker takes the next section of its kind after the one the previous marker
 * took (so a chorus that comes back after the instrumental gets the chorus
 * written after the instrumental, which may be in another key). When the song
 * goes back — a second intro, a verse the sheet only writes once — it takes
 * the most recent section of that kind. A marker with a number ("Estrofa 2")
 * goes to the section with that number if the sheet has one.
 *
 * If nothing could be matched by meaning — custom markers with arbitrary
 * names — markers and sections are paired in order.
 */
export function autoLinkChart(doc: ChartDoc, markers: readonly SectionMarkerSummary[]): ChartLink[] {
  const originals = markers.filter((marker) => !marker.id.includes("~"));
  const families = doc.sections.map((section) => family(section.kind));
  const links: ChartLink[] = [];
  let cursor = 0;
  for (const marker of originals) {
    const meaning = markerMeaning(marker);
    if (!meaning.family) continue;
    const matches = (index: number) => families[index] === meaning.family;
    let section = -1;
    if (meaning.number !== null) {
      section = doc.sections.findIndex(
        (candidate, index) => matches(index) && candidate.number === meaning.number,
      );
    }
    if (section < 0) {
      for (let index = cursor; index < doc.sections.length && section < 0; index += 1) {
        if (matches(index)) section = index;
      }
    }
    if (section < 0) {
      for (let index = Math.min(cursor, doc.sections.length) - 1; index >= 0 && section < 0; index -= 1) {
        if (matches(index)) section = index;
      }
    }
    if (section < 0) continue;
    links.push({ markerId: marker.id, section });
    cursor = section + 1;
  }
  if (links.length > 0) return links;

  return originals
    .slice(0, doc.sections.length)
    .map((marker, index) => ({ markerId: marker.id, section: index }));
}

/**
 * When each line of a section starts, in seconds from its marker. Recorded
 * beats are used where there are some; lines past the last recorded one share
 * what is left of the section evenly.
 */
export function lineStartSeconds(
  lineCount: number,
  sectionSeconds: number,
  secondsPerBeat: number,
  lineBeats: readonly number[] | undefined,
): number[] {
  if (lineCount <= 0) return [];
  const recorded = (lineBeats ?? [])
    .slice(0, lineCount)
    .map((beat) => beat * secondsPerBeat);
  if (recorded.length === 0) recorded.push(0);
  const starts = [...recorded];
  const from = starts[starts.length - 1];
  const remaining = lineCount - starts.length;
  if (remaining > 0) {
    const step = Math.max(0, sectionSeconds - from) / (remaining + 1);
    for (let index = 1; index <= remaining; index += 1) starts.push(from + step * index);
  }
  return starts;
}

export type ChartPlayback = {
  /** The section marker playing (it may be a repeat, `id~n`). */
  markerId: string | null;
  /** Where the lyrics are: the linked section of that marker or, if it has
   * none, of the closest earlier marker that does. */
  section: number | null;
  line: number | null;
  /** The section the next marker shows, for the "up next" preview. */
  nextSection: number | null;
  /** Seconds the active marker started at, and until the next one. */
  markerStartSeconds: number | null;
  sectionSeconds: number;
};

export const NO_CHART_PLAYBACK: ChartPlayback = {
  markerId: null,
  section: null,
  line: null,
  nextSection: null,
  markerStartSeconds: null,
  sectionSeconds: 0,
};

export function resolveChartPlayback(
  doc: ChartDoc,
  links: readonly ChartLink[],
  markers: readonly SectionMarkerSummary[],
  regionEndSeconds: number,
  positionSeconds: number,
  secondsPerBeatAt: (seconds: number) => number,
): ChartPlayback {
  let active = -1;
  for (let index = 0; index < markers.length; index += 1) {
    if (markers[index].startSeconds <= positionSeconds + 0.001) active = index;
    else break;
  }
  if (active < 0) return NO_CHART_PLAYBACK;
  const marker = markers[active];
  const link = chartLinkFor(links, marker.id);
  const next = markers[active + 1];
  const end = next ? next.startSeconds : regionEndSeconds;
  const sectionSeconds = Math.max(0, end - marker.startSeconds);
  const nextLink = next ? chartLinkFor(links, next.id) : null;
  const nextSection = nextLink && nextLink.section < doc.sections.length ? nextLink.section : null;

  if (!link || link.section >= doc.sections.length) {
    // No lyrics for this part (an instrumental the sheet leaves out): keep
    // showing where the singer was, without a current line.
    for (let index = active - 1; index >= 0; index -= 1) {
      const earlier = chartLinkFor(links, markers[index].id);
      if (earlier && earlier.section < doc.sections.length) {
        return { markerId: marker.id, section: earlier.section, line: null, nextSection, markerStartSeconds: marker.startSeconds, sectionSeconds };
      }
    }
    return { ...NO_CHART_PLAYBACK, markerId: marker.id, nextSection, markerStartSeconds: marker.startSeconds, sectionSeconds };
  }

  const lineCount = doc.sections[link.section].lines.length;
  const starts = lineStartSeconds(
    lineCount,
    sectionSeconds,
    secondsPerBeatAt(marker.startSeconds),
    link.lineBeats,
  );
  const elapsed = positionSeconds - marker.startSeconds;
  let line: number | null = null;
  for (let index = 0; index < starts.length; index += 1) {
    if (starts[index] <= elapsed + 0.001) line = index;
  }
  return {
    markerId: marker.id,
    section: link.section,
    line,
    nextSection,
    markerStartSeconds: marker.startSeconds,
    sectionSeconds,
  };
}

/** Line starts tapped in while recording, per original marker id, in beats. */
export type LineRecording = ReadonlyMap<string, readonly number[]>;

/**
 * One tap of "next line" while recording: the next line of the playing
 * section starts now. The first line always starts at the marker (beat 0), so
 * the first tap places the SECOND line. Taps that go backwards are ignored.
 */
export function recordLineTap(
  recording: LineRecording,
  markerId: string,
  beat: number,
  lineCount: number,
): LineRecording {
  if (!Number.isFinite(beat) || beat <= 0) return recording;
  const key = chartLinkMarkerId(markerId);
  const beats = recording.get(key) ?? [0];
  if (beats.length >= lineCount || beat <= beats[beats.length - 1]) return recording;
  const next = new Map(recording);
  next.set(key, [...beats, Math.round(beat * 100) / 100]);
  return next;
}

/** The links with what was recorded written in. Markers without a link (the
 * user tapped through a part with no lyrics) are skipped. */
export function applyLineRecording(links: readonly ChartLink[], recording: LineRecording): ChartLink[] {
  return links.map((link) => {
    const beats = recording.get(link.markerId);
    return beats && beats.length > 1 ? { ...link, lineBeats: [...beats] } : link;
  });
}
