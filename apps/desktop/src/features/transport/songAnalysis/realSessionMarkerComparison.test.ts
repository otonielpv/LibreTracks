import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AnalyzeSongResult } from "@libretracks/shared/desktopApi";
import { markerCategory, type MarkerCategory, type MarkerKind, type SongView } from "@libretracks/shared/models";

import recorded from "./fixtures/nine-song-analysis.json";
import {
  bpmFromNames,
  buildApplyPayload,
  clickTrackOptions,
  DEFAULT_TEMPO_DETAIL,
  guideTrackOptions,
  markersForLabels,
  placeGuideSections,
  reviewRows,
  startsOnEighths,
  storedSeconds,
  tempoInView,
  tempoLevel,
  viewSeconds,
} from "./songAnalysisPlan";

const POSITION_TOLERANCE_SECONDS = 0.25;
const SAME_POSITION_SECONDS = 0.0005;

type Marker = {
  kind: MarkerKind;
  variant: number | null;
  category: MarkerCategory;
  seconds: number;
};

function sameMarker(a: Marker, b: Marker): boolean {
  return a.kind === b.kind && a.variant === b.variant && a.category === b.category;
}

function compareMarkers(expected: Marker[], actual: Marker[]) {
  // Match each marker at most once, even when several share a kind.
  const matched = new Map<number, number>();
  const assign = (expectedIndex: number, visited: Set<number>): boolean => {
    const candidates = actual
      .map((marker, index) => ({ marker, index }))
      .filter(({ marker, index }) =>
        !visited.has(index) &&
        sameMarker(expected[expectedIndex], marker) &&
        Math.abs(marker.seconds - expected[expectedIndex].seconds) <= POSITION_TOLERANCE_SECONDS,
      )
      .sort((a, b) =>
        Math.abs(a.marker.seconds - expected[expectedIndex].seconds) -
        Math.abs(b.marker.seconds - expected[expectedIndex].seconds),
      );
    for (const { index } of candidates) {
      visited.add(index);
      const previous = matched.get(index);
      if (previous === undefined || assign(previous, visited)) {
        matched.set(index, expectedIndex);
        return true;
      }
    }
    return false;
  };
  for (let index = 0; index < expected.length; index += 1) assign(index, new Set());
  const matchedExpected = new Set(matched.values());
  const missing = expected.filter((_, index) => !matchedExpected.has(index));
  const extra = actual.filter((_, index) => !matched.has(index));
  const collisions = actual.flatMap((marker, index) =>
    actual.slice(index + 1).filter((other) =>
      marker.category === other.category &&
      Math.abs(marker.seconds - other.seconds) < SAME_POSITION_SECONDS,
    ).map((other) => [marker, other]),
  );
  return { missing, extra, collisions };
}

function compareSong(song: SongView, index: number, result: AnalyzeSongResult) {
  const region = song.regions[index];
  if (!region || !result.tempo || !result.guide) {
    throw new Error("The song and both click and guide analyses are required.");
  }
  if (result.regionId !== region.id) throw new Error("The analysis belongs to a different song.");
  const clickId = clickTrackOptions(song, region.id).preselected;
  if (!clickId) throw new Error("No default click track for this song.");
  if (!guideTrackOptions(song, region.id).preselected) {
    throw new Error("No default guide track for this song.");
  }
  const eighths = startsOnEighths(
    bpmFromNames(song, region.id, clickId),
    result.tempo.analysis.segments[0]?.bpm,
    result.tempo.asEighths?.analysis.segments[0]?.bpm,
  );
  const reading = (eighths ? result.tempo.asEighths : null) ?? result.tempo;
  const rows = reviewRows(tempoLevel(reading, DEFAULT_TEMPO_DETAIL).proposal);
  const include = {
    tempo: rows.some((row) => row.kind === "tempo"),
    signature: rows.some((row) => row.kind === "signature"),
  };
  const touchesTempo = include.tempo || include.signature;
  const payload = touchesTempo ? buildApplyPayload(song, region.id, rows, include, result) : null;
  if (touchesTempo && !payload) throw new Error("The default tempo proposal is invalid.");
  const choices = result.guide.analysis.groups.map((group) =>
    markersForLabels(group.labels, group.countedIn),
  );
  const inside = (seconds: number) =>
    seconds >= region.startSeconds - SAME_POSITION_SECONDS &&
    seconds < region.endSeconds - SAME_POSITION_SECONDS;
  const expected = song.sectionMarkers.filter((marker) => inside(marker.startSeconds)).map((marker) => ({
    kind: marker.kind ?? "custom",
    variant: marker.variant ?? null,
    category: markerCategory(marker),
    seconds: viewSeconds(result, marker.startSeconds) - result.renderStartSeconds,
  }));
  const actual = placeGuideSections(
    song, region.id, result.renderStartSeconds, result.guide.analysis,
    choices, payload ? tempoInView(payload, result) : null,
  ).filter((marker) => inside(storedSeconds(result, marker.startSeconds))).map((marker) => ({
    kind: marker.kind,
    variant: marker.variant,
    category: markerCategory(marker),
    seconds: marker.startSeconds - result.renderStartSeconds,
  }));
  return { expectedCount: expected.length, actualCount: actual.length, ...compareMarkers(expected, actual) };
}

