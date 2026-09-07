import { describe, expect, it } from "vitest";
import type { ClipSummary, TrackSummary } from "../desktopApi";
import { canParentTrack, clipPlacements, requireSeconds } from "./preparationModel";

describe("mobile preparation operations", () => {
  it("preserves alignment and offsets when moving a group in one batch", () => {
    const clips = [{ id: "a", timelineStartSeconds: 12 }, { id: "b", timelineStartSeconds: 10 }] as ClipSummary[];
    expect(clipPlacements(clips, 30)).toEqual([{ clipId: "a", timelineStartSeconds: 32 }, { clipId: "b", timelineStartSeconds: 30 }]);
    expect(clipPlacements(clips, 0, "track")[0]).toEqual({ clipId: "a", timelineStartSeconds: 2, targetTrackId: "track" });
  });
  it("rejects invalid positions instead of silently moving clips to zero", () => {
    for (const value of ["", " ", "NaN", "Infinity", "-1"]) expect(() => requireSeconds(value)).toThrow();
    expect(requireSeconds("12.345")).toBe(12.345);
    expect(() => clipPlacements([], 0)).toThrow();
  });
  it("does not let a folder move into itself or its descendants", () => {
    const tracks = [{ id: "parent", kind: "folder" }, { id: "child", kind: "folder", parentTrackId: "parent" }, { id: "audio", kind: "audio" }] as TrackSummary[];
    expect(canParentTrack(tracks, "parent", "child")).toBe(false);
    expect(canParentTrack(tracks, "parent", "parent")).toBe(false);
    expect(canParentTrack(tracks, "audio", "child")).toBe(true);
    expect(canParentTrack(tracks, "parent", "audio")).toBe(false);
    expect(canParentTrack(tracks, "child", "")).toBe(true);
  });
});
