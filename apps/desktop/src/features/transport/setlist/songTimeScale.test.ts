import { describe, expect, it } from "vitest";

import { createSongTimeScale } from "./songTimeScale";

describe("createSongTimeScale", () => {
  it("fits the song in the width at zoom 1", () => {
    const scale = createSongTimeScale({ startSeconds: 100, endSeconds: 160, widthPx: 600 });
    expect(scale.pxPerSecond).toBe(10);
    expect(scale.secondsToPx(100)).toBe(0);
    expect(scale.secondsToPx(160)).toBe(600);
    expect(scale.pxToSeconds(300)).toBe(130);
    expect(scale.contentWidthPx).toBe(600);
  });

  it("round-trips within 1e-9", () => {
    const scale = createSongTimeScale({
      startSeconds: 12.345,
      endSeconds: 251.987,
      widthPx: 1337,
      zoom: 3.7,
      scrollPx: 812.5,
    });
    for (const seconds of [12.345, 20.1, 99.999, 180.25, 251.987]) {
      expect(Math.abs(scale.pxToSeconds(scale.secondsToPx(seconds)) - seconds)).toBeLessThan(1e-9);
    }
  });

  it("zoom widens the content and the scroll is clamped to it", () => {
    const scale = createSongTimeScale({ startSeconds: 0, endSeconds: 100, widthPx: 500, zoom: 4, scrollPx: 99999 });
    expect(scale.contentWidthPx).toBe(2000);
    expect(scale.scrollPx).toBe(1500);
    expect(scale.secondsToPx(100)).toBe(500);
    expect(scale.pxToSeconds(0)).toBe(75);

    const negative = createSongTimeScale({ startSeconds: 0, endSeconds: 100, widthPx: 500, zoom: 4, scrollPx: -20 });
    expect(negative.scrollPx).toBe(0);
  });

  it("zoom below 1 and nonsense values fall back to fitting", () => {
    expect(createSongTimeScale({ startSeconds: 0, endSeconds: 10, widthPx: 100, zoom: 0.25 }).zoom).toBe(1);
    expect(createSongTimeScale({ startSeconds: 0, endSeconds: 10, widthPx: 100, zoom: Number.NaN }).zoom).toBe(1);
  });

  it("clamps seconds to the song and survives an empty song or width", () => {
    const scale = createSongTimeScale({ startSeconds: 10, endSeconds: 20, widthPx: 100 });
    expect(scale.clampSeconds(5)).toBe(10);
    expect(scale.clampSeconds(25)).toBe(20);
    const empty = createSongTimeScale({ startSeconds: 10, endSeconds: 10, widthPx: 100 });
    expect(empty.pxToSeconds(50)).toBe(10);
    expect(Number.isFinite(empty.secondsToPx(10))).toBe(true);
  });

  it("widthPx 100 gives percentages", () => {
    const scale = createSongTimeScale({ startSeconds: 0, endSeconds: 80, widthPx: 100 });
    expect(scale.secondsToPx(20)).toBe(25);
  });
});
