import { describe, expect, it } from "vitest";

import type { TransportSnapshot } from "./models";
import {
  CLOCK_RESYNC_EASE_MS,
  type PlaybackVisualAnchor,
  resolveVisualClockResync,
  resolveVisualCorrectionSeconds,
  resolveVisualPlaybackPosition,
  resolveVisualPositionAcrossVamp,
} from "./playbackClock";

function anchor(overrides: Partial<PlaybackVisualAnchor>): PlaybackVisualAnchor {
  return {
    anchorPositionSeconds: 0,
    anchorReceivedAtMs: 0,
    durationSeconds: 100,
    running: true,
    playbackRate: 1,
    correctionSeconds: 0,
    ...overrides,
  };
}

describe("resolveVisualCorrectionSeconds", () => {
  it("is zero when no correction is pending", () => {
    expect(resolveVisualCorrectionSeconds(anchor({}), 0)).toBe(0);
  });

  it("returns the full correction at the instant of re-anchor (continuity)", () => {
    const a = anchor({ correctionSeconds: 0.04, anchorReceivedAtMs: 1000 });
    expect(resolveVisualCorrectionSeconds(a, 1000)).toBeCloseTo(0.04, 6);
  });

  it("decays the correction linearly to zero across the ease window", () => {
    const a = anchor({ correctionSeconds: 0.04, anchorReceivedAtMs: 1000 });
    const half = resolveVisualCorrectionSeconds(
      a,
      1000 + CLOCK_RESYNC_EASE_MS / 2,
    );
    expect(half).toBeCloseTo(0.02, 6);
  });

  it("is fully resolved once the ease window elapses", () => {
    const a = anchor({ correctionSeconds: 0.04, anchorReceivedAtMs: 1000 });
    expect(resolveVisualCorrectionSeconds(a, 1000 + CLOCK_RESYNC_EASE_MS)).toBe(
      0,
    );
    expect(
      resolveVisualCorrectionSeconds(a, 1000 + CLOCK_RESYNC_EASE_MS + 500),
    ).toBe(0);
  });
});

describe("resolveVisualPlaybackPosition", () => {
  it("advances at the engine playback rate in warped regions", () => {
    const a = anchor({
      anchorPositionSeconds: 10,
      anchorReceivedAtMs: 1_000,
      playbackRate: 0.8,
    });

    expect(resolveVisualPlaybackPosition(a, 3_500)).toBeCloseTo(12, 6);
  });

  // The bug the four duplicated extrapolators had: two of them dropped
  // playbackRate entirely, so under warp the playhead ran at wall-clock speed
  // while the audio ran at the warped rate. Guard it here, once, for everyone.
  it("does not fall back to realtime when a rate is present", () => {
    const slow = anchor({ anchorReceivedAtMs: 0, playbackRate: 0.5 });
    const fast = anchor({ anchorReceivedAtMs: 0, playbackRate: 2 });

    expect(resolveVisualPlaybackPosition(slow, 1_000)).toBeCloseTo(0.5, 6);
    expect(resolveVisualPlaybackPosition(fast, 1_000)).toBeCloseTo(2, 6);
  });

  it("treats a missing or nonsensical rate as realtime", () => {
    const zero = anchor({ anchorReceivedAtMs: 0, playbackRate: 0 });
    const nan = anchor({ anchorReceivedAtMs: 0, playbackRate: Number.NaN });

    expect(resolveVisualPlaybackPosition(zero, 1_000)).toBeCloseTo(1, 6);
    expect(resolveVisualPlaybackPosition(nan, 1_000)).toBeCloseTo(1, 6);
  });

  it("does not advance a stopped anchor", () => {
    const a = anchor({
      anchorPositionSeconds: 10,
      anchorReceivedAtMs: 1_000,
      playbackRate: 1.5,
      running: false,
    });

    expect(resolveVisualPlaybackPosition(a, 3_500)).toBe(10);
  });
});

describe("resolveVisualPositionAcrossVamp", () => {
  const vamp = { startSeconds: 10, endSeconds: 20 };

  it("keeps the position inside the section before its end", () => {
    expect(resolveVisualPositionAcrossVamp(19.999, vamp)).toBe(19.999);
  });

  it("wraps directly to the VAMP start at the section boundary", () => {
    expect(resolveVisualPositionAcrossVamp(20, vamp)).toBe(10);
  });

  it("preserves overshoot without exposing the following section", () => {
    expect(resolveVisualPositionAcrossVamp(20.125, vamp)).toBeCloseTo(10.125, 6);
    expect(resolveVisualPositionAcrossVamp(40.125, vamp)).toBeCloseTo(10.125, 6);
  });

  it("ignores missing or invalid ranges", () => {
    expect(resolveVisualPositionAcrossVamp(20, null)).toBe(20);
    expect(
      resolveVisualPositionAcrossVamp(20, { startSeconds: 20, endSeconds: 20 }),
    ).toBe(20);
  });
});

