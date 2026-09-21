import { describe, expect, it } from "vitest";

import {
  AUX_FADER_SCALE,
  DB_FLOOR,
  TRACK_FADER_SCALE,
  dbToGain,
  dbToPosition,
  formatGainDb,
  gainToDb,
  gainToPosition,
  positionToDb,
  snapPositionToUnity,
  FADER_UNITY_SNAP_THRESHOLD,
  positionToGain,
} from "./faderScale";

describe("gain <-> dB", () => {
  it("maps unity gain to 0 dB", () => {
    expect(gainToDb(1)).toBeCloseTo(0, 6);
    expect(dbToGain(0)).toBeCloseTo(1, 6);
  });

  it("maps +10 dB to ~3.162x", () => {
    expect(dbToGain(10)).toBeCloseTo(3.1623, 3);
    expect(gainToDb(3.1623)).toBeCloseTo(10, 2);
  });

  it("treats gain 0 as -inf", () => {
    expect(gainToDb(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(dbToGain(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("clamps dB at/below the floor to gain 0", () => {
    expect(dbToGain(DB_FLOOR)).toBe(0);
    expect(dbToGain(DB_FLOOR - 5)).toBe(0);
  });
});

describe("position <-> dB (track scale, max +10 dB)", () => {
  const s = TRACK_FADER_SCALE;

  it("top of travel is the max boost", () => {
    expect(positionToDb(1, s)).toBeCloseTo(10, 6);
  });

  it("unity position is exactly 0 dB", () => {
    expect(positionToDb(s.unityPosition, s)).toBeCloseTo(0, 6);
    expect(dbToPosition(0, s)).toBeCloseTo(s.unityPosition, 6);
  });

  it("bottom of travel is -inf", () => {
    expect(positionToDb(0, s)).toBe(Number.NEGATIVE_INFINITY);
    expect(positionToGain(0, s)).toBe(0);
  });

  it("0 dB sits above the middle (Ableton-style), not centred", () => {
    expect(dbToPosition(0, s)).toBeGreaterThan(0.6);
    expect(dbToPosition(0, s)).toBeLessThan(0.85);
  });

  it("puts the useful mixing band in the top half of travel", () => {
    // -12 dB up to unity lives in the top ~40% so fine control clusters where
    // mixing happens, not in inaudible territory.
    expect(dbToPosition(-12, s)).toBeGreaterThan(0.55);
    expect(dbToPosition(-24, s)).toBeGreaterThan(0.4);
  });

  it("a small drag below unity is only a few dB, not a plunge to silence", () => {
    // Regression: the old power curve dropped ~5 dB after 4% travel and then
    // plunged. Just below unity a few % of travel must stay in single-digit dB.
    const justBelow = positionToDb(s.unityPosition - 0.05, s);
    expect(justBelow).toBeGreaterThan(-8);
    expect(justBelow).toBeLessThan(0);
    // -5 dB must sit near unity (gentle), well above the fader midpoint.
    expect(dbToPosition(-5, s)).toBeGreaterThan(0.68);
  });

  it("round-trips a range of dB values through position", () => {
    for (const db of [-48, -24, -12, -6, -3, 0, 3, 6, 10]) {
      const pos = dbToPosition(db, s);
      expect(positionToDb(pos, s)).toBeCloseTo(db, 4);
    }
  });

  it("round-trips gain through position", () => {
    for (const gain of [0.01, 0.25, 0.5, 0.7, 1, 1.5, 2, 3.16]) {
      const pos = gainToPosition(gain, s);
      expect(positionToGain(pos, s)).toBeCloseTo(gain, 3);
    }
  });

  it("is monotonic increasing in dB across the travel", () => {
    let prev = -Infinity;
    for (let p = 0.01; p <= 1; p += 0.01) {
      const db = positionToDb(p, s);
      expect(db).toBeGreaterThan(prev);
      prev = db;
    }
  });
});

describe("aux scale reaches +20 dB", () => {
  it("top is +20 dB and unity is still 0 dB", () => {
    expect(positionToDb(1, AUX_FADER_SCALE)).toBeCloseTo(20, 6);
    expect(positionToDb(AUX_FADER_SCALE.unityPosition, AUX_FADER_SCALE)).toBeCloseTo(0, 6);
  });
});

describe("formatGainDb", () => {
  it("formats unity as 0.0", () => {
    expect(formatGainDb(1)).toBe("0.0");
  });

  it("prefixes positive values with +", () => {
    expect(formatGainDb(dbToGain(5))).toBe("+5.0");
  });

  it("shows negative values without a plus", () => {
    expect(formatGainDb(dbToGain(-10))).toBe("-10.0");
  });

  it("shows -inf for silence", () => {
    expect(formatGainDb(0)).toBe("-inf");
  });
});

describe("snapPositionToUnity", () => {
  const unity = TRACK_FADER_SCALE.unityPosition;

  it("pulls a position just under unity all the way to unity", () => {
    const justUnder = unity - FADER_UNITY_SNAP_THRESHOLD / 2;
    expect(snapPositionToUnity(justUnder, TRACK_FADER_SCALE)).toBe(unity);
  });

  it("pulls a position just over unity all the way to unity", () => {
    const justOver = unity + FADER_UNITY_SNAP_THRESHOLD / 2;
    expect(snapPositionToUnity(justOver, TRACK_FADER_SCALE)).toBe(unity);
  });

  it("leaves a position outside the magnet untouched", () => {
    const outside = unity - FADER_UNITY_SNAP_THRESHOLD * 2;
    expect(snapPositionToUnity(outside, TRACK_FADER_SCALE)).toBe(outside);
  });

  it("bypasses the magnet when asked (Shift during a drag)", () => {
    const justUnder = unity - FADER_UNITY_SNAP_THRESHOLD / 2;
    expect(snapPositionToUnity(justUnder, TRACK_FADER_SCALE, true)).toBe(
      justUnder,
    );
  });

  it("snapping lands on exactly 0 dB, which is the point of the magnet", () => {
    const nudged = unity + FADER_UNITY_SNAP_THRESHOLD / 3;
    const snapped = snapPositionToUnity(nudged, TRACK_FADER_SCALE);
    expect(positionToDb(snapped, TRACK_FADER_SCALE)).toBeCloseTo(0, 9);
    // Y sin iman el mismo gesto NO cae en 0 dB: si esto dejara de ser cierto,
    // las pruebas de arriba pasarian sin que el iman existiera.
    expect(positionToDb(nudged, TRACK_FADER_SCALE)).not.toBeCloseTo(0, 2);
  });

  it("works for the aux scale too, which has its own headroom", () => {
    const unityAux = AUX_FADER_SCALE.unityPosition;
    const nudged = unityAux - FADER_UNITY_SNAP_THRESHOLD / 2;
    expect(snapPositionToUnity(nudged, AUX_FADER_SCALE)).toBe(unityAux);
  });
});
