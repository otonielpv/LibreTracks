import { describe, expect, it } from "vitest";

import {
  DEFAULT_METER_FALLOFF_DB_PER_SECOND,
  METER_MAX_DB,
  METER_MIN_DB,
  clampPeak,
  gainToDb,
  meterDbToDisplayScale,
  meterStyleFromDb,
  peakHoldStyleFromDb,
  peakToMeterDb,
  stepMeterDb,
} from "./meterBallistics";

describe("clampPeak", () => {
  it("clamps into the [0, 1] range", () => {
    expect(clampPeak(-0.5)).toBe(0);
    expect(clampPeak(0.3)).toBe(0.3);
    expect(clampPeak(2)).toBe(1);
  });
});

describe("gainToDb", () => {
  it("maps unity gain to 0 dB", () => {
    expect(gainToDb(1)).toBeCloseTo(0, 6);
  });

  it("maps half amplitude to about -6 dB", () => {
    expect(gainToDb(0.5)).toBeCloseTo(-6.0206, 3);
  });

  it("floors silence to a finite very-low value instead of -Infinity", () => {
    const db = gainToDb(0);
    expect(Number.isFinite(db)).toBe(true);
    expect(db).toBeLessThan(-100);
  });
});

describe("peakToMeterDb", () => {
  it("returns the floor for silence", () => {
    expect(peakToMeterDb(0)).toBe(METER_MIN_DB);
    expect(peakToMeterDb(0.0005)).toBe(METER_MIN_DB);
  });

  it("maps unity to 0 dB", () => {
    expect(peakToMeterDb(1)).toBeCloseTo(0, 4);
  });

  it("lets hot peaks travel into the +6 dB headroom instead of pinning at 0", () => {
    // A post-mix bus above unity used to pin at 0 dB and freeze the meter.
    expect(peakToMeterDb(1.5)).toBeGreaterThan(0);
    expect(peakToMeterDb(1.5)).toBeCloseTo(3.522, 2);
  });

  it("clamps absurdly hot peaks to the max", () => {
    expect(peakToMeterDb(1000)).toBeCloseTo(METER_MAX_DB, 6);
  });
});

describe("meterDbToDisplayScale", () => {
  it("pins the bottom and top of the scale", () => {
    expect(meterDbToDisplayScale(METER_MIN_DB)).toBe(0);
    expect(meterDbToDisplayScale(-80)).toBe(0);
    expect(meterDbToDisplayScale(METER_MAX_DB)).toBe(1);
    expect(meterDbToDisplayScale(50)).toBe(1);
  });

  it("matches the anchor points exactly", () => {
    expect(meterDbToDisplayScale(0)).toBeCloseTo(0.85, 6);
    expect(meterDbToDisplayScale(-18)).toBeCloseTo(0.55, 6);
  });

  it("interpolates linearly between anchors", () => {
    // Halfway between -12 (0.65) and -6 (0.75) is -9 -> 0.70.
    expect(meterDbToDisplayScale(-9)).toBeCloseTo(0.7, 6);
  });

  it("is monotonically non-decreasing across the range", () => {
    let previous = -Infinity;
    for (let db = METER_MIN_DB; db <= METER_MAX_DB; db += 0.5) {
      const value = meterDbToDisplayScale(db);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });
});

describe("stepMeterDb", () => {
  it("rises instantly to a louder target (attack)", () => {
    expect(stepMeterDb(-30, -10, 16)).toBe(-10);
  });

  it("decays gradually toward a quieter target (release)", () => {
    // 15 dB/s over 1000ms == 15 dB of decay.
    expect(stepMeterDb(0, -60, 1000)).toBe(-15);
  });

  it("never overshoots below the target", () => {
    expect(stepMeterDb(-10, -12, 10_000)).toBe(-12);
  });

  it("honors a custom falloff rate", () => {
    expect(stepMeterDb(0, -60, 1000, 30)).toBe(-30);
  });

  it("uses the documented default falloff rate", () => {
    expect(DEFAULT_METER_FALLOFF_DB_PER_SECOND).toBe(15);
    expect(stepMeterDb(0, -60, 500)).toBe(-7.5);
  });
});

describe("meterStyleFromDb", () => {
  it("produces a full inset and hidden bar at the floor", () => {
    const style = meterStyleFromDb(METER_MIN_DB);
    expect(style.clipPath).toBe("inset(100.00% 0 0 0)");
    expect(style.opacity).toBe("0");
  });

  it("produces a zero inset and visible bar at the top", () => {
    const style = meterStyleFromDb(METER_MAX_DB);
    expect(style.clipPath).toBe("inset(0.00% 0 0 0)");
    expect(style.opacity).toBe("1");
  });
});

describe("peakHoldStyleFromDb", () => {
  it("translates the hold marker fully down and hides it at the floor", () => {
    const style = peakHoldStyleFromDb(METER_MIN_DB);
    expect(style.transform).toBe("translateY(100.00%)");
    expect(style.opacity).toBe("0");
  });

  it("keeps the hold marker at the top and visible at the ceiling", () => {
    const style = peakHoldStyleFromDb(METER_MAX_DB);
    expect(style.transform).toBe("translateY(0.00%)");
    expect(style.opacity).toBe("1");
  });
});
