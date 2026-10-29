import { buildSongTempoRegions } from "@libretracks/shared/models";
import {
  getBeatDurationSeconds,
  nextDownbeatAfter,
  parseTimeSignature,
} from "@libretracks/shared/timelineMath";

import type {
  GuideAnalysis,
  MarkerCategory,
  MarkerKind,
  ProposedSignatureMarker,
  ProposedTempoMarker,
  SongRegionSummary,
  SongView,
  TempoLevel,
  TempoProposal,
  TempoReading,
} from "../desktopApi";
import { isCueTrackName } from "../levelSongs/levelSongsPlan";
import { CUE_KINDS, MARKER_KINDS, markerKindVariants } from "../markerKinds";

/**
 * Pure helpers of "Analizar canción": which track is the click, which tracks
 * carry the harmony the key is read from, and what to send to
 * `applySongAnalysis` once the user has reviewed and edited the proposal.
 */

/** The click stem, Spanish and English, as `isCueTrackName` spells it. */
const CLICK_NAME = /\b(click|clic|clik|metr[oó]nom[oe]?)\b/i;

/** Shortest overlap that puts a clip inside a song (see level_songs.rs). */
const MIN_SONG_OVERLAP_SECONDS = 0.01;
/** Same marker position, as the backend compares them. */
const SAME_POSITION_SECONDS = 0.0005;
/** A marker this close to 0 sets the song's own tempo (`SONG_ORIGIN_SECONDS`). */
const SESSION_ORIGIN_SECONDS = 0.0001;

export type ClickTrackOption = { id: string; name: string; looksLikeClick: boolean };

/**
 * Audio tracks with sound inside the song, click-named first. The first one is
 * preselected only when its name says it is a click: guessing any other track
 * would analyse a guitar as a metronome.
 */
export function clickTrackOptions(
  song: SongView,
  regionId: string,
): { options: ClickTrackOption[]; preselected: string | null } {
  const region = song.regions.find((candidate) => candidate.id === regionId);
  if (!region) return { options: [], preselected: null };
  const sounds = (trackId: string) =>
    song.clips.some(
      (clip) =>
        clip.trackId === trackId &&
        Math.max(clip.timelineStartSeconds, region.startSeconds) + MIN_SONG_OVERLAP_SECONDS <
          Math.min(clip.timelineStartSeconds + clip.durationSeconds, region.endSeconds),
    );
  const options = song.tracks
    .filter((track) => track.kind === "audio" && sounds(track.id))
    .map((track) => ({
      id: track.id,
      name: track.name,
      looksLikeClick: CLICK_NAME.test(track.name),
    }));
  // Stable: click-named first, session order otherwise.
  options.sort((a, b) => Number(b.looksLikeClick) - Number(a.looksLikeClick));
  const preselected = options[0]?.looksLikeClick ? options[0].id : null;
  return { options, preselected };
}

/**
 * Drums and percussion: pitched noise that only blurs the chromagram. A name
 * test, like the click's; the user can tick them back.
 */
const PERCUSSION_NAME =
  /\b(drums?|bater[ií]a|kick|bombo|snare|caja|perc\w*|hi-?hats?|hats?|loops?|toms?|overheads?|oh|cymbals?|platos?|shakers?|pandero\w*|tamb\w*|claps?|room)\b/i;

export type KeyTrackOption = { id: string; name: string; preselected: boolean };

/**
 * Audio tracks with sound inside the song, for the key. Preselected: all but
 * the click, cues, guide and percussion (the folder a track sits in counts,
 * so "Drums / Kick" is out).
 */
export function keyTrackOptions(song: SongView, regionId: string): KeyTrackOption[] {
  const region = song.regions.find((candidate) => candidate.id === regionId);
  if (!region) return [];
  const byId = new Map(song.tracks.map((track) => [track.id, track]));
  const names = (trackId: string) => {
    const chain: string[] = [];
    let current = byId.get(trackId);
    // Bounded like the engine's folder walk.
    for (let depth = 0; current && depth < 8; depth += 1) {
      chain.push(current.name);
      current = current.parentTrackId ? byId.get(current.parentTrackId) : undefined;
    }
    return chain;
  };
  const sounds = (trackId: string) =>
    song.clips.some(
      (clip) =>
        clip.trackId === trackId &&
        Math.max(clip.timelineStartSeconds, region.startSeconds) + MIN_SONG_OVERLAP_SECONDS <
          Math.min(clip.timelineStartSeconds + clip.durationSeconds, region.endSeconds),
    );
  return song.tracks
    .filter((track) => track.kind === "audio" && sounds(track.id))
    .map((track) => {
      const chain = names(track.id);
      const excluded = chain.some(
        (name) => isCueTrackName(name) || CLICK_NAME.test(name) || PERCUSSION_NAME.test(name),
      );
      return { id: track.id, name: track.name, preselected: !excluded };
    });
}

