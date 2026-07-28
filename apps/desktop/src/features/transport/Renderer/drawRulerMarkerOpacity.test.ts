import { describe, expect, it, vi } from "vitest";

import {
  drawRulerGridLabels,
  drawRulerMarker,
  drawRulerTempoMarker,
  LANE_CUES,
  LANE_SECTIONS,
  LANE_TEMPO_METRIC,
} from "./drawBackground";
import type { TimelineGrid } from "../timeline/timelineMath";
import type { MarkerKind } from "@libretracks/shared/models";
import type {
  SectionMarkerSummary,
  TempoMarkerSummary,
} from "../desktopApi";

/**
 * Marker flags must paint an OPAQUE body. They used to fill with a ~16%
 * translucent tint, which let the full-height bar/beat grid lines read straight
 * through the label — with many markers on screen the names became hard to
 * pick out against the ruler.
 */

type FillEvent = { style: string; index: number };

function createFillSpy() {
  const fills: FillEvent[] = [];
  let fillStyle = "";
  let index = 0;
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(() => {
      fills.push({ style: fillStyle, index: index++ });
    }),
    stroke: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    roundRect: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn((t: string) => ({ width: t.length * 6 })),
    set fillStyle(v: string) {
      fillStyle = v;
    },
    get fillStyle() {
      return fillStyle;
    },
    set strokeStyle(_v: string) {},
    set lineWidth(_v: number) {},
    set font(_v: string) {},
    set textBaseline(_v: string) {},
    set shadowColor(_v: string) {},
    get shadowColor() {
      return "";
    },
    set shadowBlur(_v: number) {},
    get shadowBlur() {
      return 0;
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, fills };
}

function isOpaque(style: string) {
  // Opaque means either an rgb(...) / #hex colour, or an rgba with alpha 1.
  if (style.startsWith("rgba")) {
    const alpha = Number(style.split(",").at(-1)?.replace(")", "").trim());
    return alpha === 1;
  }
  return style.startsWith("rgb(") || style.startsWith("#");
}

function marker(
  kind: MarkerKind = "verse",
  startSeconds = 1,
): SectionMarkerSummary {
  return {
    id: "m1",
    name: "SOLO GUITARRA",
    digit: null,
    startSeconds,
    kind,
  } as unknown as SectionMarkerSummary;
}

const WIDTH = 800;
const HEIGHT = 134;
const PPS = 100;
const CAMERA_X = 0;

const RESTING = {
  isSelected: false,
  isArmed: false,
  isCurrent: false,
  pulseAlpha: 0,
};

