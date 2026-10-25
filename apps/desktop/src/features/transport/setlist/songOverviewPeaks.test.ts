import { describe, expect, it } from "vitest";

import type { ClipSummary, WaveformSummaryDto } from "@libretracks/shared/models";

import {
  buildSongOverviewPeaks,
  songOverviewClipsKey,
  songOverviewSummariesKey,
} from "./songOverviewPeaks";

// One summary bucket per source second (sampleRate 10, resolution 10 frames).
function summary(key: string, peaks: number[]): WaveformSummaryDto {
  return {
    waveformKey: key,
    version: 1,
    durationSeconds: peaks.length,
    sampleRate: 10,
    lods: [
      {
        resolutionFrames: 10,
        bucketCount: peaks.length,
        minPeaks: peaks.map((peak) => -peak),
        maxPeaks: peaks,
      },
    ],
  };
}

function clip(id: string, overrides: Partial<ClipSummary> = {}): ClipSummary {
  return {
    id,
    trackId: "t",
    trackName: "t",
    filePath: `${id}.wav`,
    waveformKey: id,
    isMissing: false,
    timelineStartSeconds: 0,
    sourceStartSeconds: 0,
    sourceWindowDurationSeconds: 10,
    sourceDurationSeconds: 10,
    durationSeconds: 10,
    gain: 1,
    ...overrides,
  };
}

const ramp = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];
const round = (values: Float32Array) => Array.from(values, (value) => Math.round(value * 100) / 100);

describe("buildSongOverviewPeaks", () => {
  it("one clip covering the song, one bucket per second", () => {
    const peaks = buildSongOverviewPeaks([clip("a")], { a: summary("a", ramp) }, { startSeconds: 0, endSeconds: 10 }, 10);
    expect(round(peaks)).toEqual(ramp);
  });

  it("overlapping clips: the maximum wins, not the sum", () => {
    const flat = new Array(10).fill(0.5);
    const peaks = buildSongOverviewPeaks(
      [clip("a"), clip("b")],
      { a: summary("a", ramp), b: summary("b", flat) },
      { startSeconds: 0, endSeconds: 10 },
      10,
    );
    expect(round(peaks)).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
  });

  it("a trimmed clip respects its source window and timeline place", () => {
    // Source seconds 6..8 placed at 2..4 of the song.
    const trimmed = clip("a", {
      timelineStartSeconds: 2,
      sourceStartSeconds: 6,
      sourceWindowDurationSeconds: 2,
      durationSeconds: 2,
    });
    const peaks = buildSongOverviewPeaks([trimmed], { a: summary("a", ramp) }, { startSeconds: 0, endSeconds: 10 }, 10);
    expect(round(peaks)).toEqual([0, 0, 0.7, 0.8, 0, 0, 0, 0, 0, 0]);
  });

  it("a clip without a summary yet contributes 0", () => {
    const peaks = buildSongOverviewPeaks([clip("a")], {}, { startSeconds: 0, endSeconds: 10 }, 10);
    expect(Array.from(peaks)).toEqual(new Array(10).fill(0));
  });

  it("a clip that starts before the song only shows the part inside it", () => {
    const early = clip("a", { timelineStartSeconds: -5 });
    const peaks = buildSongOverviewPeaks([early], { a: summary("a", ramp) }, { startSeconds: 0, endSeconds: 10 }, 10);
    expect(round(peaks)).toEqual([0.6, 0.7, 0.8, 0.9, 1, 0, 0, 0, 0, 0]);
  });

  it("ignores clips outside the song", () => {
    const later = clip("a", { timelineStartSeconds: 50 });
    const peaks = buildSongOverviewPeaks([later], { a: summary("a", ramp) }, { startSeconds: 0, endSeconds: 10 }, 10);
    expect(peaks.every((value) => value === 0)).toBe(true);
  });
});

describe("overview keys", () => {
  it("change with placement and with an arriving summary, not with gain", () => {
    const region = { startSeconds: 0, endSeconds: 10 };
    const base = songOverviewClipsKey([clip("a")], region);
    expect(songOverviewClipsKey([clip("a", { gain: 0.2 })], region)).toBe(base);
    expect(songOverviewClipsKey([clip("a", { timelineStartSeconds: 1 })], region)).not.toBe(base);

    const before = songOverviewSummariesKey([clip("a")], {});
    expect(songOverviewSummariesKey([clip("a")], { a: summary("a", ramp) })).not.toBe(before);
  });
});