describe("resolveVisualClockResync", () => {
  function snapshot(
    overrides: Partial<TransportSnapshot> = {},
  ): TransportSnapshot {
    return {
      playbackState: "playing",
      positionSeconds: 10,
      projectRevision: 1,
      isNativeRuntime: true,
      transportClock: {
        anchorPositionSeconds: 10,
        running: true,
        lastSeekPositionSeconds: 0,
        lastJumpPositionSeconds: null,
      },
      ...overrides,
    } as TransportSnapshot;
  }

  function resync(params: {
    anchor?: Partial<PlaybackVisualAnchor>;
    previousSnapshot?: TransportSnapshot | null;
    nextSnapshot?: TransportSnapshot;
    visualNowSeconds?: number;
  }) {
    return resolveVisualClockResync({
      anchor: anchor(params.anchor ?? {}),
      previousSnapshot:
        params.previousSnapshot === undefined
          ? snapshot()
          : params.previousSnapshot,
      nextSnapshot: params.nextSnapshot ?? snapshot(),
      visualNowSeconds: params.visualNowSeconds ?? 10,
      nowMs: 5000,
      maxDurationSeconds: 600,
      anchorDurationSeconds: 600,
    });
  }

  it("keeps the extrapolation while it tracks the engine within tolerance", () => {
    expect(resync({ visualNowSeconds: 10.05 })).toEqual({ kind: "keep" });
  });

  it("eases the anchor back when the drift is small enough to hide", () => {
    const decision = resync({ visualNowSeconds: 10.2 });
    expect(decision.kind).toBe("correct");
    if (decision.kind !== "correct") return;
    // Lands on the engine, but displays the current visual position at t0 so
    // the correction is invisible: 10.2 = 10 + 0.2.
    expect(decision.anchor.anchorPositionSeconds).toBeCloseTo(10, 6);
    expect(decision.anchor.correctionSeconds).toBeCloseTo(0.2, 6);
    expect(decision.anchor.running).toBe(true);
  });

  it("snaps when the clocks are too far apart to ease together", () => {
    expect(resync({ visualNowSeconds: 12 })).toEqual({ kind: "snap" });
  });

  it("defers to a full re-anchor when the transport actually moved", () => {
    const seeked = snapshot({
      transportClock: {
        anchorPositionSeconds: 30,
        running: true,
        lastSeekPositionSeconds: 30,
        lastJumpPositionSeconds: null,
      },
      positionSeconds: 30,
    });
    expect(resync({ nextSnapshot: seeked }).kind).toBe("reanchor");
  });

  it("never touches a parked anchor - that is a seek preview holding the cursor", () => {
    // previewSeek parks the anchor with running=false while the round trip to
    // the backend resolves. A poll landing mid-preview must not drag the
    // cursor off the pointer.
    expect(
      resync({ anchor: { running: false }, visualNowSeconds: 55 }).kind,
    ).toBe("reanchor");
  });

  it("defers to a full re-anchor when playback stopped", () => {
    expect(
      resync({ nextSnapshot: snapshot({ playbackState: "paused" }) }).kind,
    ).toBe("reanchor");
  });

  it("defers to a full re-anchor when the playback rate changed", () => {
    const warped = snapshot({
      transportClock: {
        anchorPositionSeconds: 10,
        running: true,
        playbackRate: 1.25,
        lastSeekPositionSeconds: 0,
        lastJumpPositionSeconds: null,
      },
    });
    expect(resync({ nextSnapshot: warped }).kind).toBe("reanchor");
  });

  it("compares against the live position, not the possibly stale anchor", () => {
    // Fallback snapshot flavour: the backend only refreshes the clock anchor at
    // its 250ms sync cadence while positionSeconds stays live. Trusting the
    // anchor here would report drift that isn't there.
    const stale = snapshot({
      positionSeconds: 10.02,
      transportClock: {
        anchorPositionSeconds: 9.8,
        running: true,
        lastSeekPositionSeconds: 0,
        lastJumpPositionSeconds: null,
      },
    });
    expect(resync({ nextSnapshot: stale, visualNowSeconds: 10 })).toEqual({
      kind: "keep",
    });
  });
});
