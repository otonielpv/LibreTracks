import { describe, expect, it } from "vitest";

import type { TransportSnapshot } from "@libretracks/shared/models";
import {
  advanceRemoteClock,
  idleRemoteAnchor,
  reanchorRemoteClock,
  resolveLivePosition,
} from "./remoteClock";

function snapshot(overrides: Partial<TransportSnapshot> = {}): TransportSnapshot {
  return {
    playbackState: "playing",
    positionSeconds: 10,
    projectRevision: 1,
    transportClock: {
      anchorPositionSeconds: 10,
      running: true,
      playbackRate: 1,
      lastSeekPositionSeconds: 0,
      lastJumpPositionSeconds: null,
    },
    ...overrides,
  } as TransportSnapshot;
}

describe("reanchorRemoteClock", () => {
  it("parks at zero with nothing loaded", () => {
    const anchor = reanchorRemoteClock(null, 1_000);
    expect(anchor.running).toBe(false);
    expect(resolveLivePosition(anchor, 9_999)).toBe(0);
  });

  it("carries the engine playback rate so warped regions run at the right speed", () => {
    // The bug in the copies this replaced: `playbackRate` was read but two of
    // the four extrapolators dropped it. Under warp the remote playhead then
    // ran at wall-clock speed while the audio ran warped.
    const anchor = reanchorRemoteClock(
      snapshot({
        transportClock: {
          anchorPositionSeconds: 10,
          running: true,
          playbackRate: 0.5,
          lastSeekPositionSeconds: 0,
          lastJumpPositionSeconds: null,
        },
      }),
      1_000,
    );

    expect(anchor.playbackRate).toBe(0.5);
    // One real second later the timeline has only advanced half a second.
    expect(resolveLivePosition(anchor, 2_000)).toBeCloseTo(10.5, 6);
  });

  it("keeps advancing from positionSeconds when the native clock is stale", () => {
    // Over a remote connection playbackState and the native clock can arrive in
    // different snapshots. Gating on the clock froze the timeline on phones.
    const anchor = reanchorRemoteClock(
      snapshot({
        positionSeconds: 42,
        transportClock: {
          anchorPositionSeconds: 0,
          running: false,
          playbackRate: 1,
          lastSeekPositionSeconds: 0,
          lastJumpPositionSeconds: null,
        },
      }),
      1_000,
    );

    expect(anchor.running).toBe(true);
    expect(resolveLivePosition(anchor, 2_000)).toBeCloseTo(43, 6);
  });

  it("holds still when the transport is not playing", () => {
    const anchor = reanchorRemoteClock(
      snapshot({ playbackState: "paused", positionSeconds: 7 }),
      1_000,
    );
    expect(resolveLivePosition(anchor, 60_000)).toBeCloseTo(7, 6);
  });
});

describe("advanceRemoteClock", () => {
  it("leaves a true extrapolation alone instead of re-anchoring every poll", () => {
    // This is the whole point of routing the remote through the shared resync:
    // a snapshot that merely confirms where the playhead already is must not
    // reset the anchor, or the playhead restarts its glide several times a
    // second (the twitch on a phone).
    const anchor = reanchorRemoteClock(snapshot(), 1_000);
    const next = advanceRemoteClock({
      anchor,
      previousSnapshot: snapshot(),
      // 250 ms later the engine agrees with the extrapolation.
      nextSnapshot: snapshot({ positionSeconds: 10.25 }),
      nowMs: 1_250,
    });

    expect(next).toBe(anchor);
  });

  it("eases a small drift out instead of stepping the playhead", () => {
    const anchor = reanchorRemoteClock(snapshot(), 1_000);
    // Engine is 150 ms behind where the remote drew: within the smooth window.
    const next = advanceRemoteClock({
      anchor,
      previousSnapshot: snapshot(),
      nextSnapshot: snapshot({ positionSeconds: 10.1 }),
      nowMs: 1_250,
    });

    expect(next).not.toBe(anchor);
    expect(next.anchorPositionSeconds).toBeCloseTo(10.1, 6);
    // The correction absorbs the gap, so the DISPLAYED position is unchanged at
    // the instant of the correction — that is what makes the fix invisible.
    expect(next.correctionSeconds).toBeCloseTo(0.15, 6);
    expect(resolveLivePosition(next, 1_250)).toBeCloseTo(10.25, 6);
  });

  it("snaps back onto a stalled engine instead of free-running forever", () => {
    // The shape of a dead device / starved engine: the backend keeps reporting
    // the same position while the remote's wall-clock extrapolation runs away.
    // Half a second out is past the smooth window, so land on the truth.
    const anchor = reanchorRemoteClock(snapshot(), 1_000);
    expect(resolveLivePosition(anchor, 1_500)).toBeCloseTo(10.5, 6);

    const next = advanceRemoteClock({
      anchor,
      previousSnapshot: snapshot(),
      nextSnapshot: snapshot(),
      nowMs: 1_500,
    });

    expect(next.correctionSeconds).toBe(0);
    expect(resolveLivePosition(next, 1_500)).toBeCloseTo(10, 6);
  });

  it("re-anchors hard on a seek", () => {
    const anchor = reanchorRemoteClock(snapshot(), 1_000);
    const seeked = snapshot({
      positionSeconds: 30,
      transportClock: {
        anchorPositionSeconds: 30,
        running: true,
        playbackRate: 1,
        lastSeekPositionSeconds: 30,
        lastJumpPositionSeconds: null,
      },
    });

    const next = advanceRemoteClock({
      anchor,
      previousSnapshot: snapshot(),
      nextSnapshot: seeked,
      nowMs: 1_250,
    });

    expect(next.correctionSeconds).toBe(0);
    expect(resolveLivePosition(next, 1_250)).toBeCloseTo(30, 6);
  });

  it("re-anchors from an idle clock on the first snapshot", () => {
    const next = advanceRemoteClock({
      anchor: idleRemoteAnchor(0),
      previousSnapshot: null,
      nextSnapshot: snapshot(),
      nowMs: 1_000,
    });

    expect(next.running).toBe(true);
    expect(resolveLivePosition(next, 2_000)).toBeCloseTo(11, 6);
  });
});
