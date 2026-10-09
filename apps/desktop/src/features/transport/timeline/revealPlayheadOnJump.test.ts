import { describe, expect, it } from "vitest";

import { cameraXAfterStoppedJump } from "./revealPlayheadOnJump";

// 100 px/s, 1000 px wide view showing 0–10 s of a 300 s session.
const base = {
  followEnabled: true,
  viewMode: "daw",
  cameraX: 0,
  pixelsPerSecond: 100,
  viewportWidth: 1000,
  durationSeconds: 300,
  contentEndSeconds: 300,
  followMode: "ahead" as const,
};

describe("cameraXAfterStoppedJump", () => {
  // The report: follow on, transport stopped, "next song" — the view stayed on
  // the old song while the playhead went off screen.
  it("brings an off-screen song into view", () => {
    const cameraX = cameraXAfterStoppedJump({ ...base, playheadSeconds: 120 });
    expect(cameraX).not.toBeNull();
    const playheadInView = 120 * 100 - (cameraX ?? 0);
    expect(playheadInView).toBeGreaterThanOrEqual(0);
    expect(playheadInView).toBeLessThanOrEqual(1000);
  });

  it("also goes back for the previous song", () => {
    const cameraX = cameraXAfterStoppedJump({
      ...base,
      cameraX: 20000,
      playheadSeconds: 30,
    });
    expect(cameraX).not.toBeNull();
    expect(cameraX ?? Infinity).toBeLessThanOrEqual(3000);
  });

  it("leaves the view alone with follow off or outside the DAW view", () => {
    expect(
      cameraXAfterStoppedJump({ ...base, followEnabled: false, playheadSeconds: 120 }),
    ).toBeNull();
    expect(
      cameraXAfterStoppedJump({ ...base, viewMode: "live", playheadSeconds: 120 }),
    ).toBeNull();
  });
});
