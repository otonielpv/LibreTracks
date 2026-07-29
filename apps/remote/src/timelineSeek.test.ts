import { describe, expect, it } from "vitest";

import {
  TIMELINE_PENDING_SEEK_TIMEOUT_MS,
  TIMELINE_TAP_MAX_MS,
  TIMELINE_TAP_SLOP_PX,
  isTimelineTap,
  resolvePendingSeek,
  timelineTapPositionSeconds,
} from "./timelineSeek";

describe("isTimelineTap", () => {
  it("accepts a still, quick release", () => {
    expect(isTimelineTap({ startClientX: 120, endClientX: 120, durationMs: 90 })).toBe(true);
  });

  it("tolerates jitter up to the slop radius in both directions", () => {
    expect(
      isTimelineTap({
        startClientX: 120,
        endClientX: 120 + TIMELINE_TAP_SLOP_PX,
        durationMs: 90,
      }),
    ).toBe(true);
    expect(
      isTimelineTap({
        startClientX: 120,
        endClientX: 120 - TIMELINE_TAP_SLOP_PX,
        durationMs: 90,
      }),
    ).toBe(true);
  });

  it("rejects a scrub that travelled past the slop radius", () => {
    expect(
      isTimelineTap({
        startClientX: 120,
        endClientX: 120 + TIMELINE_TAP_SLOP_PX + 1,
        durationMs: 90,
      }),
    ).toBe(false);
  });

  it("rejects a long press even when it never moved", () => {
    expect(
      isTimelineTap({
        startClientX: 120,
        endClientX: 120,
        durationMs: TIMELINE_TAP_MAX_MS + 1,
      }),
    ).toBe(false);
  });

  it("rejects non-finite or negative inputs", () => {
    expect(isTimelineTap({ startClientX: Number.NaN, endClientX: 120, durationMs: 10 })).toBe(false);
    expect(isTimelineTap({ startClientX: 120, endClientX: Number.NaN, durationMs: 10 })).toBe(false);
    expect(isTimelineTap({ startClientX: 120, endClientX: 120, durationMs: -1 })).toBe(false);
  });
});

describe("timelineTapPositionSeconds", () => {
  it("converts a tap on an untranslated ruler into seconds", () => {
    expect(
      timelineTapPositionSeconds({
        clientX: 300,
        shellLeft: 100,
        translateX: 0,
        pixelsPerSecond: 50,
      }),
    ).toBeCloseTo(4);
  });

  it("undoes the rAF translate so the tap lands on what is drawn", () => {
    // The ruler is pushed 150px right (auto-follow near the start of the song),
    // so content X = 300 - 100 - 150 = 50px → 1s at 50px/s.
    expect(
      timelineTapPositionSeconds({
        clientX: 300,
        shellLeft: 100,
        translateX: 150,
        pixelsPerSecond: 50,
      }),
    ).toBeCloseTo(1);
  });

  it("handles a negative translate (scrolled far into the song)", () => {
    expect(
      timelineTapPositionSeconds({
        clientX: 300,
        shellLeft: 100,
        translateX: -600,
        pixelsPerSecond: 50,
      }),
    ).toBeCloseTo(16);
  });

  it("clamps a tap before the start of the cinta to zero", () => {
    expect(
      timelineTapPositionSeconds({
        clientX: 110,
        shellLeft: 100,
        translateX: 400,
        pixelsPerSecond: 50,
      }),
    ).toBe(0);
  });

  it("returns null for unusable geometry", () => {
    expect(
      timelineTapPositionSeconds({
        clientX: 300,
        shellLeft: 100,
        translateX: 0,
        pixelsPerSecond: 0,
      }),
    ).toBeNull();
    expect(
      timelineTapPositionSeconds({
        clientX: Number.NaN,
        shellLeft: 100,
        translateX: 0,
        pixelsPerSecond: 50,
      }),
    ).toBeNull();
  });
});

describe("resolvePendingSeek", () => {
  const pending = { positionSeconds: 42, expiresAtMs: 1000 };

  it("keeps holding while the transport has not confirmed and time remains", () => {
    expect(
      resolvePendingSeek(pending, { transportRepositioned: false, frameAtMs: 500 }),
    ).toEqual(pending);
  });

  it("releases as soon as the transport reports the reposition", () => {
    expect(
      resolvePendingSeek(pending, { transportRepositioned: true, frameAtMs: 500 }),
    ).toBeNull();
  });

  it("releases when the deadline lapses so a dropped command cannot strand the cinta", () => {
    expect(
      resolvePendingSeek(pending, { transportRepositioned: false, frameAtMs: 1000 }),
    ).toBeNull();
    expect(
      resolvePendingSeek(pending, { transportRepositioned: false, frameAtMs: 1200 }),
    ).toBeNull();
  });

  it("passes through a null pending seek", () => {
    expect(resolvePendingSeek(null, { transportRepositioned: false, frameAtMs: 0 })).toBeNull();
  });

  it("holds for the full timeout window measured from the tap", () => {
    const tapAtMs = 5_000;
    const armed = {
      positionSeconds: 12,
      expiresAtMs: tapAtMs + TIMELINE_PENDING_SEEK_TIMEOUT_MS,
    };
    const justBefore = tapAtMs + TIMELINE_PENDING_SEEK_TIMEOUT_MS - 1;
    expect(
      resolvePendingSeek(armed, { transportRepositioned: false, frameAtMs: justBefore }),
    ).toEqual(armed);
    expect(
      resolvePendingSeek(armed, {
        transportRepositioned: false,
        frameAtMs: tapAtMs + TIMELINE_PENDING_SEEK_TIMEOUT_MS,
      }),
    ).toBeNull();
  });
});
