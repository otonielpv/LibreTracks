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
