import { describe, expect, it } from "vitest";

import { beatPhase, estimateFromTaps, trimmedMean } from "./videoCalibration";

describe("video latency calibration by taps", () => {
  it("reduces a tap to its signed distance to the nearest beat", () => {
    expect(beatPhase(10.03, 0.5)).toBeCloseTo(0.03);
    expect(beatPhase(9.98, 0.5)).toBeCloseTo(-0.02);
    expect(beatPhase(1.26, 0.5, 0.25)).toBeCloseTo(0.01);
  });

  it("drops the worst 20 % before averaging", () => {
    // Eight good taps around 40 ms and two wild ones.
    const values = [0.04, 0.041, 0.039, 0.04, 0.042, 0.038, 0.04, 0.041, 0.2, -0.15];
    expect(trimmedMean(values)).toBeCloseTo(0.0401, 3);
    expect(trimmedMean([])).toBeNull();
  });

  it("estimates how late the picture is from synthetic taps", () => {
    const interval = 0.5;
    // The user hears the click 20 ms late (reaction) and sees the flash
    // 20 + 70 ms late: the picture lags by 70 ms. One sloppy tap each.
    const clickTaps = Array.from({ length: 10 }, (_, k) => k * interval + 0.02 + (k === 3 ? 0.15 : 0));
    const flashTaps = Array.from({ length: 10 }, (_, k) => k * interval + 0.09 + (k === 7 ? -0.12 : 0));
    const result = estimateFromTaps({ flashTaps, clickTaps, interval, currentOffsetMs: 10 });
    expect(result?.pictureLagMs).toBe(70);
    expect(result?.suggestedOffsetMs).toBe(80);
  });

  it("needs a few taps of each kind and clamps the suggestion", () => {
    expect(estimateFromTaps({ flashTaps: [0.1], clickTaps: [0, 1, 2], interval: 1, currentOffsetMs: 0 })).toBeNull();
    const result = estimateFromTaps({
      flashTaps: [0.4, 1.4, 2.4],
      clickTaps: [0, 1, 2],
      interval: 1,
      currentOffsetMs: 300,
    });
    expect(result?.suggestedOffsetMs).toBe(500);
  });
});