/**
 * No click: the tracks the tempo is estimated from. Everything with sound in
 * the song but the click and the cues; drums are the best of it.
 */
export function musicTempoTrackIds(song: SongView, regionId: string): string[] {
  return keyTrackOptions(song, regionId)
    .filter((option) => {
      const track = song.tracks.find((candidate) => candidate.id === option.id);
      const name = track?.name ?? "";
      return !isCueTrackName(name) && !CLICK_NAME.test(name);
    })
    .map((option) => option.id);
}

/** "Digno de Adorar-MSM-D-71bpm", "Bb 70 Bpm", "(120 BPM)". */
const NAME_BPM = /(?:^|[^\d.,])(\d{2,3}(?:[.,]\d{1,2})?)\s*[-_]?\s*bpm(?![a-z])/i;
/** A name's tempo this close to a reading's picks that reading. */
const NAME_BPM_TOLERANCE = 0.03;

/**
 * The tempo a multitrack names itself with, from the song (region) name or
 * the folders and files of the click inside it. Null when none says one.
 */
export function bpmFromNames(
  song: SongView,
  regionId: string,
  clickTrackId: string,
): number | null {
  const region = song.regions.find((candidate) => candidate.id === regionId);
  if (!region) return null;
  const clickPaths = song.clips
    .filter(
      (clip) =>
        clip.trackId === clickTrackId &&
        clip.timelineStartSeconds < region.endSeconds &&
        clip.timelineStartSeconds + clip.durationSeconds > region.startSeconds,
    )
    .map((clip) => clip.filePath);
  for (const name of [region.name, ...clickPaths]) {
    const match = NAME_BPM.exec(name.normalize("NFC"));
    const bpm = match ? Number(match[1].replace(",", ".")) : NaN;
    if (bpm >= 30 && bpm <= 300) return bpm;
  }
  return null;
}

/**
 * Whether the review starts on the click read as eighths (÷2): only when a
 * name says that tempo and not the click's own. A click without accent
 * cannot tell 142 from 71 in eighths, and the user's ÷2 / ×2 decides.
 */
export function startsOnEighths(
  namedBpm: number | null,
  clickBpm: number | undefined,
  eighthsBpm: number | undefined,
): boolean {
  if (namedBpm === null || clickBpm === undefined || eighthsBpm === undefined) return false;
  const near = (bpm: number) => Math.abs(namedBpm / bpm - 1) <= NAME_BPM_TOLERANCE;
  return near(eighthsBpm) && !near(clickBpm);
}

/**
 * Every tempo marker's BPM times `factor` (×2 / ÷2 for a tempo estimated at
 * double or half). Values that would leave the app's range stay as they are.
 */
export function scaleTempoRows(rows: ReviewRow[], factor: number): ReviewRow[] {
  return rows.map((row) => {
    if (row.kind !== "tempo") return row;
    const bpm = parseBpm(row.text);
    if (bpm === null) return row;
    const scaled = Math.round(bpm * factor * 100) / 100;
    return scaled >= 20 && scaled <= 300 ? { ...row, text: String(scaled) } : row;
  });
}

/**
 * How closely the tempo markers follow the click: bar by bar (the default,
 * so metronome and grid match the click), fewer markers with a steady tempo
 * or a ramp per drifting passage, or only the tempo the song starts at.
 */
export type TempoDetail = "follow" | "simplified" | "initial";

export const DEFAULT_TEMPO_DETAIL: TempoDetail = "follow";

export function tempoLevel(reading: TempoReading, detail: TempoDetail): TempoLevel {
  if (detail === "simplified") return reading.simplified;
  if (detail === "initial") return reading.initial;
  return { segments: reading.analysis.segments, proposal: reading.proposal };
}

/** The detail choice matters only when the click changes tempo somewhere. */
export function offersTempoDetail(reading: TempoReading): boolean {
  return reading.analysis.segments.length > 1;
}

/**
 * The song as recorded against the song as it plays. The analysis reads the
 * song as recorded (no warp or varispeed), where the tempo markers are
 * stored; the timeline shows it as it plays. Warp and varispeed play a whole
 * song at one speed, so inside it times scale, and after it they shift.
 */
export type AnalysisTimeline = {
  regionStartSeconds: number;
  regionEndSeconds: number;
  renderStartSeconds: number;
  viewScale: number;
};

const SAME_TIMELINE: AnalysisTimeline = {
  regionStartSeconds: 0,
  regionEndSeconds: 0,
  renderStartSeconds: 0,
  viewScale: 1,
};

