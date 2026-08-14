import { describe, expect, it } from "vitest";

import { gainToDb } from "@libretracks/shared/faderScale";

import {
  isMultiEdit,
  offsetGainByDb,
  resolveEditTargets,
  volumeDeltaDb,
} from "./multiTrackEdit";

const MAX_TRACK_GAIN = 3.1622776601683795; // +10 dB

describe("resolveEditTargets", () => {
  it("fans out to the whole selection for a track inside it", () => {
    expect(resolveEditTargets("t2", ["t1", "t2", "t3"])).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
  });

  it("edits only the clicked track when it is outside the selection", () => {
    expect(resolveEditTargets("t9", ["t1", "t2", "t3"])).toEqual(["t9"]);
  });

  it("edits only the clicked track for a single selection", () => {
    expect(resolveEditTargets("t1", ["t1"])).toEqual(["t1"]);
    expect(resolveEditTargets("t1", [])).toEqual(["t1"]);
  });

  it("returns a copy so callers can't mutate the selection", () => {
    const selection = ["t1", "t2"];
    const targets = resolveEditTargets("t1", selection);
    targets.push("t3");
    expect(selection).toEqual(["t1", "t2"]);
  });

  it("isMultiEdit mirrors whether the edit fans out", () => {
    expect(isMultiEdit("t1", ["t1", "t2"])).toBe(true);
    expect(isMultiEdit("t9", ["t1", "t2"])).toBe(false);
    expect(isMultiEdit("t1", ["t1"])).toBe(false);
  });
});

describe("volumeDeltaDb", () => {
  it("measures the step in dB, not linear gain", () => {
    // Doubling the gain is +6.02 dB regardless of where you started.
    expect(volumeDeltaDb(0.25, 0.5)).toBeCloseTo(6.0206, 3);
    expect(volumeDeltaDb(1, 2)).toBeCloseTo(6.0206, 3);
  });

  it("is negative when the fader comes down", () => {
    expect(volumeDeltaDb(1, 0.5)).toBeCloseTo(-6.0206, 3);
  });

  it("has no dB delta when either end is silence", () => {
    expect(volumeDeltaDb(0, 0.5)).toBeNull();
    expect(volumeDeltaDb(0.5, 0)).toBeNull();
  });
});

describe("offsetGainByDb", () => {
  it("shifts a gain by the given dB", () => {
    expect(offsetGainByDb(0.5, 6.0206, MAX_TRACK_GAIN)).toBeCloseTo(1, 4);
    expect(offsetGainByDb(1, -6.0206, MAX_TRACK_GAIN)).toBeCloseTo(0.5, 4);
  });

  it("preserves the balance between two tracks", () => {
    // A sits 6 dB above B; after the same offset it still does.
    const a = offsetGainByDb(1, 3, MAX_TRACK_GAIN);
    const b = offsetGainByDb(0.5, 3, MAX_TRACK_GAIN);
    expect(gainToDb(a) - gainToDb(b)).toBeCloseTo(6.0206, 3);
  });

  it("clamps at the fader headroom instead of running away", () => {
    expect(offsetGainByDb(1, 99, MAX_TRACK_GAIN)).toBeCloseTo(
      MAX_TRACK_GAIN,
      4,
    );
  });

  it("collapses to silence below the dB floor", () => {
    expect(offsetGainByDb(0.5, -99, MAX_TRACK_GAIN)).toBe(0);
  });

  it("leaves an already-silent track silent", () => {
    // There is no finite dB to offset from, so a boost can't revive it.
    expect(offsetGainByDb(0, 12, MAX_TRACK_GAIN)).toBe(0);
  });
});
