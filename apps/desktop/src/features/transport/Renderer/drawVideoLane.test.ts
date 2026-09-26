import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SongView, VideoClipSummary } from "../desktopApi";
import {
  resetVideoCanvasState,
  setVideoClipPreview,
  storeThumbnailStrip,
  getThumbnailStrip,
} from "../video/videoCanvasState";
import { drawVideoLane, thumbnailTilesForClip } from "./drawVideoLane";
import type { TrackSceneSnapshot } from "./TimelineRenderer";

function contextSpy() {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    roundRect: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    drawImage: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    font: "",
    textBaseline: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
  };
}

function clip(overrides: Partial<VideoClipSummary> = {}): VideoClipSummary {
  return {
    id: "vc1",
    trackId: "v1",
    filePath: "D:/Visuales/letras.mp4",
    isMissing: false,
    timelineStartSeconds: 2,
    durationSeconds: 10,
    sourceStartSeconds: 0,
    sourceDurationSeconds: 10,
    fadeInSeconds: null,
    fadeOutSeconds: null,
    fit: null,
    color: null,
    ...overrides,
  };
}

function scene(clips: VideoClipSummary[]): TrackSceneSnapshot {
  return {
    width: 800,
    height: 200,
    zoomLevel: 20,
    pixelsPerSecond: 20,
    cameraX: 0,
    song: { videoClips: clips } as unknown as SongView,
  } as unknown as TrackSceneSnapshot;
}

const style = {
  trackColor: null,
  muted: false,
  readOnly: false,
  selectedClipIds: new Set<string>(),
  missingLabel: "FALTA",
};

/** A loaded 1-second-interval strip whose images report as decoded. */
function loadStrip(filePath: string, frames: number) {
  storeThumbnailStrip({
    filePath,
    intervalSeconds: 1,
    width: 160,
    height: 90,
    frames: Array.from({ length: frames }, () => "AAAA"),
  });
  const strip = getThumbnailStrip(filePath)!;
  strip.images.forEach((image, index) => {
    Object.defineProperty(image, "complete", { value: true });
    Object.defineProperty(image, "naturalWidth", { value: 160 });
    (image as unknown as { __index: number }).__index = index;
  });
  return strip;
}

beforeEach(() => resetVideoCanvasState());

describe("drawVideoLane", () => {
  it("draws a neutral pattern and no images while thumbnails are missing", () => {
    const context = contextSpy();
    drawVideoLane(context as unknown as CanvasRenderingContext2D, scene([clip()]), 0, "v1", 60, style);
    expect(context.drawImage).not.toHaveBeenCalled();
    expect(context.fillText).toHaveBeenCalledWith("letras.mp4", expect.any(Number), expect.any(Number));
    // The box starts at the clip's position: 2 s × 20 px/s.
    expect(context.roundRect.mock.calls[0][0]).toBe(40);
  });

  it("fills the clip with the thumbnail of each tile's media time", () => {
    loadStrip("D:/Visuales/letras.mp4", 20);
    const context = contextSpy();
    drawVideoLane(context as unknown as CanvasRenderingContext2D, scene([clip()]), 0, "v1", 60, style);
    const drawn = context.drawImage.mock.calls.map(
      ([image]) => (image as { __index: number }).__index,
    );
    expect(drawn.length).toBeGreaterThan(1);
    expect(drawn[0]).toBe(0);
    // Tiles advance through the media in order.
    expect([...drawn].sort((a, b) => a - b)).toEqual(drawn);
  });

  it("starts the strip at the trim point of a trimmed clip", () => {
    loadStrip("D:/Visuales/letras.mp4", 30);
    const context = contextSpy();
    drawVideoLane(
      context as unknown as CanvasRenderingContext2D,
      scene([clip({ sourceStartSeconds: 12 })]),
      0,
      "v1",
      60,
      style,
    );
    const first = context.drawImage.mock.calls[0][0] as { __index: number };
    expect(first.__index).toBe(12);
  });

  it("draws both fade ramps", () => {
    const context = contextSpy();
    drawVideoLane(
      context as unknown as CanvasRenderingContext2D,
      scene([clip({ fadeInSeconds: 1, fadeOutSeconds: 2 })]),
      0,
      "v1",
      60,
      style,
    );
    // Each fade is a filled triangle plus its ramp line.
    expect(context.closePath).toHaveBeenCalledTimes(2);
    // Fade-in ramp ends 1 s (20 px) in; fade-out starts 2 s (40 px) before the end.
    const lineTargets = context.lineTo.mock.calls.map(([x]) => x);
    expect(lineTargets).toContain(60);
    expect(lineTargets).toContain(200);
  });

  it("paints the drag preview instead of the stored geometry", () => {
    setVideoClipPreview("vc1", {
      startSeconds: 5,
      durationSeconds: 10,
      sourceStartSeconds: 0,
      fadeInSeconds: 0,
      fadeOutSeconds: 0,
    });
    const context = contextSpy();
    drawVideoLane(context as unknown as CanvasRenderingContext2D, scene([clip()]), 0, "v1", 60, style);
    expect(context.roundRect.mock.calls[0][0]).toBe(100);
  });

  it("skips clips outside the viewport", () => {
    const context = contextSpy();
    drawVideoLane(
      context as unknown as CanvasRenderingContext2D,
      scene([clip({ timelineStartSeconds: 500 })]),
      0,
      "v1",
      60,
      style,
    );
    expect(context.roundRect).not.toHaveBeenCalled();
  });

  it("marks a missing file and never draws its thumbnails", () => {
    loadStrip("D:/Visuales/letras.mp4", 20);
    const context = contextSpy();
    drawVideoLane(
      context as unknown as CanvasRenderingContext2D,
      scene([clip({ isMissing: true })]),
      0,
      "v1",
      60,
      style,
    );
    expect(context.drawImage).not.toHaveBeenCalled();
    expect(context.fillText.mock.calls[0][0]).toContain("FALTA");
  });
});

describe("thumbnailTilesForClip", () => {
  it("anchors tiles to the clip edge and only returns visible ones", () => {
    const tiles = thumbnailTilesForClip({
      clipLeft: -100,
      clipRight: 300,
      viewportWidth: 200,
      tileWidth: 50,
      startSeconds: 0,
      durationSeconds: 20,
      sourceStartSeconds: 3,
      sourceDurationSeconds: 20,
      pixelsPerSecond: 20,
    });
    expect(tiles.map((tile) => tile.x)).toEqual([-100 + 100, 50, 100, 150]);
    // First visible tile is 100 px = 5 s into the clip, + 3 s trim.
    expect(tiles[0].mediaSeconds).toBeCloseTo(8);
  });

  it("maps view time to media time under warp", () => {
    const tiles = thumbnailTilesForClip({
      clipLeft: 0,
      clipRight: 100,
      viewportWidth: 800,
      tileWidth: 50,
      startSeconds: 0,
      durationSeconds: 5,
      sourceStartSeconds: 0,
      sourceDurationSeconds: 10,
      pixelsPerSecond: 20,
    });
    // 50 px = 2.5 view seconds = 5 media seconds at a 2× ratio.
    expect(tiles[1].mediaSeconds).toBeCloseTo(5);
  });
});