/** A recorded (stored) second as the song plays it. */
export function viewSeconds(timeline: AnalysisTimeline, seconds: number): number {
  const { regionStartSeconds, regionEndSeconds, renderStartSeconds, viewScale } = timeline;
  const viewEnd = renderStartSeconds + (regionEndSeconds - regionStartSeconds) * viewScale;
  if (seconds < regionStartSeconds) return seconds + renderStartSeconds - regionStartSeconds;
  if (seconds >= regionEndSeconds) return seconds + viewEnd - regionEndSeconds;
  return renderStartSeconds + (seconds - regionStartSeconds) * viewScale;
}

/** A second as the song plays it, as recorded (stored). */
export function storedSeconds(timeline: AnalysisTimeline, seconds: number): number {
  const { regionStartSeconds, regionEndSeconds, renderStartSeconds, viewScale } = timeline;
  const viewEnd = renderStartSeconds + (regionEndSeconds - regionStartSeconds) * viewScale;
  if (seconds < renderStartSeconds) return seconds - renderStartSeconds + regionStartSeconds;
  if (seconds >= viewEnd) return seconds - viewEnd + regionEndSeconds;
  return regionStartSeconds + (seconds - renderStartSeconds) / (viewScale || 1);
}

/** The tempo map to write, where it falls as the song plays (its BPM are
 * already the ones it plays at, or the grid applies the varispeed). */
export function tempoInView(
  tempo: { tempoMarkers: ProposedTempoMarker[]; signatureMarkers: ProposedSignatureMarker[] },
  timeline: AnalysisTimeline,
): { tempoMarkers: ProposedTempoMarker[]; signatureMarkers: ProposedSignatureMarker[] } {
  return {
    tempoMarkers: tempo.tempoMarkers.map((marker) => ({
      ...marker,
      startSeconds: viewSeconds(timeline, marker.startSeconds),
    })),
    signatureMarkers: tempo.signatureMarkers.map((marker) => ({
      ...marker,
      startSeconds: viewSeconds(timeline, marker.startSeconds),
    })),
  };
}

/** The guide stem: a voice announcing the sections. */
const GUIDE_NAME = /\b(guides?|gu[ií]as?|cues?)\b/i;

/** Audio tracks with sound in the song, the guide-named one preselected. */
export function guideTrackOptions(
  song: SongView,
  regionId: string,
): { options: { id: string; name: string }[]; preselected: string | null } {
  const options = keyTrackOptions(song, regionId).map(({ id, name }) => ({ id, name }));
  const named = options.find((option) => GUIDE_NAME.test(option.name.normalize("NFC")));
  return { options, preselected: named?.id ?? null };
}

/**
 * What a guide group puts on the timeline: a section (`chorus`,
 * `verse:3`, or "" for none), a cue (`drums_in`, or ""), or nothing because
 * it is ignored (the count-in of the announcement before it). A count said
 * on its own has the cue `count`: one count marker per number, on its beat. "Verso 3, entra batería" is both a section and
 * a cue. The cue may be a section kind: "Verso a capella" is the section
 * verse plus a capella in the cue lane, since two sections cannot share a
 * spot. The section may be a cue kind: "Toda la banda" said with a count-in
 * starts a section, so it goes in the section lane.
 */
export type GroupMarkers = { section: string; cue: string; ignored: boolean };

const isSectionKind = (kind: string) => MARKER_KINDS.includes(kind as MarkerKind);
const isCueKind = (kind: string) => CUE_KINDS.includes(kind as MarkerKind);

/** One label (`verse_3`, `drums_in`) as a select value (`verse:3`), if known. */
function labelValue(label: string): { value: string; cue: boolean } | null {
  const match = /^([a-z_]+?)(?:_(\d+))?$/.exec(label);
  if (!match) return null;
  const kind = match[1];
  const variant = match[2] ? Number(match[2]) : null;
  if (isCueKind(kind) && !isSectionKind(kind)) return { value: kind, cue: true };
  if (!isSectionKind(kind)) return null;
  const offered = variant !== null && markerKindVariants(kind as MarkerKind).includes(variant);
  return { value: offered ? `${kind}:${variant}` : kind, cue: false };
}

/** The markers a group's labels name: its first section and its first cue;
 * with a count-in and no section named, the cue is the section. */
