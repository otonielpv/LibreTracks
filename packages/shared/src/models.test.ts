import { describe, expect, it } from "vitest";

import {
  DEFAULT_APP_SETTINGS,
  buildSongTempoRegions,
  buildWaveformLodsFromPeaks,
  formatTransposeSemitones,
  getEffectiveBpmAt,
  getPrimarySongRegion,
  getSongBaseBpm,
  getSongBaseTimeSignature,
  getSongRegionAtPosition,
  getSongTempoRegionAtPosition,
  normalizeAppSettings,
  parseSongKey,
  regionEffectiveKey,
  transposeKey,
  type AppSettings,
  type SongRegionSummary,
  type SongView,
} from "./models";

function makeRegion(
  overrides: Partial<SongRegionSummary> = {},
): SongRegionSummary {
  return {
    id: "r1",
    name: "Region",
    startSeconds: 0,
    endSeconds: 10,
    transposeSemitones: 0,
    key: null,
    warpEnabled: false,
    warpSourceBpm: null,
    master: { gain: 1.0 },
    ...overrides,
  };
}

function makeSong(overrides: Partial<SongView> = {}): SongView {
  return {
    id: "song",
    title: "Song",
    bpm: 120,
    timeSignature: "4/4",
    durationSeconds: 60,
    tempoMarkers: [],
    timeSignatureMarkers: [],
    regions: [],
    sectionMarkers: [],
    clips: [],
    tracks: [],
    projectRevision: 1,
    ...overrides,
  };
}

describe("formatTransposeSemitones", () => {
  it("renders zero without a sign", () => {
    expect(formatTransposeSemitones(0)).toBe("0");
  });

  it("prefixes a + for positive values", () => {
    expect(formatTransposeSemitones(5)).toBe("+5");
  });

  it("keeps the - for negative values", () => {
    expect(formatTransposeSemitones(-3)).toBe("-3");
  });
});

describe("parseSongKey", () => {
  it("parses a plain major note", () => {
    expect(parseSongKey("C")).toEqual({ semitone: 0, minor: false });
    expect(parseSongKey("F#")).toEqual({ semitone: 6, minor: false });
  });

  it("parses a minor note via the trailing m", () => {
    expect(parseSongKey("Dm")).toEqual({ semitone: 2, minor: true });
    expect(parseSongKey("A#m")).toEqual({ semitone: 10, minor: true });
  });

  it("accepts flats and normalises them to sharps", () => {
    expect(parseSongKey("Db")).toEqual({ semitone: 1, minor: false });
    expect(parseSongKey("Ebm")).toEqual({ semitone: 3, minor: true });
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(parseSongKey("  gm ")).toEqual({ semitone: 7, minor: true });
  });

  it("returns null for empty or unrecognised input", () => {
    expect(parseSongKey(null)).toBeNull();
    expect(parseSongKey("")).toBeNull();
    expect(parseSongKey("Sol")).toBeNull();
  });
});

describe("transposeKey", () => {
  it("shifts a major key up preserving the mode", () => {
    expect(transposeKey("D", 2)).toBe("E");
  });

  it("shifts a minor key and keeps the m suffix", () => {
    expect(transposeKey("Dm", 2)).toBe("Em");
  });

  it("wraps around the octave in both directions", () => {
    expect(transposeKey("B", 1)).toBe("C");
    expect(transposeKey("C", -1)).toBe("B");
    expect(transposeKey("Cm", -14)).toBe("A#m");
  });

  it("canonicalises to sharps and returns null for unparseable keys", () => {
    expect(transposeKey("Db", 0)).toBe("C#");
    expect(transposeKey("Sol", 3)).toBeNull();
  });
});

