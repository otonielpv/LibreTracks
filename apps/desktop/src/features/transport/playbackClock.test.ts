import { describe, expect, it } from "vitest";

import {
  CLOCK_RESYNC_EASE_MS,
  FOLLOW_CAMERA_LOCK_PX,
  type PlaybackVisualAnchor,
  resolveFollowCameraEaseFactor,
  resolveFollowCameraX,
  resolveVisualCorrectionSeconds,
} from "./playbackClock";

function anchor(overrides: Partial<PlaybackVisualAnchor>): PlaybackVisualAnchor {
  return {
    anchorPositionSeconds: 0,
    anchorReceivedAtMs: 0,
    durationSeconds: 100,
    running: true,
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
    expect(
      resolveVisualCorrectionSeconds(a, 1000 + CLOCK_RESYNC_EASE_MS),
    ).toBe(0);
    expect(
      resolveVisualCorrectionSeconds(a, 1000 + CLOCK_RESYNC_EASE_MS + 500),
    ).toBe(0);
  });
});

describe("resolveFollowCameraEaseFactor", () => {
  it("uses the base smoothing at a 60fps frame delta", () => {
    expect(resolveFollowCameraEaseFactor(1 / 60)).toBeCloseTo(0.22, 6);
  });

  it("scales up for a longer (slower fps) frame so the feel is fps-independent", () => {
    // Twice the frame time ⇒ roughly twice the closure per frame.
    expect(resolveFollowCameraEaseFactor(2 / 60)).toBeCloseTo(0.44, 6);
  });

  it("clamps to 1 for a very long stall so it can't overshoot", () => {
    expect(resolveFollowCameraEaseFactor(1)).toBe(1);
  });
});

describe("resolveFollowCameraX", () => {
  it("locks rigidly to the goal during steady tracking (small gap)", () => {
    // A within-lock gap is steady tracking: go straight to the goal so the
    // camera advances at exactly the playhead's velocity. This is what keeps
    // low-zoom follow smooth — no exponential chase, no rAF-jitter ripple.
    const goal = 100 + FOLLOW_CAMERA_LOCK_PX / 2;
    expect(
      resolveFollowCameraX({
        currentCameraX: 100,
        goalCameraX: goal,
        frameDtSeconds: 1 / 60,
      }),
    ).toBe(goal);
  });

  it("locks straight to a sub-pixel-per-frame advance (no stutter)", () => {
    // The low-zoom case: the goal is a fraction of a pixel ahead. It must move,
    // not get suppressed, or the camera stalls every other frame.
    expect(
      resolveFollowCameraX({
        currentCameraX: 0,
        goalCameraX: 0.4,
        frameDtSeconds: 1 / 60,
      }),
    ).toBeCloseTo(0.4, 6);
  });

  it("eases toward a far goal (a discontinuity) instead of jumping", () => {
    const next = resolveFollowCameraX({
      currentCameraX: 0,
      goalCameraX: 1000, // well beyond the lock radius
      frameDtSeconds: 1 / 60,
    });
    // 22% of 1000 = 220, fractional (never rounded).
    expect(next).toBeCloseTo(220, 6);
  });

  it("returns null when already at the goal (no write needed)", () => {
    expect(
      resolveFollowCameraX({
        currentCameraX: 50,
        goalCameraX: 50,
        frameDtSeconds: 1 / 60,
      }),
    ).toBeNull();
  });

  it("eases a large jump then locks, converging exactly to the goal", () => {
    let camera = 0;
    for (let i = 0; i < 120; i += 1) {
      const next = resolveFollowCameraX({
        currentCameraX: camera,
        goalCameraX: 1000,
        frameDtSeconds: 1 / 60,
      });
      if (next !== null) camera = next;
    }
    expect(camera).toBeCloseTo(1000, 6);
  });
});
