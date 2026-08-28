import { describe, expect, it } from "vitest";

import {
  FOLLOW_CAMERA_LOCK_PX,
  resolveFollowCameraEaseFactor,
  resolveFollowCameraX,
} from "./followCamera";

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
