import { describe, expect, it, vi } from "vitest";

import { drawRulerMarker, LANE_CUES, LANE_SECTIONS } from "./drawBackground";
import type { MarkerKind } from "@libretracks/shared/models";
import type { SectionMarkerSummary } from "../desktopApi";

type Pt = { x: number; y: number };

function createContextSpy() {
  // Each beginPath() starts a new sub-path; we collect points per sub-path so a
  // test can target just the flag body and ignore the stem/arrowhead paths.
  const paths: Pt[][] = [];
  let current: Pt[] = [];
  const moves: Pt[] = [];
  const lines: Pt[] = [];
  const texts: { text: string; x: number; y: number }[] = [];
  const push = (x: number, y: number) => current.push({ x, y });
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(() => {
      current = [];
      paths.push(current);
    }),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    moveTo: vi.fn((x: number, y: number) => {
      moves.push({ x, y });
      push(x, y);
    }),
    lineTo: vi.fn((x: number, y: number) => {
      lines.push({ x, y });
      push(x, y);
    }),
    fillText: vi.fn((text: string, x: number, y: number) =>
      texts.push({ text, x, y }),
    ),
    measureText: vi.fn((t: string) => ({ width: t.length * 6 })),
    set fillStyle(_v: string) {},
    set strokeStyle(_v: string) {},
    set lineWidth(_v: number) {},
    set font(_v: string) {},
    set textBaseline(_v: string) {},
    set shadowColor(_v: string) {},
    set shadowBlur(_v: number) {},
  } as unknown as CanvasRenderingContext2D;
  return { ctx, moves, lines, texts, paths };
}

/**
 * The flag body is the only closed sub-path with 5 vertices (the stem is 2
 * points, the arrowhead is 3 but tiny and centred on the stem). We pick the
 * 5-point sub-path.
 */
function flagBody(paths: Pt[][]): Pt[] {
  const body = paths.find((p) => p.length === 5);
  if (!body) throw new Error("flag body sub-path not found");
  return body;
}

function marker(
  startSeconds: number,
  kind: MarkerKind = "verse",
): SectionMarkerSummary {
  return {
    id: "m1",
    name: "SOLO GUITARRA",
    digit: null,
    startSeconds,
    kind,
  } as unknown as SectionMarkerSummary;
}

const OPTS = {
  isSelected: false,
  isArmed: false,
  isCurrent: false,
  pulseAlpha: 0,
};

const WIDTH = 800;
const HEIGHT = 122;
const PPS = 100;
const CAMERA_X = 0;

describe("drawRulerMarker flag geometry", () => {
  it("points the flag rightwards from the stem when there is room", () => {
    const { ctx, paths } = createContextSpy();
    // x = 100px, far from the right edge → no flip.
    drawRulerMarker(ctx, marker(1), WIDTH, HEIGHT, CAMERA_X, PPS, OPTS);
    const snappedX = Math.round(100) + 0.5;
    const body = flagBody(paths);
    const xs = body.map((p) => p.x);
    // Body extends to the right of the stem and never pokes out to its left.
    expect(Math.max(...xs)).toBeGreaterThan(snappedX);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(snappedX - 0.5);
  });

  it("mirrors the flag leftwards near the right edge without a residual stub", () => {
    const { ctx, paths } = createContextSpy();
    // Place the marker hard against the right edge so alignRight triggers.
    const seconds = (WIDTH - 4) / PPS;
    drawRulerMarker(ctx, marker(seconds), WIDTH, HEIGHT, CAMERA_X, PPS, OPTS);
    const snappedX = Math.round(seconds * PPS) + 0.5;
    const body = flagBody(paths);
    const xs = body.map((p) => p.x);

    // Body must grow to the LEFT of the stem.
    expect(Math.min(...xs)).toBeLessThan(snappedX);

    // No part of the flag body may poke out to the right of the stem — that
    // residual stub was the "weird square" the user reported.
    expect(Math.max(...xs)).toBeLessThanOrEqual(snappedX + 0.5);

    // The flag's flat side stays anchored at the stem (top and bottom corners).
    const flagTop = LANE_SECTIONS.top + 1;
    const labelHeight = 16;
    const anchoredCorners = body.filter((p) => Math.abs(p.x - snappedX) < 0.6);
    expect(
      anchoredCorners.some((p) => Math.abs(p.y - (flagTop + 1)) < 1.2),
    ).toBe(true);
    expect(
      anchoredCorners.some(
        (p) => Math.abs(p.y - (flagTop + labelHeight - 1)) < 1.2,
      ),
    ).toBe(true);
  });

  it("draws a section marker in the section lane", () => {
    const { ctx, paths } = createContextSpy();
    drawRulerMarker(ctx, marker(1, "chorus"), WIDTH, HEIGHT, CAMERA_X, PPS, OPTS);
    const body = flagBody(paths);
    const ys = body.map((p) => p.y);
    // All flag vertices sit within the section lane's vertical band.
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(LANE_SECTIONS.top);
    expect(Math.max(...ys)).toBeLessThanOrEqual(
      LANE_SECTIONS.top + LANE_SECTIONS.height,
    );
  });

  it("draws a cue marker in the cue lane, above the section lane", () => {
    const { ctx, paths } = createContextSpy();
    // "build" is a dynamic cue → it must render in LANE_CUES, not LANE_SECTIONS.
    drawRulerMarker(ctx, marker(1, "build"), WIDTH, HEIGHT, CAMERA_X, PPS, OPTS);
    const body = flagBody(paths);
    const ys = body.map((p) => p.y);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(LANE_CUES.top);
    // The whole cue flag sits above where the section lane starts.
    expect(Math.max(...ys)).toBeLessThanOrEqual(LANE_SECTIONS.top);
  });
});
