import { describe, expect, it, vi } from "vitest";

import { drawRulerRegion } from "./drawBackground";
import type { SongRegionSummary } from "../desktopApi";

/**
 * Minimal 2D-context spy that records every string handed to `fillText`, so a
 * test can assert which badges the region renderer painted. Only the members
 * `drawRulerRegion` touches are implemented.
 */
function createContextSpy() {
  const texts: string[] = [];
  const ctx = {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    rect: vi.fn(),
    roundRect: vi.fn(),
    clip: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn((text: string) => texts.push(text)),
    measureText: vi.fn((t: string) => ({ width: t.length * 6 })),
    set fillStyle(_v: string) {},
    set strokeStyle(_v: string) {},
    set lineWidth(_v: number) {},
    set font(_v: string) {},
    set textBaseline(_v: string) {},
  } as unknown as CanvasRenderingContext2D;
  return { ctx, texts };
}

function region(overrides: Partial<SongRegionSummary> = {}): SongRegionSummary {
  return {
    id: "r1",
    name: "Coro",
    startSeconds: 0,
    endSeconds: 10,
    transposeSemitones: 0,
    key: null,
    warpEnabled: false,
    warpSourceBpm: null,
    master: { gain: 1.0 },
    compactColumnWidthRem: null,
    ...overrides,
  } as SongRegionSummary;
}

const WIDTH = 800;
const PPS = 100;
const CAMERA_X = 0;

describe("drawRulerRegion key badge", () => {
  it("paints the region's key when there is no transpose", () => {
    const { ctx, texts } = createContextSpy();
    drawRulerRegion(ctx, region({ key: "Dm" }), WIDTH, CAMERA_X, PPS, false);
    expect(texts).toContain("Dm");
  });

  it("paints the transposed key when the region is transposed", () => {
    const { ctx, texts } = createContextSpy();
    drawRulerRegion(
      ctx,
      region({ key: "Dm", transposeSemitones: 2 }),
      WIDTH,
      CAMERA_X,
      PPS,
      false,
    );
    // Song in Dm + 2 semitones → Em, alongside the "+2 st" transpose badge.
    expect(texts).toContain("Em");
    expect(texts).toContain("+2 st");
    expect(texts).not.toContain("Dm");
  });

  it("still transposes the key on a warped region (warp ≠ pitch)", () => {
    const { ctx, texts } = createContextSpy();
    drawRulerRegion(
      ctx,
      region({
        key: "Dm",
        transposeSemitones: 5,
        warpEnabled: true,
        warpSourceBpm: 100,
      }),
      WIDTH,
      CAMERA_X,
      PPS,
      false,
    );
    // Dm + 5 semitones = Gm, regardless of warp.
    expect(texts).toContain("Gm");
    expect(texts).not.toContain("Dm");
  });

  it("paints no key badge when the region has no key set", () => {
    const { ctx, texts } = createContextSpy();
    drawRulerRegion(
      ctx,
      region({ transposeSemitones: 2 }),
      WIDTH,
      CAMERA_X,
      PPS,
      false,
    );
    // Only the region name and the transpose badge, no musical-key pill.
    expect(texts).toEqual(["Coro", "+2 st"]);
  });
});

describe("drawRulerRegion warp badge", () => {
  it("paints the warp badge next to the key and the source BPM", () => {
    const { ctx, texts } = createContextSpy();
    drawRulerRegion(
      ctx,
      region({ key: "Dm", warpEnabled: true, warpSourceBpm: 100 }),
      WIDTH,
      CAMERA_X,
      PPS,
      false,
    );
    // All three ride together on the left, right after the region name.
    expect(texts).toEqual(["Coro", "Dm", "warped", "100 BPM"]);
  });

  it("paints the warp badge even without a source BPM to show", () => {
    const { ctx, texts } = createContextSpy();
    drawRulerRegion(
      ctx,
      region({ warpEnabled: true, warpSourceBpm: null }),
      WIDTH,
      CAMERA_X,
      PPS,
      false,
    );
    expect(texts).toEqual(["Coro", "warped"]);
  });

  it("paints no warp badge when the region is not warped", () => {
    const { ctx, texts } = createContextSpy();
    drawRulerRegion(ctx, region({ key: "Dm" }), WIDTH, CAMERA_X, PPS, false);
    expect(texts).not.toContain("warped");
  });
});

describe("drawRulerRegion key changes", () => {
  function spyWithLines() {
    const spy = createContextSpy();
    const rects: number[][] = [];
    const lines: number[] = [];
    Object.assign(spy.ctx, {
      moveTo: vi.fn((x: number) => lines.push(x)),
      lineTo: vi.fn(),
      rect: vi.fn((...args: number[]) => rects.push(args)),
    });
    return { ...spy, rects, lines };
  }

  const modulating = (overrides: Partial<SongRegionSummary> = {}) =>
    region({
      startSeconds: 0,
      endSeconds: 60,
      key: "D",
      keyChanges: [{ id: "up", startSeconds: 4, key: "E" }],
      ...overrides,
    });

  it("marks the change at its exact spot with the new key next to it", () => {
    const { ctx, texts, lines } = spyWithLines();
    drawRulerRegion(ctx, modulating(), WIDTH, CAMERA_X, PPS, false);
    // 4 s at 100 px/s: the notch sits on x = 400.
    expect(lines).toContain(400.5);
    expect(texts).toEqual(["Coro", "D", "E"]);
  });

  it("cuts the pinned name at the next change so they never overlap", () => {
    const { ctx, rects } = spyWithLines();
    drawRulerRegion(ctx, modulating(), WIDTH, CAMERA_X, PPS, false);
    const clip = rects[0];
    expect(clip[0] + clip[2]).toBeLessThanOrEqual(400 - 3);
  });

  it("follows the key at the left edge once the change has scrolled past", () => {
    // Camera 1000 px in: the view starts at 10 s, after the change at 4 s.
    const { ctx, texts } = spyWithLines();
    drawRulerRegion(ctx, modulating(), WIDTH, 1000, PPS, false);
    expect(texts).toEqual(["Coro", "E"]);
  });

  it("drops the new key's pill when it does not fit, keeping the notch", () => {
    const { ctx, texts, lines } = spyWithLines();
    // The song ends 5 px after the change: no room for the pill.
    drawRulerRegion(ctx, modulating({ endSeconds: 4.05 }), WIDTH, CAMERA_X, PPS, false);
    expect(lines).toContain(400.5);
    expect(texts).not.toContain("E");
  });
});

describe("drawRulerRegion pinned name", () => {
  // The canvas is shifted left by the sub-pixel remainder after drawing, so a
  // name pinned to the left edge must be drawn that much further right to stay
  // put on screen; otherwise it shakes while the playhead is followed.
  it("cancels the canvas nudge when the name is pinned to the edge", () => {
    const { ctx } = createContextSpy();
    // Region started 2 s before the left edge: the name is pinned.
    drawRulerRegion(ctx, region(), WIDTH, 200, PPS, false, 0.4);
    const nameCall = vi.mocked(ctx.fillText).mock.calls.find(([text]) => text === "Coro");
    expect(nameCall?.[1]).toBeCloseTo(-1 + 0.4);
  });

  it("leaves a name that follows its region start untouched", () => {
    const { ctx } = createContextSpy();
    drawRulerRegion(ctx, region({ startSeconds: 1 }), WIDTH, 0, PPS, false, 0.4);
    const nameCall = vi.mocked(ctx.fillText).mock.calls.find(([text]) => text === "Coro");
    expect(nameCall?.[1]).toBe(100 + 7);
  });
});
