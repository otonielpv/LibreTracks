// The App test harness resets the redundancy store between tests (a store
// survives unmounting; useState does not). No reset of our own here.
import { describe, expect, it } from "vitest";

import "../../test/testUtils";
import { useRedundancyStore } from "./redundancyStore";

describe("redundancy store between App tests", () => {
  it("1/2: a test leaves a lost main behind", () => {
    useRedundancyStore.getState().setStatus({
      role: "backup",
      state: "mainLost",
      offsetMs: null,
      corrections: 0,
      otherName: "PC A",
      diffs: [],
      reason: "",
      roleOffer: null,
      uncleanExitWarning: false,
      sampleRateDiffers: false,
      pilotToneOn: false,
    });
    expect(useRedundancyStore.getState().mainLostAt).not.toBeNull();
  });

  it("2/2: the next test starts clean", () => {
    expect(useRedundancyStore.getState().status).toBeNull();
    expect(useRedundancyStore.getState().mainLostAt).toBeNull();
  });
});
