import { describe, expect, it } from "vitest";

import {
  clampGroupRowDelta,
  resolveMemberTargetTrackId,
} from "./clipVerticalDrag";
import type { TimelineTrackSummary } from "../library/pendingAudioImports";
import type { ClipDragMember } from "../types";

function track(
  id: string,
  kind: "audio" | "folder" = "audio",
  extra: Partial<TimelineTrackSummary> = {},
): TimelineTrackSummary {
  return {
    id,
    name: id,
    kind,
    parentTrackId: null,
    depth: 0,
    hasChildren: false,
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
    audioTo: "master",
    transposeEnabled: false,
    ...extra,
  } as TimelineTrackSummary;
}

function member(clipId: string, originTrackId: string): ClipDragMember {
  return { clipId, originSeconds: 0, previewSeconds: 0, originTrackId };
}

describe("clampGroupRowDelta", () => {
  const tracks = [track("a"), track("b"), track("c")];

  it("returns 0 when the desired delta is 0", () => {
    expect(clampGroupRowDelta([member("c1", "a")], 0, tracks)).toBe(0);
  });

  it("passes through a valid in-bounds delta", () => {
    expect(clampGroupRowDelta([member("c1", "a")], 2, tracks)).toBe(2);
  });

  it("clamps a delta that would overshoot the bottom", () => {
    // From track 'b' (index 1), +5 would be out of range; the last valid
    // delta lands on 'c' (index 2), i.e. +1.
    expect(clampGroupRowDelta([member("c1", "b")], 5, tracks)).toBe(1);
  });

  it("clamps a delta that would overshoot the top", () => {
    expect(clampGroupRowDelta([member("c1", "b")], -5, tracks)).toBe(-1);
  });

  it("stops before a folder lane", () => {
    const withFolder = [track("a"), track("folder", "folder"), track("c")];
    // From 'a' (0), moving +1 hits the folder → not allowed, so delta stays 0.
    expect(clampGroupRowDelta([member("c1", "a")], 1, withFolder)).toBe(0);
  });

  it("uses the most restrictive member in a multi-clip drag", () => {
    // Two members: one on 'a', one on 'b'. A +1 delta keeps both valid
    // (a→b, b→c). A +2 would push 'b' out of bounds, so +1 is the max.
    const members = [member("c1", "a"), member("c2", "b")];
    expect(clampGroupRowDelta(members, 2, tracks)).toBe(1);
  });

  it("returns 0 when a member's origin track is missing", () => {
    expect(clampGroupRowDelta([member("c1", "ghost")], 1, tracks)).toBe(0);
  });
});

describe("resolveMemberTargetTrackId", () => {
  const tracks = [track("a"), track("b"), track("c")];

  it("returns null for a zero delta", () => {
    expect(resolveMemberTargetTrackId(member("c1", "a"), 0, tracks)).toBeNull();
  });

  it("resolves the destination track for a valid delta", () => {
    expect(resolveMemberTargetTrackId(member("c1", "a"), 1, tracks)).toBe("b");
  });

  it("returns null when the target would be out of bounds", () => {
    expect(resolveMemberTargetTrackId(member("c1", "c"), 1, tracks)).toBeNull();
  });
});