export function markersForLabels(labels: string[], countedIn = false): GroupMarkers {
  if (labels.includes("count")) return { section: "", cue: "", ignored: true };
  if (labels.includes("spoken_count")) return { section: "", cue: "count", ignored: false };
  let section = "";
  let cue = "";
  let extraSection = "";
  for (const label of labels) {
    const value = labelValue(label);
    if (!value) continue;
    if (value.cue && !cue) cue = value.value;
    else if (!value.cue && !section) section = value.value;
    else if (!value.cue && !extraSection) extraSection = value.value;
  }
  if (countedIn && !section && cue) return { section: cue, cue: extraSection, ignored: false };
  // A second section, with no cue named, rides in the cue lane.
  return { section, cue: cue || extraSection, ignored: false };
}

/** Nothing recognised and not ignored: the review asks the user. */
export function isUnrecognised(markers: GroupMarkers | undefined): boolean {
  return !markers || (!markers.ignored && markers.section === "" && markers.cue === "");
}

function parseMarkerValue(value: string): { kind: MarkerKind; variant: number | null } | null {
  if (!value) return null;
  const [kind, variant] = value.split(":");
  return { kind: kind as MarkerKind, variant: variant ? Number(variant) : null };
}

/**
 * The voice speaks in the bar before its section, but the tail of its last
 * word ("…cuatro") can run a few milliseconds past the section's downbeat:
 * measured on a real guide against markers placed by hand. A downbeat this
 * many beats before the end of the announcement still counts as after it.
 */
const ANNOUNCEMENT_TAIL_BEATS = 0.3;

/**
 * A long announcement said from beat 1 of the bar before its section
 * ("Intro, toda la banda", "Verso, toda la banda" in "Rey de Reyes", 147 BPM)
 * can fill that bar and run past the section's downbeat: by 0.37 beats
 * there, with the band coming in on that downbeat. Started this close to a
 * downbeat, an announcement whose end runs up to `LONG_TAIL_BEATS` past the
 * next one still belongs to it.
 */
const ON_DOWNBEAT_BEATS = 0.25;

/** A count-in follows its announcement within this (the analysis's
 * `COUNT_FOLLOWS_SECONDS`). */
const COUNT_IN_GAP_SECONDS = 1.2;
const LONG_TAIL_BEATS = 0.5;

/** An announcement starts this close to a beat (share of a beat) to say
 * which beat of the bar it is spoken on. */
const ON_BEAT_SHARE = 0.15;

/**
 * Section announcements spoken off the click's bar, in runs, start their
 * section a bar after they start: mid-bar on the click. A guide speaks each
 * name from beat 1 of the bar before its section, and when the song has a
 * short bar the click does not keep (no accent, or an accent in a steady
 * 4/4), every announcement after it starts that many beats off, until
 * another brings them back: "Goodness of God" (its .als has 2/4 bars at
 * beats 28, 94, 216), "Poema de salvación" (coro, instrumental, versos 1-2
 * two beats off, as the user placed them). A guide that says single names
 * on beat 3 ("Es Él": "Pre coro" two beats before its section) leaves lone
 * ones off among ones on beat 1: then this says nothing. The click's bars
 * are not changed (no 2/4): players follow its accent. Returns announcement
 * index → where its section starts, and the beats off the click's bar the
 * song is at a time (0 where it is on it).
 */
function sectionsOffTheBar(
  announcements: GuideAnalysis["announcements"],
  markers: GroupMarkers[],
  renderStartSeconds: number,
  beatAt: (seconds: number) => number,
  nearestBeat: (seconds: number) => number,
  beatInBar: (beat: number) => number,
  barAt: (seconds: number) => number,
  leadBars: number,
): { sections: Map<number, number>; offsetAt: (seconds: number) => number } {
  const spoken: { index: number; beat: number; phase: number }[] = [];
  for (const [index, announcement] of announcements.entries()) {
    const group = markers[announcement.group];
    if (!group || group.ignored || !group.section) continue;
    const start = renderStartSeconds + announcement.startSeconds;
    const beat = nearestBeat(start);
    if (Math.abs(beat - start) > ON_BEAT_SHARE * beatAt(start)) continue;
    spoken.push({ index, beat, phase: beatInBar(beat) });
  }
  const runs: (typeof spoken)[] = [];
  for (const one of spoken) {
    const run = runs[runs.length - 1];
    if (run && run[0].phase === one.phase) run.push(one);
    else runs.push([one]);
  }
  const sections = new Map<number, number>();
  if (runs.length < 2 || runs[0][0].phase !== 0 || runs.some((run) => run.length < 2)) {
    return { sections, offsetAt: () => 0 };
  }
  for (const run of runs) {
    if (run[0].phase === 0) continue;
    for (const { index, beat } of run) sections.set(index, beat + leadBars * barAt(beat));
  }
  // A run's bars hold from its first announcement to the next run's.
  const offsetAt = (seconds: number) => {
    let phase = 0;
    for (const run of runs) {
      if (run[0].beat - beatAt(run[0].beat) / 2 > seconds) break;
      phase = run[0].phase;
    }
    return phase;
  };
  return { sections, offsetAt };
}