describe("regionEffectiveKey", () => {
  it("transposes the region's own key by its semitones", () => {
    expect(
      regionEffectiveKey(makeRegion({ key: "Dm", transposeSemitones: 2 })),
    ).toBe("Em");
  });

  it("applies the transpose even when the region is warped", () => {
    // Warp (time-ratio) and transpose (pitch-scale) are independent on the same
    // Bungee voice, so a warped region still shifts key by its transpose.
    expect(
      regionEffectiveKey(
        makeRegion({ key: "Dm", transposeSemitones: 5, warpEnabled: true }),
      ),
    ).toBe("Gm");
  });

  it("returns null when the region has no key", () => {
    expect(
      regionEffectiveKey(makeRegion({ key: null, transposeSemitones: 2 })),
    ).toBeNull();
  });
});

describe("normalizeAppSettings", () => {
  it("returns the defaults untouched when given the defaults", () => {
    expect(normalizeAppSettings(DEFAULT_APP_SETTINGS)).toEqual(
      DEFAULT_APP_SETTINGS,
    );
  });

  it("clamps metronome volume into [0, +20 dB headroom]", () => {
    // The click fader is an aux dB fader reaching +20 dB (linear gain ≈ 10),
    // so anything above that headroom clamps to it, not to unity.
    expect(
      normalizeAppSettings({ ...DEFAULT_APP_SETTINGS, metronomeVolume: 50 })
        .metronomeVolume,
    ).toBeCloseTo(10, 6);
    expect(
      normalizeAppSettings({ ...DEFAULT_APP_SETTINGS, metronomeVolume: 5 })
        .metronomeVolume,
    ).toBe(5);
    expect(
      normalizeAppSettings({ ...DEFAULT_APP_SETTINGS, metronomeVolume: -2 })
        .metronomeVolume,
    ).toBe(0);
  });

  it("falls back to the default metronome volume for non-finite input", () => {
    expect(
      normalizeAppSettings({
        ...DEFAULT_APP_SETTINGS,
        metronomeVolume: Number.NaN,
      }).metronomeVolume,
    ).toBe(DEFAULT_APP_SETTINGS.metronomeVolume);
  });

  it("rejects an out-of-range metronome preset index", () => {
    expect(
      normalizeAppSettings({
        ...DEFAULT_APP_SETTINGS,
        metronomeAccentPreset: 99,
      }).metronomeAccentPreset,
    ).toBe(DEFAULT_APP_SETTINGS.metronomeAccentPreset);
  });

  it("clamps metronome pitch to +/-24 semitones", () => {
    expect(
      normalizeAppSettings({ ...DEFAULT_APP_SETTINGS, metronomeBeatPitch: 100 })
        .metronomeBeatPitch,
    ).toBe(24);
    expect(
      normalizeAppSettings({
        ...DEFAULT_APP_SETTINGS,
        metronomeAccentPitch: -100,
      }).metronomeAccentPitch,
    ).toBe(-24);
  });

  it("only accepts allowed metronome subdivisions", () => {
    expect(
      normalizeAppSettings({ ...DEFAULT_APP_SETTINGS, metronomeSubdivision: 4 })
        .metronomeSubdivision,
    ).toBe(4);
    expect(
      normalizeAppSettings({ ...DEFAULT_APP_SETTINGS, metronomeSubdivision: 7 })
        .metronomeSubdivision,
    ).toBe(DEFAULT_APP_SETTINGS.metronomeSubdivision);
  });

  it("normalizes locale to en/es or null", () => {
    expect(
      normalizeAppSettings({ ...DEFAULT_APP_SETTINGS, locale: "ES" }).locale,
    ).toBe("es");
    expect(
      normalizeAppSettings({ ...DEFAULT_APP_SETTINGS, locale: "fr" }).locale,
    ).toBeNull();
  });

  it("deduplicates, floors, and sorts enabled output channels", () => {
    const result = normalizeAppSettings({
      ...DEFAULT_APP_SETTINGS,
      enabledOutputChannels: [3, 1, 1, 0, 2.9],
    });
    expect(result.enabledOutputChannels).toEqual([0, 1, 2, 3]);
  });

  it("drops out-of-range channels and falls back to defaults when empty", () => {
    const result = normalizeAppSettings({
      ...DEFAULT_APP_SETTINGS,
      enabledOutputChannels: [-1, 64, 999],
    });
    expect(result.enabledOutputChannels).toEqual(
      DEFAULT_APP_SETTINGS.enabledOutputChannels,
    );
  });

  it("coerces a fixed buffer size and rejects invalid ones", () => {
    expect(
      normalizeAppSettings({
        ...DEFAULT_APP_SETTINGS,
        outputBufferSize: { fixed: 256.7 },
      }).outputBufferSize,
    ).toEqual({ fixed: 256 });
    expect(
      normalizeAppSettings({
        ...DEFAULT_APP_SETTINGS,
        outputBufferSize: { fixed: -5 },
      }).outputBufferSize,
    ).toBe("default");
  });

  it("rejects unknown audio backends and sample formats", () => {
    const result = normalizeAppSettings({
      ...DEFAULT_APP_SETTINGS,
      selectedAudioBackend: "bogus" as AppSettings["selectedAudioBackend"],
      outputSampleFormat: "f64" as AppSettings["outputSampleFormat"],
    });
    expect(result.selectedAudioBackend).toBeNull();
    expect(result.outputSampleFormat).toBeNull();
  });

  it("keeps a valid audio backend and sample format", () => {
    const result = normalizeAppSettings({
      ...DEFAULT_APP_SETTINGS,
      selectedAudioBackend: "wasapi",
      outputSampleFormat: "i16",
    });
    expect(result.selectedAudioBackend).toBe("wasapi");
    expect(result.outputSampleFormat).toBe("i16");
  });

  it("floors and clamps midi bindings into the byte range", () => {
    const result = normalizeAppSettings({
      ...DEFAULT_APP_SETTINGS,
      midiMappings: {
        play: { status: 300.6, data1: -4, isCc: 1 as unknown as boolean },
      },
    });
    expect(result.midiMappings.play).toEqual({
      status: 255,
      data1: 0,
      isCc: true,
    });
  });

  it("clamps jump bars to at least 1 and floors them", () => {
    const result = normalizeAppSettings({
      ...DEFAULT_APP_SETTINGS,
      globalJumpBars: 0,
      songJumpBars: 3.9,
      vampBars: -10,
    });
    expect(result.globalJumpBars).toBe(1);
    expect(result.songJumpBars).toBe(3);
    expect(result.vampBars).toBe(1);
  });

  it("validates enum-like jump/transition/vamp/navigation fields", () => {
    const result = normalizeAppSettings({
      ...DEFAULT_APP_SETTINGS,
      globalJumpMode: "garbage" as AppSettings["globalJumpMode"],
      songJumpTrigger: "after_bars",
      songTransitionMode: "fade_out",
      vampMode: "bars",
      timelineNavigationScheme: "libretracks",
      timelinePlayheadFollowMode: "center",
    });
    expect(result.globalJumpMode).toBe(DEFAULT_APP_SETTINGS.globalJumpMode);
    expect(result.songJumpTrigger).toBe("after_bars");
    expect(result.songTransitionMode).toBe("fade_out");
    expect(result.vampMode).toBe("bars");
    expect(result.timelineNavigationScheme).toBe("libretracks");
    expect(result.timelinePlayheadFollowMode).toBe("center");
    expect(
      normalizeAppSettings({
        ...DEFAULT_APP_SETTINGS,
        timelinePlayheadFollowMode:
          "sideways" as AppSettings["timelinePlayheadFollowMode"],
      }).timelinePlayheadFollowMode,
    ).toBe(DEFAULT_APP_SETTINGS.timelinePlayheadFollowMode);
  });

  it("clamps pad key into [0, 11] and rounds it", () => {
    expect(
      normalizeAppSettings({ ...DEFAULT_APP_SETTINGS, padKey: 20 }).padKey,
    ).toBe(11);
    expect(
      normalizeAppSettings({ ...DEFAULT_APP_SETTINGS, padKey: -3 }).padKey,
    ).toBe(0);
    expect(
      normalizeAppSettings({ ...DEFAULT_APP_SETTINGS, padKey: 5.7 }).padKey,
    ).toBe(6);
  });

  it("clamps pad volume into the aux fader headroom and lowercases the route", () => {
    expect(
      normalizeAppSettings({ ...DEFAULT_APP_SETTINGS, padVolume: 50 }).padVolume,
    ).toBeCloseTo(10, 6);
    expect(
      normalizeAppSettings({ ...DEFAULT_APP_SETTINGS, padOutput: "MONITOR" })
        .padOutput,
    ).toBe("monitor");
  });

  it("coerces pad id and enabled to safe types", () => {
    const result = normalizeAppSettings({
      ...DEFAULT_APP_SETTINGS,
      padId: undefined as unknown as string,
      padEnabled: 1 as unknown as boolean,
    });
    expect(result.padId).toBe("");
    expect(result.padEnabled).toBe(true);
  });
});

