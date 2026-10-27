import { describe, expect, it } from "vitest";

import type { ClipSummary, SongView } from "@libretracks/shared/models";

import { CLIP_SNAP_RADIUS_PX } from "../../constants";
import { buildClipSnapAnchors, findSnappedGroupDelta } from "../../timeline/clipSnapping";
import type { ClipDragMember } from "../../types";
import {
  MIN_CLIP_WINDOW_SECONDS,
  clampGroupToSong,
  resolveClipDrag,
  resolveClipTrim,
} from "./laneGestures";

const clip = (id: string, timelineStartSeconds: number, durationSeconds = 10, extra: Partial<ClipSummary> = {}) =>
  ({
    id,
    trackId: "t",
    trackName: "t",
    filePath: `${id}.wav`,
    waveformKey: id,
    isMissing: false,
    timelineStartSeconds,
    sourceStartSeconds: 0,
    sourceWindowDurationSeconds: durationSeconds,
    sourceDurationSeconds: 60,
    durationSeconds,
    gain: 1,
    ...extra,
  }) as ClipSummary;

// 120 BPM 4/4 → 0.5 s per beat, 2 s per bar.
const region = { id: "r", name: "r", startSeconds: 0, endSeconds: 100 };
const song = {
  bpm: 120,
  timeSignature: "4/4",
  tempoMarkers: [],
  timeSignatureMarkers: [],
  regions: [region],
  sectionMarkers: [{ id: "m", name: "Coro", startSeconds: 31 }],
  clips: [clip("a", 10), clip("b", 20), clip("other", 50)],
} as unknown as SongView;

const member = (clipId: string, originSeconds: number): ClipDragMember => ({
  clipId,
  originSeconds,
  previewSeconds: originSeconds,
  originTrackId: "t",
});

const base = {
  song,
  region,
  primaryClipId: "a",
  pxPerSecond: 10,
  anchors: [],
};

describe("resolveClipDrag", () => {
  it("no snapping: the raw delta", () => {
    const result = resolveClipDrag({
      ...base,
      members: [member("a", 10)],
      rawDeltaSeconds: 3.3,
      snapEnabled: false,
      magnet: false,
    });
    expect(result.groupDelta).toBeCloseTo(3.3, 9);
  });

  it("grid: at 10 px/s the beat (5 px) is hidden, so the primary snaps to the bar", () => {
    const result = resolveClipDrag({
      ...base,
      members: [member("a", 10), member("b", 20)],
      rawDeltaSeconds: 3.3,
      snapEnabled: true,
      magnet: false,
    });
    // 13.3 s → bar at 14 s: +4 s, and b keeps its spacing.
    expect(result.groupDelta).toBeCloseTo(4, 9);
  });

  it("grid: zoomed in, the primary snaps to the beat", () => {
    const result = resolveClipDrag({
      ...base,
      pxPerSecond: 200,
      members: [member("a", 10)],
      rawDeltaSeconds: 0.7,
      snapEnabled: true,
      magnet: false,
    });
    expect(result.groupDelta).toBeCloseTo(0.5, 9);
  });

  it("magnet: the same delta the DAW's findSnappedGroupDelta gives", () => {
    const members = [member("a", 10), member("b", 20)];
    const anchors = buildClipSnapAnchors(song, members, 0);
    const result = resolveClipDrag({
      ...base,
      members,
      rawDeltaSeconds: 20.6,
      snapEnabled: true,
      magnet: true,
      anchors,
    });
    const daw = findSnappedGroupDelta(members, 20.6, anchors, CLIP_SNAP_RADIUS_PX / 10, { a: 10, b: 10 });
    expect(result.groupDelta).toBe(daw.groupDelta);
    // a's end (20+10.6…) magnets onto the section at 31 s.
    expect(result.groupDelta).toBeCloseTo(21, 9);
    expect(result.activeAnchor?.kind).toBe("section");
  });

  it("the group stays inside the song and never before 0", () => {
    expect(
      resolveClipDrag({ ...base, members: [member("a", 10), member("b", 20)], rawDeltaSeconds: -50, snapEnabled: false, magnet: false })
        .groupDelta,
    ).toBe(-10);
    const late = resolveClipDrag({ ...base, members: [member("a", 10), member("b", 20)], rawDeltaSeconds: 500, snapEnabled: false, magnet: false });
    expect(20 + late.groupDelta).toBeLessThan(100);
    expect(clampGroupToSong([member("x", 5)], -20, { startSeconds: -10, endSeconds: 50 })).toBe(-5);
  });
});

describe("resolveClipTrim", () => {
  const trimmed = clip("t", 10, 10, { sourceStartSeconds: 4, sourceDurationSeconds: 20 });

  it("start edge: timeline and source start move together", () => {
    expect(resolveClipTrim(trimmed, "start", 2, region)).toEqual({
      timelineStartSeconds: 12,
      sourceStartSeconds: 6,
      durationSeconds: 8,
    });
  });

  it("start edge: not before the file's start nor the song's", () => {
    expect(resolveClipTrim(trimmed, "start", -9, region).sourceStartSeconds).toBe(0);
    const early = clip("e", 2, 10, { sourceStartSeconds: 10, sourceDurationSeconds: 30 });
    expect(resolveClipTrim(early, "start", -9, { startSeconds: 0, endSeconds: 100 }).timelineStartSeconds).toBe(0);
  });

  it("never below the backend's minimum window", () => {
    expect(resolveClipTrim(trimmed, "start", 50, region).durationSeconds).toBeCloseTo(MIN_CLIP_WINDOW_SECONDS, 9);
    expect(resolveClipTrim(trimmed, "end", -50, region).durationSeconds).toBe(MIN_CLIP_WINDOW_SECONDS);
  });

  it("end edge: not past the file's end nor the song's", () => {
    expect(resolveClipTrim(trimmed, "end", 50, region).durationSeconds).toBe(16);
    expect(resolveClipTrim(trimmed, "end", 50, { startSeconds: 0, endSeconds: 15 }).durationSeconds).toBe(5);
  });
});
