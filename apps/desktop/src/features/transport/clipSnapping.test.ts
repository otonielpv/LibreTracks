import { describe, expect, it } from "vitest";

import {
  buildClipSnapAnchors,
  findSnappedGroupDelta,
} from "./clipSnapping";
import type { SongView } from "./desktopApi";
import type { ClipDragMember, ClipSnapAnchor } from "./types";

function makeSong(overrides: Partial<SongView> = {}): SongView {
  return {
    id: "song-1",
    title: "Test Song",
    artist: null,
    key: null,
    bpm: 120,
    timeSignature: "4/4",
    durationSeconds: 300,
    tempoMarkers: [],
    timeSignatureMarkers: [],
    regions: [],
    sectionMarkers: [],
    clips: [],
    tracks: [],
    waveforms: [],
    projectRevision: 1,
    ...overrides,
  };
}

describe("buildClipSnapAnchors", () => {
  it("includes the playhead, section markers, region edges and other clip edges", () => {
    const song = makeSong({
      sectionMarkers: [
        { id: "intro", name: "Intro", startSeconds: 0 },
        { id: "verse", name: "Verse", startSeconds: 24 },
      ],
      regions: [
        {
          id: "region-1",
          name: "Song A",
          startSeconds: 10,
          endSeconds: 50,
          transposeSemitones: 0,
          warpEnabled: false,
          warpSourceBpm: null,
        },
      ],
      clips: [
        {
          id: "clip-a",
          trackId: "track-1",
          trackName: "Drums",
          filePath: "",
          waveformKey: "",
          isMissing: false,
          timelineStartSeconds: 100,
          sourceStartSeconds: 0,
          sourceDurationSeconds: 30,
          sourceWindowDurationSeconds: 30,
          durationSeconds: 30,
          gain: 1,
        },
        {
          id: "clip-b",
          trackId: "track-2",
          trackName: "Bass",
          filePath: "",
          waveformKey: "",
          isMissing: false,
          timelineStartSeconds: 60,
          sourceStartSeconds: 0,
          sourceDurationSeconds: 40,
          sourceWindowDurationSeconds: 40,
          durationSeconds: 40,
          gain: 1,
        },
      ],
    });

    const draggedMembers: ClipDragMember[] = [
      { clipId: "clip-a", originSeconds: 100, previewSeconds: 100 },
    ];

    const anchors = buildClipSnapAnchors(song, draggedMembers, 42);
    const seconds = anchors
      .map((anchor) => anchor.seconds)
      .sort((a, b) => a - b);

    // Expected: playhead(42), section markers(0, 24), region edges(10, 50),
    // and the NON-dragged clip's edges (60 and 100). The dragged clip's
    // own edges (100, 130) must NOT appear.
    expect(seconds).toEqual([0, 10, 24, 42, 50, 60, 100]);
  });

  it("skips a negative playhead position", () => {
    const song = makeSong();
    const anchors = buildClipSnapAnchors(song, [], -1);
    expect(anchors.find((a) => a.kind === "playhead")).toBeUndefined();
  });
});

describe("findSnappedGroupDelta", () => {
  const member: ClipDragMember = {
    clipId: "clip-a",
    originSeconds: 10,
    previewSeconds: 10,
  };

  it("returns the proposed delta when no anchor is within range", () => {
    const anchors: ClipSnapAnchor[] = [
      { seconds: 50, kind: "playhead" },
    ];
    const result = findSnappedGroupDelta([member], 5, anchors, 0.5, {
      "clip-a": 4,
    });
    expect(result.activeAnchor).toBeNull();
    expect(result.groupDelta).toBe(5);
  });

  it("snaps the leading edge to a nearby anchor", () => {
    // Member starts at 10. Proposed delta 11.7 → start would be at 21.7.
    // Playhead anchor at 22 is within radius 0.5 → snap so start = 22.
    const anchors: ClipSnapAnchor[] = [
      { seconds: 22, kind: "playhead" },
    ];
    const result = findSnappedGroupDelta([member], 11.7, anchors, 0.5, {
      "clip-a": 4,
    });
    expect(result.activeAnchor?.kind).toBe("playhead");
    expect(result.groupDelta).toBeCloseTo(12, 5);
  });

  it("snaps the trailing edge when it is closer than the leading edge", () => {
    // Member at start=10, duration=4 → end=14. Proposed delta 7.9 → start 17.9,
    // end 21.9. Anchor at 22 is 0.1 from the end and 4.1 from the start →
    // snap by trailing edge: delta = 22 - 10 - 4 = 8.
    const anchors: ClipSnapAnchor[] = [
      { seconds: 22, kind: "section" },
    ];
    const result = findSnappedGroupDelta([member], 7.9, anchors, 0.5, {
      "clip-a": 4,
    });
    expect(result.activeAnchor?.kind).toBe("section");
    expect(result.groupDelta).toBeCloseTo(8, 5);
  });

  it("considers every group member when picking the closest anchor", () => {
    // Two members: clip-a at origin 10, clip-b at origin 30. Proposed delta 5
    // → clip-a starts at 15, clip-b at 35. Anchor at 35.1 captures clip-b's
    // leading edge (distance 0.1) and shifts the whole group by delta = 5.1
    // so clip-b's start lands at 35.1.
    const members: ClipDragMember[] = [
      member,
      { clipId: "clip-b", originSeconds: 30, previewSeconds: 30 },
    ];
    const anchors: ClipSnapAnchor[] = [
      { seconds: 35.1, kind: "clip-start" },
    ];
    const result = findSnappedGroupDelta(members, 5, anchors, 0.5, {
      "clip-a": 4,
      "clip-b": 6,
    });
    expect(result.activeAnchor?.kind).toBe("clip-start");
    expect(result.groupDelta).toBeCloseTo(5.1, 5);
  });

  it("preserves the proposed delta when the anchor list is empty", () => {
    const result = findSnappedGroupDelta([member], 3.21, [], 0.5, {
      "clip-a": 4,
    });
    expect(result.activeAnchor).toBeNull();
    expect(result.groupDelta).toBe(3.21);
  });
});
