import { describe, expect, it } from "vitest";

import { boundedTimelineScrollTop } from "./useBoundedTimelineScroll";

describe("boundedTimelineScrollTop", () => {
  it("clamps WebKit overflow to the logical ruler + track height", () => {
    expect(boundedTimelineScrollTop(4000, 600, 934)).toBe(334);
  });

  it("pins short timelines and negative rubber-band offsets to zero", () => {
    expect(boundedTimelineScrollTop(250, 600, 500)).toBe(0);
    expect(boundedTimelineScrollTop(-80, 600, 900)).toBe(0);
  });

  it("leaves valid scrolling untouched", () => {
    expect(boundedTimelineScrollTop(180, 600, 1200)).toBe(180);
  });
});