describe("real-session marker comparison", () => {
  const marker = (seconds: number, kind: MarkerKind = "verse", category: MarkerCategory = "section"): Marker =>
    ({ seconds, kind, category, variant: null });

  it("compares positions, kinds, variants and lanes without reusing matches", () => {
    expect(compareMarkers(
      [marker(10), marker(20)],
      [marker(10.2), marker(20, "chorus")],
    )).toEqual({ missing: [marker(20)], extra: [marker(20, "chorus")], collisions: [] });
    expect(compareMarkers([marker(10), marker(10.1)], [marker(10.05)]).missing).toHaveLength(1);
    expect(compareMarkers([marker(10), marker(10.3)], [marker(10.15), marker(9.9)]).missing).toHaveLength(0);
    expect(compareMarkers([marker(10)], [marker(10.26)]).missing).toHaveLength(1);
    expect(compareMarkers([marker(10)], [marker(10, "verse", "cue")]).missing).toHaveLength(1);
    expect(compareMarkers([marker(10)], [{ ...marker(10), variant: 2 }]).missing).toHaveLength(1);
  });

  describe("nine recorded song analyses", () => {
    const song = recorded.song as SongView;
    it("keeps the first count exactly at the start of Quiero conocer a Jesús", () => {
      const sample = recorded.cases.find((entry) => entry.index === 5);
      if (!sample) throw new Error("Missing the opening-count regression fixture.");
      const result = compareSong(song, sample.index, sample.result as AnalyzeSongResult);
      expect(result.missing).not.toContainEqual({
        kind: "count", variant: 1, category: "cue", seconds: 0,
      });
      expect(result.actualCount).toBe(result.expectedCount);
    });
    for (const sample of recorded.cases) {
      const region = song.regions[sample.index];
      const known = sample.knownDiscrepancies;
      const hasKnownDifferences = known.missing.length > 0 || known.extra.length > 0 || known.collisions.length > 0;
      it(`${region.name}${hasKnownDifferences ? " (documented differences)" : ""}`, () => {
        const { expectedCount, actualCount, missing, extra, collisions } =
          compareSong(song, sample.index, sample.result as AnalyzeSongResult);
        expect({ expectedCount, actualCount }).toEqual({
          expectedCount: sample.expectedCount, actualCount: sample.actualCount,
        });
        expect({ missing, extra, collisions }).toEqual(known);
      });
    }
  });

  it("reports same-lane collisions but allows a section and a cue together", () => {
    expect(compareMarkers([], [marker(10), marker(10, "chorus")]).collisions).toHaveLength(1);
    expect(compareMarkers([], [marker(10), marker(10, "count", "cue")]).collisions).toHaveLength(0);
    expect(compareMarkers([], [marker(10), marker(10.0001, "chorus")]).collisions).toHaveLength(1);
    expect(compareMarkers([], [marker(10), marker(10.001, "chorus")]).collisions).toHaveLength(0);
  });
});

const sessionFile = process.env.LT_AN_SESSION;
const resultsDir = process.env.LT_AN_AUDIO;

if (Boolean(sessionFile) !== Boolean(resultsDir)) {
  throw new Error("Set both LT_AN_SESSION and LT_AN_AUDIO to compare a real session.");
}

if (sessionFile && resultsDir) {
  const song = JSON.parse(readFileSync(sessionFile, "utf8")) as SongView;
  if (song.regions.some((region) => region.warpEnabled || (region.transposeSemitones ?? 0) !== 0)) {
    throw new Error("This comparison needs an unwarped, untransposed session: raw session positions are not transport view positions.");
  }
  const skipValues = (process.env.LT_AN_SKIP ?? "").split(",").filter(Boolean);
  if (skipValues.some((value) => !/^\d+$/.test(value) || Number(value) >= song.regions.length)) {
    throw new Error("LT_AN_SKIP must contain valid zero-based region indices.");
  }
  const skipped = new Set(skipValues.map(Number));
  describe("markers against the supplied session", () => {
    for (const [index, region] of song.regions.entries()) {
      if (skipped.has(index)) continue;
      it(`${index}: ${region.name}`, () => {
        const result = JSON.parse(readFileSync(join(resultsDir, `${index}_result.json`), "utf8")) as AnalyzeSongResult;
        const { expectedCount, actualCount, ...comparison } = compareSong(song, index, result);
        if (process.env.LT_AN_REPORT === "1") {
          console.log(`LT_MARKER_COMPARISON ${JSON.stringify({
            index, song: region.name, expectedCount, actualCount, ...comparison,
          })}`);
        }
        expect(comparison, `Positions are relative to the song start; tolerance ${POSITION_TOLERANCE_SECONDS}s`).toEqual({
          missing: [], extra: [], collisions: [],
        });
      });
    }
  });
}