/**
 * Where each announcement's markers go: on the first downbeat after the
 * announcement ends (see `ANNOUNCEMENT_TAIL_BEATS`), or `leadBars - 1` bars
 * later for a guide that speaks two bars ahead. A cue said on its own
 * ("Bajar intensidad") goes a bar before that downbeat: the voice guide
 * speaks a cue on its marker, and it is a warning of what comes. A count
 * said on its own puts each number on the beat it is said on. The grid is
 * the song's, or the one the tempo review is about to write when `tempo` is
 * given. Returns rendered-timeline seconds.
 */
export function placeGuideSections(
  song: SongView,
  regionId: string,
  renderStartSeconds: number,
  analysis: GuideAnalysis,
  markers: GroupMarkers[],
  tempo: { tempoMarkers: ProposedTempoMarker[]; signatureMarkers: ProposedSignatureMarker[] } | null,
  leadBars = 1,
): {
  startSeconds: number;
  kind: MarkerKind;
  variant: number | null;
  categoryOverride: MarkerCategory | null;
}[] {
  const region = song.regions.find((candidate) => candidate.id === regionId);
  if (!region) return [];
  let grid = song;
  if (tempo) {
    // A marker at the session's very start is the song's own tempo or
    // meter (that is how applying writes it), not a marker: the grid's
    // regions skip markers at 0.
    const atOrigin = (seconds: number) => seconds <= SESSION_ORIGIN_SECONDS;
    const originTempo = tempo.tempoMarkers.find((marker) => atOrigin(marker.startSeconds));
    const originSignature = tempo.signatureMarkers.find((marker) =>
      atOrigin(marker.startSeconds),
    );
    const inside = (seconds: number) =>
      seconds >= region.startSeconds - SAME_POSITION_SECONDS &&
      seconds < region.endSeconds - SAME_POSITION_SECONDS;
    grid = {
      ...song,
      bpm: originTempo?.bpm ?? song.bpm,
      timeSignature: originSignature?.signature ?? song.timeSignature,
      tempoMarkers: [
        ...song.tempoMarkers.filter((marker) => !inside(marker.startSeconds)),
        ...tempo.tempoMarkers.map((marker, index) => ({
          id: `proposed-tempo-${index}`,
          startSeconds: marker.startSeconds,
          bpm: marker.bpm,
          ramp: marker.ramp === true,
        })),
      ].sort((a, b) => a.startSeconds - b.startSeconds),
      timeSignatureMarkers: [
        ...song.timeSignatureMarkers.filter((marker) => !inside(marker.startSeconds)),
        ...tempo.signatureMarkers.map((marker, index) => ({
          id: `proposed-signature-${index}`,
          startSeconds: marker.startSeconds,
          signature: marker.signature,
        })),
      ].sort((a, b) => a.startSeconds - b.startSeconds),
    };
  }
  const regions = buildSongTempoRegions(grid);
  const regionAt = (seconds: number) =>
    regions.find((r) => seconds >= r.startSeconds && seconds < r.endSeconds) ??
    regions[regions.length - 1];
  const beatAt = (seconds: number) => {
    const current = regionAt(seconds);
    return current
      ? getBeatDurationSeconds(current.bpm, current.timeSignature)
      : getBeatDurationSeconds(grid.bpm, grid.timeSignature);
  };
  const barAt = (seconds: number) =>
    beatAt(seconds) *
    parseTimeSignature(regionAt(seconds)?.timeSignature ?? grid.timeSignature).beatsPerBar;
  const downbeatFrom = (seconds: number) =>
    nextDownbeatAfter(seconds, grid.bpm, grid.timeSignature, regions);
  // The downbeat a bar before one.
  const barBefore = (downbeat: number) => {
    const probe = downbeat - beatAt(downbeat) / 4;
    return downbeatFrom(downbeat - barAt(probe) - beatAt(probe) / 2);
  };
  // Bars restart at the song's start: a beat near it is not found on the
  // grid of the song before ("Conteo 1" landed 0.3 s before the song).
  const songStart = downbeatFrom(renderStartSeconds - SAME_POSITION_SECONDS);
  const nearestBeat = (seconds: number) => {
    const beat = beatAt(seconds);
    const lookBack = seconds - barAt(seconds) - beat / 2;
    const barStart =
      seconds >= songStart - SAME_POSITION_SECONDS && lookBack < songStart
        ? songStart
        : downbeatFrom(lookBack);
    return barStart + Math.round((seconds - barStart) / beat) * beat;
  };
  // Which beat of its bar (0 = the downbeat) a beat on the grid is.
  const beatInBar = (beatSeconds: number) => {
    const beat = beatAt(beatSeconds);
    const lookBack = beatSeconds - barAt(beatSeconds) + beat / 2;
    const barStart =
      beatSeconds >= songStart - SAME_POSITION_SECONDS && lookBack < songStart
        ? songStart
        : downbeatFrom(lookBack);
    return Math.round((beatSeconds - barStart) / beat) % (Math.round(barAt(beatSeconds) / beat) || 1);
  };
  const { sections: offTheBar, offsetAt } = sectionsOffTheBar(
    analysis.announcements,
    markers,
    renderStartSeconds,
    beatAt,
    nearestBeat,
    beatInBar,
    barAt,
    leadBars,
  );
  // Counts said on their own that are a section's count-in: the voice guide
  // counts that section in by itself.
  const countIns = new Set<number>();
  // The last section placed, and where its announcement started: a cue said
  // apart in its lead-in ("Chorus." … "Drums in.") is that section's.
  let lastSection: { announced: number; spot: number } | null = null;
  const placed: {
    startSeconds: number;
    kind: MarkerKind;
    variant: number | null;
    categoryOverride: MarkerCategory | null;
  }[] = [];
  const onSpot = (seconds: number) =>
    placed.filter((other) => Math.abs(other.startSeconds - seconds) < SAME_POSITION_SECONDS);
  for (const [index, announcement] of analysis.announcements.entries()) {
    const group = markers[announcement.group];
    if (!group || group.ignored) continue;
    if (!group.section && group.cue === "count" && announcement.countWords?.length) {
      if (countIns.has(index)) continue;
      for (const word of announcement.countWords) {
        const startSeconds = nearestBeat(renderStartSeconds + word.startSeconds);
        // One marker per spot and lane: a count on a cue's beat is that cue.
        if (onSpot(startSeconds).some((other) => !inSectionLane(other))) continue;
        placed.push({ startSeconds, kind: "count", variant: word.number, categoryOverride: null });
      }
      continue;
    }
    // The section comes after its count-in, which may be said well after
    // the words: "Intro." on the pickup, then a whole bar "uno, dos, tres,
    // cuatro" before the intro starts.
    let endSeconds = announcement.endSeconds;
    for (const next of analysis.announcements.slice(index + 1)) {
      if (!markers[next.group]?.ignored || next.startSeconds - endSeconds > COUNT_IN_GAP_SECONDS) {
        break;
      }
      endSeconds = next.endSeconds;
    }
    let end = renderStartSeconds + endSeconds;
    const sectionAfter = (seconds: number) =>
      nextDownbeatAfter(
        seconds - ANNOUNCEMENT_TAIL_BEATS * beatAt(seconds),
        grid.bpm,
        grid.timeSignature,
        regions,
      );
    let startSeconds = sectionAfter(end);
    // A count said on its own that starts by the time the section would is
    // its count-in, a bar or more after the words ("Poema de salvación":
    // "Intro." before the click, then a bar of "uno, dos, tres, cuatro"
    // from that downbeat): the section starts after it, and the voice
    // guide's own count-in replaces the count's markers.
    for (const [offset, next] of analysis.announcements.slice(index + 1).entries()) {
      const nextMarkers = markers[next.group];
      const spokenCount = nextMarkers && !nextMarkers.section && nextMarkers.cue === "count";
      const nextStart = renderStartSeconds + next.startSeconds;
      if (!spokenCount || nextStart > startSeconds + ON_DOWNBEAT_BEATS * beatAt(startSeconds)) {
        break;
      }
      if (group.section) countIns.add(index + 1 + offset);
      end = renderStartSeconds + next.endSeconds;
      startSeconds = sectionAfter(end);
    }
    const start = renderStartSeconds + announcement.startSeconds;
    const barStart = downbeatFrom(start - ON_DOWNBEAT_BEATS * beatAt(start));
    if (Math.abs(barStart - start) <= ON_DOWNBEAT_BEATS * beatAt(start)) {
      const nextBar = downbeatFrom(barStart + beatAt(barStart) / 2);
      if (startSeconds > nextBar && end <= nextBar + LONG_TAIL_BEATS * beatAt(nextBar)) {
        startSeconds = nextBar;
      }
    }
    for (let extra = 1; extra < leadBars; extra += 1) {
      startSeconds = nextDownbeatAfter(
        startSeconds + beatAt(startSeconds) / 2,
        grid.bpm,
        grid.timeSignature,
        regions,
      );
    }
    startSeconds = offTheBar.get(index) ?? startSeconds;
    const slots = [
      { marker: parseMarkerValue(group.section), sectionSlot: true },
      { marker: parseMarkerValue(group.cue), sectionSlot: false },
    ];
    // A cue alongside a section is chained into the section's lead-in by the
    // voice guide; on its own it is spoken on its marker, so it warns a bar
    // ahead, where the guide said it. Said apart but in the lead-in of a
    // section announced just before ("Chorus." … "Drums in."), it is that
    // section's.
    const inLeadOf =
      !group.section && lastSection && start > lastSection.announced && start < lastSection.spot
        ? lastSection.spot
        : null;
    const inSectionLead = onSpot(startSeconds).some((other) => inSectionLane(other));
    // In a stretch off the click's bar, a cue said on its own warns from the
    // bar it is said in, as the guide counts it.
    const offset = offsetAt(start);
    const saidOn = nearestBeat(start);
    const offBarCue =
      offset !== 0 && Math.abs(saidOn - start) <= ON_BEAT_SHARE * beatAt(start)
        ? saidOn -
          (((beatInBar(saidOn) - offset) % Math.round(barAt(saidOn) / beatAt(saidOn)) +
            Math.round(barAt(saidOn) / beatAt(saidOn))) %
            Math.round(barAt(saidOn) / beatAt(saidOn))) *
            beatAt(saidOn)
        : null;
    const cueSpot =
      inLeadOf ??
      (group.section || inSectionLead ? startSeconds : (offBarCue ?? barBefore(startSeconds)));
    if (group.section) lastSection = { announced: start, spot: startSeconds };
    for (const { marker, sectionSlot } of slots) {
      if (!marker) continue;
      const spot = sectionSlot ? startSeconds : cueSpot;
      const here = onSpot(spot);
      // The same marker twice on one downbeat ("Coro 1." … "Coro 1.") is one.
      if (here.some((other) => other.kind === marker.kind && other.variant === marker.variant)) {
        continue;
      }
      // Two sections cannot share a spot: the later one goes in the cue lane.
      const sectionHere = here.some((other) => inSectionLane(other));
      const categoryOverride: MarkerCategory | null = isSectionKind(marker.kind)
        ? sectionHere
          ? "cue"
          : null
        : sectionSlot && !sectionHere
          ? "section"
          : null;
      // Nor two cues: the engine rejects two markers on one spot of a lane
      // ("markers are out of order") and the whole analysis with them. A
      // named cue is worth more than a count's number on its beat.
      if (!inSectionLane({ kind: marker.kind, categoryOverride })) {
        const cueHere = here.find((other) => !inSectionLane(other));
        if (cueHere && cueHere.kind !== "count") continue;
        if (cueHere) placed.splice(placed.indexOf(cueHere), 1);
      }
      placed.push({ startSeconds: spot, ...marker, categoryOverride });
    }
  }
  return placed;
}

