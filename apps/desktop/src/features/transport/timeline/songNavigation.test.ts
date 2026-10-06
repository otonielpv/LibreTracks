import { describe, expect, it } from "vitest";
import { findNextSongRegion, findPreviousSongRegion } from "./songNavigation";

// Three songs back to back, deliberately listed out of order.
const regions = [
  { id: "b", startSeconds: 100 },
  { id: "a", startSeconds: 0 },
  { id: "c", startSeconds: 250 },
];

describe("findPreviousSongRegion", () => {
  it("goes to the song before the one playing", () => {
    expect(findPreviousSongRegion(regions, 150)?.id).toBe("a");
    expect(findPreviousSongRegion(regions, 300)?.id).toBe("b");
  });

  it("treats the exact start of a song as being inside it", () => {
    expect(findPreviousSongRegion(regions, 100)?.id).toBe("a");
  });

  it("wraps from the first song to the last", () => {
    expect(findPreviousSongRegion(regions, 0)?.id).toBe("c");
    expect(findPreviousSongRegion(regions, 42)?.id).toBe("c");
  });

  it("returns null without songs", () => {
    expect(findPreviousSongRegion([], 10)).toBeNull();
  });
});

describe("findNextSongRegion", () => {
  it("goes to the first song that starts after the cursor", () => {
    expect(findNextSongRegion(regions, 0)?.id).toBe("b");
    expect(findNextSongRegion(regions, 150)?.id).toBe("c");
  });

  it("wraps from the last song to the first", () => {
    expect(findNextSongRegion(regions, 260)?.id).toBe("a");
  });

  it("returns null without songs", () => {
    expect(findNextSongRegion([], 10)).toBeNull();
  });
});
