import {
  markerCategory,
  type ChartLink,
  type MarkerKind,
  type SectionMarkerSummary,
  type SongRegionSummary,
} from "../models";

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

/** One block of the lyrics as the song plays them: a marker and the sheet
 * section it shows (none for a part the sheet has no words for). */
export type PerformanceBlock = {
  /** Its place in the played sequence: stable while it stays on screen. */
  key: string;
  markerId: string;
  /** The marker's name: what the band calls this part. */
  label: string;
  section: number | null;
  /** Shown because a jump to it is scheduled, not because it comes next. */
  queued: boolean;
};

/** What has played, in the order it played: one entry per section marker
 * reached, numbered so each keeps its place (and its key) on screen. */
export type PlayHistory = ReadonlyArray<{ seq: number; markerId: string }>;

/** Played blocks kept above the current one: enough to see where you came
 * from, not a list that grows all night. */
export const PLAY_HISTORY_LIMIT = 6;

/**
 * The history after the playhead reaches `markerId`: the same if it is still
 * in the same part, one more entry if it moved on — by playing, by a jump, by
 * a seek. `null` (before the first marker) leaves it as it is.
 */
export function advancePlayHistory(history: PlayHistory, markerId: string | null): PlayHistory {
  if (markerId === null) return history;
  const last = history[history.length - 1];
  if (last?.markerId === markerId) return history;
  const next = [...history, { seq: last ? last.seq + 1 : 0, markerId }];
  return next.length > PLAY_HISTORY_LIMIT + 1 ? next.slice(next.length - PLAY_HISTORY_LIMIT - 1) : next;
}

/**
 * The lyrics as the performer lives them: what has played, in the order it
 * played, then what comes next. Reading only ever goes down — a chorus that
 * plays three times shows three times, the intro that comes back shows BELOW
 * the chorus, and after a jump the song goes on below the jump instead of
 * scrolling back to where the target sits on the timeline.
 *
 * What comes next is the markers after the current one on the timeline (an
 * applied arrangement included) or, with a jump to a marker of this song
 * scheduled, that marker and what follows it.
 *
 * Keys follow the position in that sequence, so the preview of a jump and
 * the block it becomes once the jump happens are the same element: nothing
 * moves on screen when it lands.
 */
export function buildPerformanceBlocks(
  doc: ChartDoc,
  links: readonly ChartLink[],
  markers: readonly SectionMarkerSummary[],
  history: PlayHistory,
  pendingMarkerId: string | null,
): { blocks: PerformanceBlock[]; current: number } {
  const block = (marker: SectionMarkerSummary, key: string, queued: boolean): PerformanceBlock => {
    const link = chartLinkFor(links, marker.id);
    return {
      key,
      markerId: marker.id,
      label: marker.name,
      section: link && link.section < doc.sections.length ? link.section : null,
      queued,
    };
  };
  const byId = new Map(markers.map((marker, index) => [marker.id, index]));
  const played = history.filter((entry) => byId.has(entry.markerId));
  const last = played[played.length - 1];
  if (!last) {
    return { blocks: markers.map((marker, index) => block(marker, `s${index}`, false)), current: -1 };
  }
  const blocks = played.map((entry) => block(markers[byId.get(entry.markerId)!], `s${entry.seq}`, false));
  const target = pendingMarkerId !== null ? byId.get(pendingMarkerId) : undefined;
  const queued = target !== undefined;
  const from = queued ? target : byId.get(last.markerId)! + 1;
  markers.slice(from).forEach((marker, index) => {
    blocks.push(block(marker, `s${last.seq + 1 + index}`, queued));
  });
  return { blocks, current: played.length - 1 };
}

/** A line change time as the editor shows it: `m:ss.d` (song time). */
export function formatLineTime(seconds: number): string {
  const tenths = Math.round(Math.max(0, seconds) * 10);
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths - minutes * 600) / 10;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

/** Reads `m:ss.d`, `m:ss`, `ss.d` or `ss` (a comma works as the decimal
 * point too). `null` if it is not a time. */
export function parseLineTime(text: string): number | null {
  const clean = text.trim().replace(",", ".");
  const match = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(clean);
  if (!match) return null;
  const minutes = match[1] ? Number(match[1]) : 0;
  const seconds = Number(match[2]);
  if (match[1] && seconds >= 60) return null;
  return minutes * 60 + seconds;
}

/** Smallest gap kept between two line changes. */
const MIN_LINE_GAP_SECONDS = 0.1;

/**
 * Line starts (seconds from the marker) with line `index` moved to `seconds`,
 * kept between its neighbours so lines never cross. The first line always
 * starts at the marker.
 */
export function moveLineStart(
  starts: readonly number[],
  index: number,
  seconds: number,
  sectionSeconds: number,
): number[] {
  const next = [...starts];
  if (index <= 0 || index >= next.length || !Number.isFinite(seconds)) return next;
  const low = next[index - 1] + MIN_LINE_GAP_SECONDS;
  const high = (index + 1 < next.length ? next[index + 1] : sectionSeconds) - MIN_LINE_GAP_SECONDS;
  next[index] = Math.min(Math.max(seconds, low), Math.max(low, high));
  return next;
}
