import { describe, expect, it } from "vitest";

import { calculateLiveProgress } from "./useLiveProgressBars";

describe("calculateLiveProgress", () => {
  it("returns a continuous normalized position", () => {
    expect(calculateLiveProgress(12.5, 10, 20)).toBe(0.25);
    expect(calculateLiveProgress(15.125, 10, 20)).toBeCloseTo(0.5125);
  });

  it("clamps outside the range and rejects an empty range", () => {
    expect(calculateLiveProgress(5, 10, 20)).toBe(0);
    expect(calculateLiveProgress(30, 10, 20)).toBe(1);
    expect(calculateLiveProgress(10, 10, 10)).toBe(0);
  });
});