describe("buildWaveformLodsFromPeaks", () => {
  it("always returns the base LOD as the first entry", () => {
    const min = [-0.5, -0.2, -0.9, -0.1];
    const max = [0.5, 0.2, 0.9, 0.1];
    const lods = buildWaveformLodsFromPeaks(min, max, 4, 44100);
    expect(lods[0].minPeaks).toEqual(min);
    expect(lods[0].maxPeaks).toEqual(max);
    expect(lods[0].bucketCount).toBe(4);
  });

  it("builds progressively coarser LOD levels", () => {
    const buckets = 4096;
    const max = Array.from({ length: buckets }, () => 0.5);
    const min = Array.from({ length: buckets }, () => -0.5);
    const lods = buildWaveformLodsFromPeaks(min, max, 120, 44100);
    // Base resolution is fine; coarser 2048/16384/131072-frame LODs follow.
    expect(lods.length).toBeGreaterThan(1);
    for (let i = 1; i < lods.length; i += 1) {
      expect(lods[i].resolutionFrames).toBeGreaterThan(
        lods[i - 1].resolutionFrames,
      );
      expect(lods[i].bucketCount).toBeLessThanOrEqual(lods[i - 1].bucketCount);
    }
  });

  it("preserves the min/max envelope when downsampling", () => {
    const buckets = 8192;
    const max = Array.from({ length: buckets }, (_, i) =>
      i === 100 ? 1 : 0.1,
    );
    const min = Array.from({ length: buckets }, (_, i) =>
      i === 100 ? -1 : -0.1,
    );
    const lods = buildWaveformLodsFromPeaks(min, max, 120, 44100);
    const coarse = lods[lods.length - 1];
    expect(Math.max(...(coarse.maxPeaks ?? []))).toBe(1);
    expect(Math.min(...(coarse.minPeaks ?? []))).toBe(-1);
  });

  it("guards against zero duration and sample rate", () => {
    const lods = buildWaveformLodsFromPeaks([0], [0], 0, 0);
    expect(lods[0].resolutionFrames).toBeGreaterThanOrEqual(1);
  });
});

