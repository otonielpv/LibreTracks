import { describe, expect, it } from "vitest";

import type { NetworkGuestTransport } from "@libretracks/shared/networkApi";
import type { SongView, TransportSnapshot } from "@libretracks/shared/models";

import { guestPositionAt, regionAt } from "./guestPlayhead";

function transport(
  playbackState: string,
  running: boolean,
  rate = 1,
): NetworkGuestTransport {
  return {
    snapshot: {
      playbackState,
      positionSeconds: 3,
      transportClock: { anchorPositionSeconds: 3, playbackRate: rate, running },
    } as unknown as TransportSnapshot,
    anchorPositionSeconds: 12,
    emittedAtUnixMs: 1_000_000,
  };
}

describe("guestPositionAt", () => {
  it("advances with the clock while the host plays", () => {
    expect(guestPositionAt(transport("playing", true), 1_000_500)).toBeCloseTo(12.5);
  });

  it("follows the host's playback rate", () => {
    expect(guestPositionAt(transport("playing", true, 0.5), 1_002_000)).toBeCloseTo(13);
  });

  it("stays put while paused or stopped", () => {
    expect(guestPositionAt(transport("paused", false), 1_009_000)).toBe(12);
    expect(guestPositionAt(transport("playing", false), 1_009_000)).toBe(12);
  });

  it("jumps when a new snapshot arrives (seek or jump on the host)", () => {
    const jumped = { ...transport("playing", true), anchorPositionSeconds: 90, emittedAtUnixMs: 1_001_000 };
    expect(guestPositionAt(jumped, 1_001_000)).toBe(90);
  });

  it("never goes back past the anchor if the clocks disagree", () => {
    expect(guestPositionAt(transport("playing", true), 999_000)).toBe(12);
  });

  it("is zero with nothing from the host yet", () => {
    expect(guestPositionAt(null, 5)).toBe(0);
  });
});

describe("regionAt", () => {
  const song = {
    regions: [
      { id: "b", startSeconds: 40, endSeconds: 80 },
      { id: "a", startSeconds: 0, endSeconds: 40 },
    ],
  } as unknown as SongView;

  it("finds the song playing at a position", () => {
    expect(regionAt(song, 10)?.id).toBe("a");
    expect(regionAt(song, 40)?.id).toBe("b");
  });

  it("falls back to the first song outside every region", () => {
    expect(regionAt(song, 500)?.id).toBe("a");
    expect(regionAt(null, 0)).toBeNull();
  });
});
