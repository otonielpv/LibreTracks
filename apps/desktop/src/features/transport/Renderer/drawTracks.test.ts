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
import { drawTrackClipsLayer, folderCaptionFontSizes } from "./drawTracks";
import { TRACK_HEIGHT_MAX, TRACK_HEIGHT_MIN } from "../constants";
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

  it("paints the folder row opaque and full-bleed", () => {
    // The folder band used to be a `${color}33` tint (20% alpha) inset by 8px
    // on each side, so the timeline grid ran through the row and the band
    // stopped short of the timeline edges.
    const fills: string[] = [];
    const fillRects: number[][] = [];
    let fillStyle = "";
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn((...args: number[]) => {
        fills.push(fillStyle);
        fillRects.push(args);
      }),
      beginPath: vi.fn(),
      roundRect: vi.fn(),
      clip: vi.fn(),
      fillText: vi.fn(),
      stroke: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      drawImage: vi.fn(),
      rect: vi.fn(),
      fill: vi.fn(() => fills.push(fillStyle)),
      measureText: (text: string) => ({ width: text.length * 6 }),
      set fillStyle(value: string) {
        fillStyle = value;
      },
      get fillStyle() {
        return fillStyle;
      },
      set strokeStyle(_value: string) {},
      set lineWidth(_value: number) {},
      set font(_value: string) {},
      set textAlign(_value: string) {},
      set textBaseline(_value: string) {},
    } as unknown as CanvasRenderingContext2D;

    const snapshot = createSnapshot(false);
    const folder = {
      id: "folder-1",
      name: "Banda",
      kind: "folder" as const,
      parentTrackId: null,
      depth: 0,
      hasChildren: true,
      volume: 1,
      pan: 0,
      muted: false,
      solo: false,
      audioTo: "master",
      transposeEnabled: false,
      color: "#ff5555",
    };
    snapshot.visibleTracks = [folder];
    snapshot.song.tracks = [
      folder,
      { ...snapshot.song.tracks[0], parentTrackId: "folder-1" },
    ];
    snapshot.clipsByTrack = {};
    // Bars present so the faint grid hint drawn over the band is exercised.
    snapshot.timelineGrid.bars = [0, 2, 4];

    drawTrackClipsLayer(context, snapshot, viewport);

    // Every fill is opaque — an `rgb(...)` blend or a plain 6-digit hex, but
    // never an `rgba(...)` or an 8-digit `#rrggbbaa` that the grid shows through.
    expect(fills.length).toBeGreaterThan(0);
    expect(
      fills.every(
        (style) =>
          style.startsWith("rgb(") || /^#[0-9a-f]{6}$/i.test(style),
      ),
    ).toBe(true);

    // ...and spanning the full canvas width, not inset from the edges.
    const band = fillRects.find(
      ([rectX, , rectWidth]) => rectX === 0 && rectWidth === snapshot.width,
    );
    expect(band).toBeDefined();

    // A solid accent ribbon in the raw folder colour anchors the row to the
    // header's swatch; a pre-blended tint alone does not read as that colour.
    expect(fills).toContain(folder.color);
    const ribbon = fillRects.find(([, , rectWidth]) => rectWidth === 3);
    expect(ribbon).toBeDefined();
    expect(ribbon?.[0]).toBe(0);

    // The folder's own name leads the caption, so a collapsed folder stays
    // identifiable without looking back at the header column.
    const captions = (context.fillText as ReturnType<typeof vi.fn>).mock.calls
      .map(([text]) => text)
      .filter((text): text is string => typeof text === "string");
    expect(captions).toContain("Banda");

    // ...and the child count still reaches the caption alongside it.
    expect(captions.some((text) => text.includes("1"))).toBe(true);
  });

  describe("folder caption type scale", () => {
    it("never shrinks below the size the caption had before it scaled", () => {
      // The whole point of the floor: the thinnest possible row must stay at
      // least as readable as it is today, so the scale can only ever add size.
      for (let height = TRACK_HEIGHT_MIN; height <= TRACK_HEIGHT_MAX; height += 1) {
        const { namePx, countPx } = folderCaptionFontSizes(height);
        expect(namePx).toBeGreaterThanOrEqual(11);
        expect(countPx).toBeGreaterThanOrEqual(10);
      }
    });

    it("grows the name as the row gets taller", () => {
      const min = folderCaptionFontSizes(TRACK_HEIGHT_MIN);
      const max = folderCaptionFontSizes(TRACK_HEIGHT_MAX);
      expect(max.namePx).toBeGreaterThan(min.namePx);
      expect(max.countPx).toBeGreaterThan(min.countPx);
    });

    it("keeps the count subordinate to the name at every row height", () => {
      for (let height = TRACK_HEIGHT_MIN; height <= TRACK_HEIGHT_MAX; height += 1) {
        const { namePx, countPx } = folderCaptionFontSizes(height);
        expect(countPx).toBeLessThan(namePx);
      }
    });

    it("never lets the caption outgrow the row it sits in", () => {
      // A glyph taller than its band would bleed into the neighbouring lanes.
      for (let height = TRACK_HEIGHT_MIN; height <= TRACK_HEIGHT_MAX; height += 1) {
        const { namePx } = folderCaptionFontSizes(height);
        expect(namePx).toBeLessThanOrEqual(height);
      }
    });

    it("is monotonic and clamped outside the interpolation range", () => {
      let previous = 0;
      for (let height = 0; height <= 400; height += 1) {
        const { namePx } = folderCaptionFontSizes(height);
        expect(namePx).toBeGreaterThanOrEqual(previous);
        previous = namePx;
      }
      // Clamped at both ends rather than extrapolating off the scale.
      expect(folderCaptionFontSizes(0).namePx).toBe(11);
      expect(folderCaptionFontSizes(1000).namePx).toBe(19);
    });
  });

  it("falls back to the child count when the folder has no name", () => {
    let fillStyle = "";
    const context = {
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
      measureText: (text: string) => ({ width: text.length * 6 }),
      set fillStyle(value: string) {
        fillStyle = value;
      },
      get fillStyle() {
        return fillStyle;
      },
      set strokeStyle(_value: string) {},
      set lineWidth(_value: number) {},
      set font(_value: string) {},
      set textAlign(_value: string) {},
      set textBaseline(_value: string) {},
    } as unknown as CanvasRenderingContext2D;

    const snapshot = createSnapshot(false);
    const folder = {
      id: "folder-1",
      name: "   ",
      kind: "folder" as const,
      parentTrackId: null,
      depth: 0,
      hasChildren: false,
      volume: 1,
      pan: 0,
      muted: false,
      solo: false,
      audioTo: "master",
      transposeEnabled: false,
      color: "#ff5555",
    };
    snapshot.visibleTracks = [folder];
    snapshot.song.tracks = [folder];
    snapshot.clipsByTrack = {};

    drawTrackClipsLayer(context, snapshot, viewport);

    // A blank name must not leave the row captionless.
    const captions = (context.fillText as ReturnType<typeof vi.fn>).mock.calls
      .map(([text]) => text)
      .filter((text): text is string => typeof text === "string");
    expect(captions.length).toBeGreaterThan(0);
    expect(captions.every((text) => text.trim().length > 0)).toBe(true);
  });
});