describe("song bpm / time signature helpers", () => {
  it("defaults bpm and time signature when no song is given", () => {
    expect(getSongBaseBpm(null)).toBe(120);
    expect(getSongBaseTimeSignature(undefined)).toBe("4/4");
  });

  it("reads bpm and time signature off the song", () => {
    const song = makeSong({ bpm: 90, timeSignature: "3/4" });
    expect(getSongBaseBpm(song)).toBe(90);
    expect(getSongBaseTimeSignature(song)).toBe("3/4");
  });
});

describe("getEffectiveBpmAt", () => {
  it("returns the base bpm with no markers", () => {
    expect(getEffectiveBpmAt(makeSong({ bpm: 100 }), 5)).toBe(100);
  });

  it("returns the latest tempo marker at or before the position", () => {
    const song = makeSong({
      bpm: 100,
      tempoMarkers: [
        { id: "m1", startSeconds: 10, bpm: 140 },
        { id: "m2", startSeconds: 20, bpm: 80 },
      ],
    });
    expect(getEffectiveBpmAt(song, 5)).toBe(100);
    expect(getEffectiveBpmAt(song, 12)).toBe(140);
    expect(getEffectiveBpmAt(song, 25)).toBe(80);
  });

  it("applies varispeed scaling inside a transposed non-warp region", () => {
    const song = makeSong({
      bpm: 120,
      // A tempo marker at 0 keeps us out of the no-marker early return so the
      // varispeed scaling for the transposed region is actually applied.
      tempoMarkers: [{ id: "m0", startSeconds: 0, bpm: 120 }],
      regions: [
        makeRegion({
          startSeconds: 0,
          endSeconds: 30,
          transposeSemitones: 12,
          warpEnabled: false,
        }),
      ],
    });
    // +12 semitones doubles the playback rate -> bpm doubles.
    expect(getEffectiveBpmAt(song, 5)).toBeCloseTo(240, 4);
  });

  it("does not apply varispeed when there are no tempo markers", () => {
    // Documents the early-return: with zero tempo markers the base bpm is
    // returned verbatim, even inside a transposed region.
    const song = makeSong({
      bpm: 120,
      regions: [
        makeRegion({ startSeconds: 0, endSeconds: 30, transposeSemitones: 12 }),
      ],
    });
    expect(getEffectiveBpmAt(song, 5)).toBe(120);
  });
});

