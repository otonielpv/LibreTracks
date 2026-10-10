import { describe, expect, it } from "vitest";

import { FEATURE_FLAGS } from "./featureFlags";

describe("feature flags", () => {
  // 1.14.0 ships without lyrics. Turning the flag on is a release decision:
  // update this expectation in the same commit that does it.
  it("lyrics stay hidden until the release that brings them", () => {
    expect(FEATURE_FLAGS.lyrics).toBe(false);
  });
});
