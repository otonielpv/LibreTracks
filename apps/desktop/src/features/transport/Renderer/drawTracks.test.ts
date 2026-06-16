import { describe, expect, it, vi } from "vitest";

vi.mock("./WaveformTileCache", () => {
  return {
    WAVEFORM_TILE_WIDTH_PX: 1024,
    getWaveformRenderPixelsPerSecond: (pixelsPerSecond: number) =>
      pixelsPerSecond,
    WaveformTileCache: class {
      getTile() {
        return {
          canvas: { width: 64, height: 32 },
          tileStartPixel: 0,
          tileWidth: 64,
        };
      }
    },
  };
});

// drawTracks reads pending-import labels from the i18n singleton; importing the
// config here initializes it so `i18n.t` resolves to real strings (in the app
// it's initialized at startup). Assertions resolve labels through the same
// instance so they stay language-agnostic (the test env may default to es).
import i18n from "../../../shared/i18n";
import { drawTrackClipsLayer } from "./drawTracks";
import type {
  TrackSceneSnapshot,
  TimelineViewportMetrics,
} from "./TimelineRenderer";

function createContextSpy() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    roundRect: vi.fn(),
    clip: vi.fn(),
    fillText: vi.fn(),
    stroke: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    drawImage: vi.fn(),
    rect: vi.fn(),
    fill: vi.fn(),
    set fillStyle(_value: string) {},
    set strokeStyle(_value: string) {},
    set lineWidth(_value: number) {},
    set font(_value: string) {},
    set textAlign(_value: string) {},
    set textBaseline(_value: string) {},
  } as unknown as CanvasRenderingContext2D;
}

function createSnapshot(withWaveform: boolean): TrackSceneSnapshot {
  return {
    width: 1200,
    height: 200,
    trackHeight: 80,
    song: {
      id: "song-1",
      title: "Song",
      bpm: 120,
      timeSignature: "4/4",
      durationSeconds: 180,
      tempoMarkers: [],
      timeSignatureMarkers: [],
      regions: [],
      sectionMarkers: [],
      tracks: [
        {
          id: "track-1",
          name: "Lead",
          kind: "audio",
          parentTrackId: null,
          depth: 0,
          hasChildren: false,
          volume: 1,
          pan: 0,
          muted: false,
          solo: false,
          audioTo: "master",
          transposeEnabled: false,
        },
      ],
      clips: [],
      projectRevision: 1,
    },
    visibleTracks: [
      {
        id: "track-1",
        name: "Lead",
        kind: "audio",
        parentTrackId: null,
        depth: 0,
        hasChildren: false,
        volume: 1,
        pan: 0,
        muted: false,
        solo: false,
        audioTo: "master",
        transposeEnabled: false,
      },
    ],
    clipsByTrack: {
      "track-1": [
        {
          id: "clip-1",
          trackId: "track-1",
          trackName: "Lead",
          filePath: "audio/lead.wav",
          waveformKey: "audio/lead.wav",
          isMissing: false,
          timelineStartSeconds: 0,
          sourceStartSeconds: 0,
          sourceWindowDurationSeconds: 45,
          sourceDurationSeconds: 45,
          durationSeconds: 45,
          gain: 1,
        },
      ],
    },
    waveformCache: withWaveform
      ? {
          "audio/lead.wav": {
            waveformKey: "audio/lead.wav",
            version: 1,
            durationSeconds: 45,
            sampleRate: 48000,
            lods: [
              {
                resolutionFrames: 2048,
                bucketCount: 4,
                minPeaks: [-0.2, -0.4, -0.3, -0.1],
                maxPeaks: [0.2, 0.4, 0.3, 0.1],
              },
            ],
          },
        }
      : {},
    pixelsPerSecond: 120,
    zoomLevel: 120,
    timelineGrid: {
      bars: [],
      beats: [],
      subdivisions: [],
      markers: [],
      beatsPerBar: 4,
      beatDurationSeconds: 0.5,
      showBeatLabels: true,
      showBeatGridLines: true,
      barLabelStep: 1,
      subdivisionPerBeat: 4,
      snapIntervalSeconds: 0.125,
      visibleStartSeconds: 0,
      visibleEndSeconds: 10,
    },
    selectedClipId: null,
    selectedClipIds: [],
    clipPreviewSecondsRef: { current: {} },
    clipPreviewTrackIdRef: { current: {} },
    cameraX: 0,
  };
}

const viewport: TimelineViewportMetrics = {
  scrollTop: 0,
  height: 200,
};

describe("drawTrackClipsLayer", () => {
  it("renders an analyzing placeholder when the waveform is pending", () => {
    const context = createContextSpy();

    drawTrackClipsLayer(context, createSnapshot(false), viewport);

    expect(
      (context.fillText as ReturnType<typeof vi.fn>).mock.calls.some(
        ([text]) => text === "ANALYZING WAVEFORM...",
      ),
    ).toBe(true);
    expect(
      context.drawImage as ReturnType<typeof vi.fn>,
    ).not.toHaveBeenCalled();
  });

  it("renders the pending import label for optimistic clips", () => {
    const context = createContextSpy();
    const snapshot = createSnapshot(false);
    snapshot.clipsByTrack["track-1"] = [
      {
        ...snapshot.clipsByTrack["track-1"][0],
        isPending: true,
        pendingStatus: "importing",
        waveformStatus: "pending",
      },
    ];

    drawTrackClipsLayer(context, snapshot, viewport);

    const expectedLabel = i18n.t("library.pendingStatus.importing").toUpperCase();
    expect(
      (context.fillText as ReturnType<typeof vi.fn>).mock.calls.some(
        ([text]) => text === expectedLabel,
      ),
    ).toBe(true);
  });

  it("renders waveform tiles once analysis is ready", () => {
    const context = createContextSpy();

    drawTrackClipsLayer(context, createSnapshot(true), viewport);

    expect(context.drawImage as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    expect(
      (context.fillText as ReturnType<typeof vi.fn>).mock.calls.some(
        ([text]) => text === "ANALYZING...",
      ),
    ).toBe(false);
  });

  it("labels clips from their file name instead of the destination track", () => {
    const context = createContextSpy();
    const snapshot = createSnapshot(true);
    snapshot.clipsByTrack["track-1"] = [
      {
        ...snapshot.clipsByTrack["track-1"][0],
        filePath: "audio/metronomo.wav",
        waveformKey: "audio/lead.wav",
      },
    ];

    drawTrackClipsLayer(context, snapshot, viewport);

    expect(
      (context.fillText as ReturnType<typeof vi.fn>).mock.calls.some(
        ([text]) => text === "Metronomo",
      ),
    ).toBe(true);
    expect(
      (context.fillText as ReturnType<typeof vi.fn>).mock.calls.some(
        ([text]) => text === "Lead",
      ),
    ).toBe(false);
  });
});
