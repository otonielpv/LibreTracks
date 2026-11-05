import type {
  AnalyzeSongRequest,
  AnalyzeSongResult,
  KeyChangeInput,
  MarkerKind,
  ProposedSignatureMarker,
  ProposedTempoMarker,
  SectionChange,
  SongView,
} from "../desktopApi";
import { markerCategory } from "../markerKinds";
import {
  bpmFromNames,
  buildApplyPayload,
  clickTrackOptions,
  DEFAULT_TEMPO_DETAIL,
  guideTrackOptions,
  keyStretchesAreNew,
  keyTrackOptions,
  markersForLabels,
  musicTempoTrackIds,
  placeGuideSections,
  reviewRows,
  snapKeyChangesToSections,
  startsOnEighths,
  tempoInView,
  tempoLevel,
  type GroupMarkers,
  type ReviewRow,
  type TempoDetail,
} from "./songAnalysisPlan";

/**
 * The review of one analysed song as data: what the modal starts on after an
 * analysis and what "Aplicar" sends. Shared by "Analizar canción" and
 * "Analizar todas las canciones", so applying a song without opening its
 * review writes exactly what the review would have proposed.
 */

/** The click select's "no click: estimate it from the music" option. */
export const FROM_MUSIC = "__music__";

/** Which tracks one analysis reads. */
export type AnalysisSetup = {
  /** A track id, `FROM_MUSIC`, or "" for no tempo. */
  clickTrackId: string;
  /** Session order. Empty: no key. */
  keyTrackIds: string[];
  /** "" for no guide. */
  guideTrackId: string;
};

/** What the setup screen preselects for a song. */
export function defaultSetup(song: SongView, regionId: string): AnalysisSetup {
  const { preselected } = clickTrackOptions(song, regionId);
  const musicTrackIds = musicTempoTrackIds(song, regionId);
  return {
    // No click-named track: estimating from the music is the useful default.
    clickTrackId: preselected ?? (musicTrackIds.length > 0 ? FROM_MUSIC : ""),
    keyTrackIds: keyTrackOptions(song, regionId)
      .filter((option) => option.preselected)
      .map((option) => option.id),
    guideTrackId: guideTrackOptions(song, regionId).preselected ?? "",
  };
}

export function setupHasWork(setup: AnalysisSetup): boolean {
  return setup.clickTrackId !== "" || setup.keyTrackIds.length > 0 || setup.guideTrackId !== "";
}

export function analysisRequest(
  song: SongView,
  regionId: string,
  setup: AnalysisSetup,
): AnalyzeSongRequest {
  const fromMusic = setup.clickTrackId === FROM_MUSIC;
  return {
    regionId,
    clickTrackIds: setup.clickTrackId && !fromMusic ? [setup.clickTrackId] : [],
    musicTempoTrackIds: fromMusic ? musicTempoTrackIds(song, regionId) : [],
    keyTrackIds: setup.keyTrackIds,
    guideTrackIds: setup.guideTrackId ? [setup.guideTrackId] : [],
  };
}

export type KeySection = { startSeconds: number; key: string };

export type ReviewInclude = {
  tempo: boolean;
  signature: boolean;
  key: boolean;
  keyChanges: boolean;
  sections: boolean;
};

export type ReviewState = {
  rows: ReviewRow[];
  /** Showing the click read as eighths (`result.tempo.asEighths`). */
  eighths: boolean;
  detail: TempoDetail;
  include: ReviewInclude;
  keyChoice: string;
  /** The key stretches found (the song modulates when there are 2+); the
   * first is the key the song starts in. */
  keySections: KeySection[];
  groupMarkers: GroupMarkers[];
  leadBars: number;
};

/** The tempo reading on show: the click's, or its eighths (÷2) reading. */
export function tempoReading(result: AnalyzeSongResult, eighths: boolean) {
  if (!result.tempo) return null;
  return (eighths ? result.tempo.asEighths : null) ?? result.tempo;
}

/** Section and cue markers already inside the song. */
export function markersInSong(song: SongView, regionId: string): number {
  const region = song.regions.find((r) => r.id === regionId);
  if (!region) return 0;
  return song.sectionMarkers.filter(
    (marker) => marker.startSeconds >= region.startSeconds && marker.startSeconds < region.endSeconds,
  ).length;
}