function inSectionLane(marker: { kind: string; categoryOverride: MarkerCategory | null }) {
  return marker.categoryOverride
    ? marker.categoryOverride === "section"
    : isSectionKind(marker.kind);
}

/** "1:05.3", from the song start. */
export function formatSongPosition(secondsFromSongStart: number): string {
  const safe = Math.max(0, secondsFromSongStart);
  const minutes = Math.floor(safe / 60);
  const seconds = safe - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

export function parseBpm(text: string): number | null {
  const value = Number(text.replace(",", ".").trim());
  return Number.isFinite(value) && value >= 20 && value <= 300 ? value : null;
}

export function parseSignature(text: string): string | null {
  const match = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/.exec(text);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (numerator < 1 || ![1, 2, 4, 8, 16, 32].includes(denominator)) return null;
  return `${numerator}/${denominator}`;
}

/** One editable row of the review: a proposed marker and its current text. */
export type ReviewRow =
  | {
      kind: "tempo";
      index: number;
      startSeconds: number;
      text: string;
      /** Ramps to the next tempo row. */
      ramp: boolean;
    }
  | {
      kind: "signature";
      index: number;
      startSeconds: number;
      text: string;
    };

export function reviewRows(proposal: TempoProposal): ReviewRow[] {
  const rows: ReviewRow[] = [
    ...proposal.tempoMarkers.map((marker, index) => ({
      kind: "tempo" as const,
      index,
      startSeconds: marker.startSeconds,
      text: String(marker.bpm),
      ramp: marker.ramp === true,
    })),
    ...proposal.signatureMarkers.map((marker, index) => ({
      kind: "signature" as const,
      index,
      startSeconds: marker.startSeconds,
      text: marker.signature,
    })),
  ];
  // Tempo before meter at the same spot, the way the ruler reads.
  return rows.sort(
    (a, b) =>
      a.startSeconds - b.startSeconds || (a.kind === b.kind ? 0 : a.kind === "tempo" ? -1 : 1),
  );
}

export function rowIsValid(row: ReviewRow): boolean {
  return row.kind === "tempo" ? parseBpm(row.text) !== null : parseSignature(row.text) !== null;
}

/**
 * What to apply. Applying replaces BOTH kinds of markers inside the song, so
 * the kind the user left out is sent back as the song has it now.
 */
export function buildApplyPayload(
  song: SongView,
  regionId: string,
  rows: ReviewRow[],
  include: { tempo: boolean; signature: boolean },
  timeline: AnalysisTimeline = SAME_TIMELINE,
): { tempoMarkers: ProposedTempoMarker[]; signatureMarkers: ProposedSignatureMarker[] } | null {
  const region = song.regions.find((candidate) => candidate.id === regionId);
  if (!region) return null;
  const inside = (seconds: number) =>
    seconds >= region.startSeconds - SAME_POSITION_SECONDS &&
    seconds < region.endSeconds - SAME_POSITION_SECONDS;

  let tempoMarkers: ProposedTempoMarker[];
  if (include.tempo) {
    tempoMarkers = [];
    for (const row of rows) {
      if (row.kind !== "tempo") continue;
      const bpm = parseBpm(row.text);
      if (bpm === null) return null;
      tempoMarkers.push({
        startSeconds: row.startSeconds,
        bpm,
        ...(row.ramp ? { ramp: true } : {}),
      });
    }
  } else {
    tempoMarkers = song.tempoMarkers
      .filter((marker) => inside(marker.startSeconds))
      .map((marker) => ({
        startSeconds: storedSeconds(timeline, marker.startSeconds),
        bpm: marker.bpm,
        ...(marker.ramp ? { ramp: true } : {}),
      }));
  }

  let signatureMarkers: ProposedSignatureMarker[];
  if (include.signature) {
    signatureMarkers = [];
    for (const row of rows) {
      if (row.kind !== "signature") continue;
      const signature = parseSignature(row.text);
      if (signature === null) return null;
      signatureMarkers.push({
        startSeconds: row.startSeconds,
        signature,
      });
    }
  } else {
    signatureMarkers = song.timeSignatureMarkers
      .filter((marker) => inside(marker.startSeconds))
      .map((marker) => ({
        startSeconds: storedSeconds(timeline, marker.startSeconds),
        signature: marker.signature,
      }));
  }
  return { tempoMarkers, signatureMarkers };
}

/** How far a detected key change may move to land on a section start. */
export const KEY_CHANGE_SNAP_SECONDS = 4;

/**
 * Key changes onto the nearest section start within
 * `KEY_CHANGE_SNAP_SECONDS`. A modulation almost always opens a section (the
 * last chorus up a tone), and the analysis only places it to about a second;
 * the section marker is where the band actually changes. One with no section
 * near stays where it was found. Seconds on the same timeline as `sectionStarts`.
 */
export function snapKeyChangesToSections<T extends { startSeconds: number }>(
  changes: T[],
  sectionStarts: number[],
): T[] {
  return changes.map((change) => {
    let nearest: number | null = null;
    for (const start of sectionStarts) {
      const distance = Math.abs(start - change.startSeconds);
      if (
        distance <= KEY_CHANGE_SNAP_SECONDS &&
        (nearest === null || distance < Math.abs(nearest - change.startSeconds))
      ) {
        nearest = start;
      }
    }
    return nearest === null ? change : { ...change, startSeconds: nearest };
  });
}

/**
 * Whether the detected key stretches say something new about the song: a
 * song already in D whose last chorus goes up to E has its key right, but
 * not its change. Same keys in the same order, each change within
 * `KEY_CHANGE_SNAP_SECONDS` of the one it already has, is nothing new.
 * `sections` are seconds from the song start; the song's key changes are on
 * the timeline.
 */
export function keyStretchesAreNew(
  region: Pick<SongRegionSummary, "key" | "startSeconds" | "keyChanges"> | undefined,
  sections: { startSeconds: number; key: string }[],
): boolean {
  if (sections.length < 2 || !region) return sections.length > 1;
  const current = region.keyChanges ?? [];
  if (region.key !== sections[0].key || current.length !== sections.length - 1) return true;
  return sections.slice(1).some((section, index) => {
    const change = current[index];
    return (
      change.key !== section.key ||
      Math.abs(change.startSeconds - (region.startSeconds + section.startSeconds)) >
        KEY_CHANGE_SNAP_SECONDS
    );
  });
}
