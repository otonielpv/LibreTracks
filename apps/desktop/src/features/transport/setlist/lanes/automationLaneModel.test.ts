import { describe, expect, it } from "vitest";
import type { AutomationCueSummary, SongView } from "@libretracks/shared/models";

import { automationRowIndex, resolveCueDrag, sectionAt, songAutomationCues } from "./automationLaneModel";

const cue = (id: string, atSeconds: number) =>
  ({ id, name: id, atSeconds, enabled: true, actions: [] }) as AutomationCueSummary;
const song = {
  bpm: 120,
  timeSignature: "4/4",
  tempoMarkers: [],
  timeSignatureMarkers: [],
  regions: [],
  sectionMarkers: [
    { id: "v", name: "Verso", kind: "verse", startSeconds: 8 },
    { id: "c", name: "Coro", kind: "chorus", startSeconds: 24 },
    { id: "a", name: "Todos", kind: "all_in", startSeconds: 30 },
    { id: "x", name: "Otra canción", kind: "verse", startSeconds: 120 },
  ],
  automationCues: [cue("late", 40), cue("other", 150), cue("early", 10)],
} as unknown as SongView;
const region = { startSeconds: 0, endSeconds: 100 };

describe("automation lane model", () => {
  it("the song's cues only, in time order", () => {
    expect(songAutomationCues(song, region).map((entry) => entry.id)).toEqual(["early", "late"]);
  });

  it("a moment falls in the last section starting at or before it (cues are not sections)", () => {
    expect(sectionAt(song, region, 5)).toBeNull();
    expect(sectionAt(song, region, 8)?.id).toBe("v");
    expect(sectionAt(song, region, 35)?.id).toBe("c");
    expect(sectionAt(song, region, 99)?.id).toBe("c");
  });

  it("a drag snaps to the visible grid and stays inside the song", () => {
    // 120 BPM 4/4 at 10 px/s: the grid is a beat (0.5 s) or coarser.
    const base = { song, region, pxPerSecond: 10, snapEnabled: true };
    const snapped = resolveCueDrag({ ...base, originSeconds: 10, rawDeltaSeconds: 2.3 });
    expect(snapped % 0.5).toBeCloseTo(0, 6);
    expect(resolveCueDrag({ ...base, snapEnabled: false, originSeconds: 10, rawDeltaSeconds: 2.3 })).toBeCloseTo(12.3);
    expect(resolveCueDrag({ ...base, originSeconds: 10, rawDeltaSeconds: -50 })).toBe(0);
    expect(resolveCueDrag({ ...base, snapEnabled: false, originSeconds: 90, rawDeltaSeconds: 50 })).toBeCloseTo(99.95);
  });

  it("the row sits after its track, after the closest one above when that has no audio here", () => {
    const project = ["a", "b", "c", "d"];
    expect(automationRowIndex(["a", "c", "d"], project, null)).toBe(0);
    expect(automationRowIndex(["a", "c", "d"], project, "c")).toBe(2);
    // «b» has no audio in this song: after «a».
    expect(automationRowIndex(["a", "c", "d"], project, "b")).toBe(1);
    // Nothing above it in this song: first.
    expect(automationRowIndex(["c", "d"], project, "b")).toBe(0);
    // Unknown track: last.
    expect(automationRowIndex(["a", "c"], project, "zz")).toBe(2);
  });
});