/** What the review starts on after an analysis. */
export function initialReview(
  song: SongView,
  regionId: string,
  setup: AnalysisSetup,
  result: AnalyzeSongResult,
): ReviewState {
  const fromMusic = setup.clickTrackId === FROM_MUSIC;
  const eighths = startsOnEighths(
    setup.clickTrackId && !fromMusic ? bpmFromNames(song, regionId, setup.clickTrackId) : null,
    result.tempo?.analysis.segments[0]?.bpm,
    result.tempo?.asEighths?.analysis.segments[0]?.bpm,
  );
  const reading = tempoReading(result, eighths);
  const rows = reading ? reviewRows(tempoLevel(reading, DEFAULT_TEMPO_DETAIL).proposal) : [];
  const detectedKey = result.key?.analysis.key ?? null;
  const estimated =
    result.tempo?.analysis.warnings.some((w) => w.kind === "estimatedWithoutClick") ?? false;
  const groups = result.guide?.analysis.groups ?? [];
  return {
    rows,
    eighths,
    detail: DEFAULT_TEMPO_DETAIL,
    keyChoice: detectedKey ?? "",
    keySections: result.key?.analysis.sections ?? [],
    groupMarkers: groups.map((group) => markersForLabels(group.labels, group.countedIn)),
    leadBars: 1,
    include: {
      tempo: rows.some((row) => row.kind === "tempo"),
      // Without a click the meter is a guess: the user opts in.
      signature: !estimated && rows.some((row) => row.kind === "signature"),
      // A song already in its key can still be missing its key changes.
      key:
        detectedKey !== null &&
        (detectedKey !== result.key?.currentKey ||
          keyStretchesAreNew(
            song.regions.find((r) => r.id === regionId),
            result.key?.analysis.sections ?? [],
          )),
      keyChanges: true,
      sections: groups.length > 0,
    },
  };
}

/**
 * The review "Aplicar todas" applies without opening it: the same proposal,
 * except that a song that already has section or cue markers keeps them.
 * Applying the guide replaces them, and markers placed by hand are worth more
 * than a guess nobody looked at; reviewing the song offers the replacement.
 */
export function batchReview(
  song: SongView,
  regionId: string,
  setup: AnalysisSetup,
  result: AnalyzeSongResult,
): ReviewState {
  const review = initialReview(song, regionId, setup, result);
  if (review.include.sections && markersInSong(song, regionId) > 0) {
    return { ...review, include: { ...review.include, sections: false } };
  }
  return review;
}

type TempoPayload = {
  tempoMarkers: ProposedTempoMarker[];
  signatureMarkers: ProposedSignatureMarker[];
};

export type PlacedSection = {
  startSeconds: number;
  kind: MarkerKind;
  variant: number | null;
  categoryOverride: SectionChange["categoryOverride"];
};

/** What applying a review writes, and whether there is anything to write. */
export type ApplyPlan = {
  touchesTempo: boolean;
  /** Null when a tempo or meter row does not parse. */
  tempoPayload: TempoPayload | null;
  appliesKey: boolean;
  appliesKeyChanges: boolean;
  appliesSections: boolean;
  /** Where the guide's markers land, on the grid the tempo review writes. */
  sections: PlacedSection[];
  canApply: boolean;
};

export function applyPlan(
  song: SongView,
  regionId: string,
  result: AnalyzeSongResult,
  review: ReviewState,
): ApplyPlan {
  const { rows, include, keyChoice, keySections } = review;
  const touchesTempo =
    (include.tempo && rows.some((row) => row.kind === "tempo")) ||
    (include.signature && rows.some((row) => row.kind === "signature"));
  const tempoPayload = touchesTempo
    ? buildApplyPayload(song, regionId, rows, include, result)
    : null;
  const appliesKey = result.key !== null && include.key && keyChoice !== "";
  // A song that modulates: its first stretch is the starting key, the rest
  // are key changes at the song's own times.
  const appliesKeyChanges = appliesKey && include.keyChanges && keySections.length > 1;
  const sections = result.guide
    ? placeGuideSections(
        song,
        regionId,
        result.renderStartSeconds,
        result.guide.analysis,
        review.groupMarkers,
        touchesTempo && tempoPayload ? tempoInView(tempoPayload, result) : null,
        review.leadBars,
      )
    : [];
  const appliesSections = result.guide !== null && include.sections;
  return {
    touchesTempo,
    tempoPayload,
    appliesKey,
    appliesKeyChanges,
    appliesSections,
    sections,
    canApply:
      (!touchesTempo || tempoPayload !== null) &&
      (touchesTempo || appliesKey || appliesSections),
  };
}

/** The arguments of `applySongAnalysis` for a plan that can apply. */
export function applyArguments(
  song: SongView,
  regionId: string,
  review: ReviewState,
  plan: ApplyPlan,
  sectionName: (section: PlacedSection) => string,
): {
  tempo: TempoPayload | null;
  key: string | null;
  sections: SectionChange[] | null;
  keyChanges: KeyChangeInput[] | null;
} {
  const regionStart = song.regions.find((r) => r.id === regionId)?.startSeconds ?? 0;
  const { keySections, keyChoice } = review;
  return {
    tempo: plan.touchesTempo ? plan.tempoPayload : null,
    key: plan.appliesKeyChanges ? keySections[0].key : plan.appliesKey ? keyChoice : null,
    sections: plan.appliesSections
      ? plan.sections.map((section) => ({ ...section, name: sectionName(section) }))
      : null,
    keyChanges: plan.appliesKeyChanges
      ? snapKeyChangesToSections(
          keySections.slice(1).map((section) => ({
            startSeconds: regionStart + section.startSeconds,
            key: section.key,
          })),
          // The sections being written, or the song's own.
          plan.appliesSections
            ? plan.sections
                .filter((section) => markerCategory(section) === "section")
                .map((section) => section.startSeconds)
            : song.sectionMarkers
                .filter((marker) => markerCategory(marker) === "section")
                .map((marker) => marker.startSeconds),
        )
      : null,
  };
}
