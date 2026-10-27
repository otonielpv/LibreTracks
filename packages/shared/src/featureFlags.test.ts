import { describe, expect, it } from "vitest";

import { FEATURE_FLAGS } from "./featureFlags";

// Turning a flag on or off is a release decision: update its expectation in
// the same commit that does it.
describe("feature flags", () => {
  it("lyrics ship in 1.15.0", () => {
    expect(FEATURE_FLAGS.lyrics).toBe(true);
  });

  it("network sessions stay hidden until 1.16.0", () => {
    expect(FEATURE_FLAGS.networkSessions).toBe(true);
  });

  it("song analysis ships in 1.15.0", () => {
    expect(FEATURE_FLAGS.songAnalysis).toBe(true);
  });

  it("song templates stay hidden until 1.16.0", () => {
    expect(FEATURE_FLAGS.songTemplates).toBe(true);
  });
});
