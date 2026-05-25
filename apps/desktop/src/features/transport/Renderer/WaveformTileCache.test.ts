import { describe, expect, it } from "vitest";

import type { ClipSummary, WaveformSummaryDto } from "../desktopApi";
import {
  getWaveformRenderPixelsPerSecond,
  WaveformTileCache,
  decodeFloat32Peaks,
  selectWaveformLod,
} from "./WaveformTileCache";

function encodeFloat32Peaks(values: number[]) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    view.setFloat32(index * 4, value, true);
  });

  return btoa(String.fromCharCode(...bytes));
}

function buildWaveform(overrides?: Partial<WaveformSummaryDto>): WaveformSummaryDto {
  return {
    waveformKey: "audio/test.wav",
    version: 1,
    durationSeconds: 8,
    sampleRate: 48_000,
    lods: [
      {
        resolutionFrames: 256,
        bucketCount: 8,
        minPeaks: [-0.8, -0.7, -0.6, -0.5, -0.4, -0.3, -0.2, -0.1],
        maxPeaks: [0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1],
      },
      {
        resolutionFrames: 2048,
        bucketCount: 4,
        minPeaks: [-0.9, -0.6, -0.3, -0.2],
        maxPeaks: [0.9, 0.6, 0.3, 0.2],
      },
    ],
    ...overrides,
  };
}

function buildClip(overrides?: Partial<ClipSummary>): ClipSummary {
  return {
    id: "clip-1",
    trackId: "track-1",
    trackName: "Track 1",
    filePath: "audio/test.wav",
    waveformKey: "audio/test.wav",
    isMissing: false,
    timelineStartSeconds: 0,
    sourceStartSeconds: 0,
    sourceDurationSeconds: 8,
    durationSeconds: 4,
    gain: 1,
    ...overrides,
  };
}

describe("WaveformTileCache", () => {
  it("decodes float32 peaks from base64 payloads", () => {
    const decoded = decodeFloat32Peaks(encodeFloat32Peaks([-0.5, 0.25, 0.75]), 3);

    expect(Array.from(decoded)).toHaveLength(3);
    expect(decoded[0]).toBeCloseTo(-0.5);
    expect(decoded[1]).toBeCloseTo(0.25);
    expect(decoded[2]).toBeCloseTo(0.75);
  });

  it("selects the highest-detail lod that does not exceed frames per pixel", () => {
    const waveform = buildWaveform();

    const highZoomLod = selectWaveformLod(waveform, 200);
    const lowZoomLod = selectWaveformLod(waveform, 10);

    expect(highZoomLod?.resolutionFrames).toBe(256);
    expect(lowZoomLod?.resolutionFrames).toBe(2048);
  });

  it("decodes right-channel peaks for stereo waveforms", () => {
    const waveform = buildWaveform({
      lods: [
        {
          resolutionFrames: 256,
          bucketCount: 3,
          minPeaksBase64: encodeFloat32Peaks([-0.8, -0.7, -0.6]),
          maxPeaksBase64: encodeFloat32Peaks([0.8, 0.7, 0.6]),
          minPeaksRightBase64: encodeFloat32Peaks([-0.2, -0.3, -0.4]),
          maxPeaksRightBase64: encodeFloat32Peaks([0.2, 0.3, 0.4]),
        },
      ],
    });

    const lod = selectWaveformLod(waveform, 200);

    expect(Array.from(lod?.maxPeaksRight ?? [])).toHaveLength(3);
    expect(lod?.maxPeaksRight[2]).toBeCloseTo(0.4);
    expect(lod?.minPeaksRight[0]).toBeCloseTo(-0.2);
  });

  it("builds different namespaces when waveform identity inputs change", () => {
    const cache = new WaveformTileCache();
    const baseClip = buildClip();
    const baseWaveform = buildWaveform();

    const baseNamespace = cache.buildNamespace(baseClip, baseWaveform, 120);
    const durationNamespace = cache.buildNamespace(
      buildClip({ sourceDurationSeconds: 9 }),
      baseWaveform,
      120,
    );
    const waveformNamespace = cache.buildNamespace(
      buildClip({ waveformKey: "audio/other.wav" }),
      buildWaveform({ waveformKey: "audio/other.wav" }),
      120,
    );

    expect(durationNamespace).not.toBe(baseNamespace);
    expect(waveformNamespace).not.toBe(baseNamespace);
  });

  it("builds different namespaces for mono and stereo waveform tiles", () => {
    const cache = new WaveformTileCache();
    const baseClip = buildClip();
    const monoNamespace = cache.buildNamespace(baseClip, buildWaveform(), 120);
    const stereoNamespace = cache.buildNamespace(
      baseClip,
      buildWaveform({
        lods: [
          {
            resolutionFrames: 256,
            bucketCount: 2,
            minPeaks: [-0.8, -0.6],
            maxPeaks: [0.8, 0.6],
            minPeaksRight: [-0.2, -0.4],
            maxPeaksRight: [0.2, 0.4],
          },
        ],
      }),
      120,
    );

    expect(stereoNamespace).not.toBe(monoNamespace);
  });

  it("quantizes nearby zoom levels to the same waveform render scale", () => {
    expect(getWaveformRenderPixelsPerSecond(50)).toBe(
      getWaveformRenderPixelsPerSecond(60),
    );
    expect(getWaveformRenderPixelsPerSecond(72)).toBe(
      getWaveformRenderPixelsPerSecond(86),
    );
  });
});