describe("ruler flags mask the grid behind them", () => {
  it.each([
    ["resting", RESTING],
    ["selected", { ...RESTING, isSelected: true }],
    ["current", { ...RESTING, isCurrent: true }],
    // Armed pulses, so its tint stays translucent — but it must still be
    // painted over an opaque backdrop.
    ["armed", { ...RESTING, isArmed: true, pulseAlpha: 0.8 }],
  ])("paints an opaque body for a %s section marker", (_name, options) => {
    const { ctx, fills } = createFillSpy();
    drawRulerMarker(ctx, marker(), WIDTH, HEIGHT, CAMERA_X, PPS, options);

    // The first fill is the opaque backdrop that masks the grid lines.
    expect(fills.length).toBeGreaterThan(0);
    expect(isOpaque(fills[0].style)).toBe(true);
  });

  it("keeps the resting tint itself opaque so no grid shows through", () => {
    const { ctx, fills } = createFillSpy();
    drawRulerMarker(ctx, marker("chorus"), WIDTH, HEIGHT, CAMERA_X, PPS, RESTING);

    // Backdrop AND the tinted body on top of it are both opaque.
    expect(isOpaque(fills[0].style)).toBe(true);
    expect(isOpaque(fills[1].style)).toBe(true);
  });

  it("keeps cue flags clear of the bar/timecode grid labels", () => {
    // Regression: dynamic-cue flags used to start flush with the top of their
    // lane, drawing straight over the timecode label that shares the band.
    const FONT_PX = 9;
    const texts: { text: string; x: number; y: number }[] = [];
    const points: { x: number; y: number }[] = [];
    let font = "";
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      moveTo: vi.fn((x: number, y: number) => points.push({ x, y })),
      lineTo: vi.fn((x: number, y: number) => points.push({ x, y })),
      fillText: vi.fn((text: string, x: number, y: number) =>
        texts.push({ text, x, y }),
      ),
      measureText: vi.fn((t: string) => ({ width: t.length * 6 })),
      set fillStyle(_v: string) {},
      set strokeStyle(_v: string) {},
      set lineWidth(_v: number) {},
      set font(v: string) {
        font = v;
      },
      get font() {
        return font;
      },
      set textAlign(_v: string) {},
      set textBaseline(_v: string) {},
      set shadowColor(_v: string) {},
      get shadowColor() {
        return "";
      },
      set shadowBlur(_v: number) {},
      get shadowBlur() {
        return 0;
      },
    } as unknown as CanvasRenderingContext2D;

    const grid = {
      bars: [0],
      beats: [0],
      markers: [
        { seconds: 0, barNumber: 1, beatInBar: 1, isBarStart: true },
        { seconds: 2, barNumber: 2, beatInBar: 1, isBarStart: true },
      ],
      showBeatLabels: false,
      showBeatGridLines: false,
      barLabelStep: 1,
      beatsPerBar: 4,
    } as unknown as TimelineGrid;

    drawRulerGridLabels(ctx, grid, WIDTH, CAMERA_X, PPS);
    expect(texts.length).toBeGreaterThan(0);

    // Every grid label sits on ONE line: no label may extend into the strip
    // where the cue flag body is drawn.
    const labelBottom = Math.max(...texts.map((t) => t.y)) + FONT_PX;

    points.length = 0;
    drawRulerMarker(ctx, marker("build"), WIDTH, HEIGHT, CAMERA_X, PPS, RESTING);

    // Nothing the cue draws — flag body, stem or arrowhead — may reach up into
    // the label line.
    const flagTop = Math.min(...points.map((p) => p.y));
    expect(flagTop).toBeGreaterThanOrEqual(labelBottom);

    // The 16px flag BODY still fits inside the cue lane, so it never overlaps
    // the section flags below. (The stem's arrowhead deliberately pokes past
    // the lane edge — that is the pre-existing pointer geometry.)
    const bodyPoints = points.filter((p) => p.y <= LANE_SECTIONS.top);
    expect(Math.max(...bodyPoints.map((p) => p.y))).toBeLessThanOrEqual(
      LANE_SECTIONS.top,
    );
    // Sanity: the body really was drawn (5 vertices), not just the stem.
    expect(bodyPoints.length).toBeGreaterThanOrEqual(5);
  });

  it("stacks the bar number and timecode on two lines", () => {
    const texts: { text: string; x: number; y: number }[] = [];
    const ctx = {
      fillText: vi.fn((text: string, x: number, y: number) =>
        texts.push({ text, x, y }),
      ),
      measureText: vi.fn((t: string) => ({ width: t.length * 6 })),
      set fillStyle(_v: string) {},
      set font(_v: string) {},
      set textAlign(_v: string) {},
      set textBaseline(_v: string) {},
    } as unknown as CanvasRenderingContext2D;

    const grid = {
      bars: [0],
      beats: [0],
      markers: [{ seconds: 0, barNumber: 1, beatInBar: 1, isBarStart: true }],
      showBeatLabels: false,
      showBeatGridLines: false,
      barLabelStep: 1,
      beatsPerBar: 4,
    } as unknown as TimelineGrid;

    drawRulerGridLabels(ctx, grid, WIDTH, CAMERA_X, PPS);

    // Bar position and timecode share a left edge, stacked on two lines.
    expect(texts).toHaveLength(2);
    expect(texts[0].x).toBe(texts[1].x);
    expect(texts[1].y).toBeGreaterThan(texts[0].y);
  });

  it("keeps every ruler lane inside the ruler height the CSS reserves", () => {
    // The ruler's height is declared in three places that must agree, or the
    // timeline and the track-header column stop lining up: RULER_HEIGHT in
    // TimelineCanvasPane.tsx, the .lt-ruler-* CSS heights, and the lane layout
    // here. This pins the lane layout to the desktop value.
    const DESKTOP_RULER_HEIGHT = 134;
    const lanesBottom = LANE_TEMPO_METRIC.top + LANE_TEMPO_METRIC.height;

    expect(lanesBottom).toBeLessThanOrEqual(DESKTOP_RULER_HEIGHT);
    // The lanes must not stack in the wrong order or overlap each other.
    expect(LANE_CUES.top + LANE_CUES.height).toBeLessThanOrEqual(
      LANE_SECTIONS.top,
    );
    expect(LANE_SECTIONS.top + LANE_SECTIONS.height).toBeLessThanOrEqual(
      LANE_TEMPO_METRIC.top,
    );
  });

  it("paints an opaque body for tempo and time-signature flags", () => {
    const tempoMarker = {
      id: "t1",
      startSeconds: 1,
      bpm: 128,
    } as unknown as TempoMarkerSummary;

    const tempo = createFillSpy();
    drawRulerTempoMarker(
      tempo.ctx,
      tempoMarker,
      WIDTH,
      HEIGHT,
      CAMERA_X,
      PPS,
    );
    expect(tempo.fills.length).toBeGreaterThan(0);
    expect(tempo.fills.every((f) => isOpaque(f.style))).toBe(true);

    const signature = createFillSpy();
    drawRulerTempoMarker(
      signature.ctx,
      tempoMarker,
      WIDTH,
      HEIGHT,
      CAMERA_X,
      PPS,
      "4/4",
    );
    expect(signature.fills.length).toBeGreaterThan(0);
    expect(signature.fills.every((f) => isOpaque(f.style))).toBe(true);
  });
});