describe("region lookups", () => {
  it("returns the first region as the primary", () => {
    const a = makeRegion({ id: "a" });
    const b = makeRegion({ id: "b", startSeconds: 10, endSeconds: 20 });
    expect(getPrimarySongRegion(makeSong({ regions: [a, b] }))?.id).toBe("a");
    expect(getPrimarySongRegion(makeSong({ regions: [] }))).toBeNull();
  });

  it("finds the region containing a position", () => {
    const a = makeRegion({ id: "a", startSeconds: 0, endSeconds: 10 });
    const b = makeRegion({ id: "b", startSeconds: 10, endSeconds: 20 });
    const song = makeSong({ regions: [a, b] });
    expect(getSongRegionAtPosition(song, 5)?.id).toBe("a");
    expect(getSongRegionAtPosition(song, 15)?.id).toBe("b");
  });

  it("falls back to the last region past the end, else the first", () => {
    const a = makeRegion({ id: "a", startSeconds: 0, endSeconds: 10 });
    const b = makeRegion({ id: "b", startSeconds: 10, endSeconds: 20 });
    const song = makeSong({ regions: [a, b] });
    expect(getSongRegionAtPosition(song, 50)?.id).toBe("b");
    expect(getSongRegionAtPosition(song, -5)?.id).toBe("a");
  });
});

describe("buildSongTempoRegions / getSongTempoRegionAtPosition", () => {
  it("always produces at least a tail region for an empty song", () => {
    const regions = buildSongTempoRegions(makeSong());
    expect(regions.length).toBeGreaterThanOrEqual(1);
    expect(regions[regions.length - 1].endSeconds).toBeGreaterThan(0);
  });

  it("splits at tempo markers into ordered, non-overlapping regions", () => {
    const song = makeSong({
      bpm: 120,
      tempoMarkers: [{ id: "m1", startSeconds: 10, bpm: 140 }],
    });
    const regions = buildSongTempoRegions(song);
    expect(regions[0].startSeconds).toBe(0);
    expect(regions[0].endSeconds).toBe(10);
    expect(regions[0].bpm).toBeCloseTo(120, 4);
    expect(regions[1].startSeconds).toBe(10);
    expect(regions[1].bpm).toBeCloseTo(140, 4);
  });

  it("locates the tempo region for a position", () => {
    const song = makeSong({
      bpm: 120,
      tempoMarkers: [{ id: "m1", startSeconds: 10, bpm: 140 }],
    });
    expect(getSongTempoRegionAtPosition(song, 5)?.bpm).toBeCloseTo(120, 4);
    expect(getSongTempoRegionAtPosition(song, 50)?.bpm).toBeCloseTo(140, 4);
  });
});
