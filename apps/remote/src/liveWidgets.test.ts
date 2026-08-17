import { describe, expect, it } from "vitest";

import type {
  SectionMarkerSummary,
  SongRegionSummary,
  SongView,
} from "@libretracks/shared/models";

import { deriveLiveMusicalContext } from "./liveWidgets";

function region(
  overrides: Partial<SongRegionSummary> & Pick<SongRegionSummary, "id" | "startSeconds" | "endSeconds">,
): SongRegionSummary {
  return {
    name: overrides.id,
    transposeSemitones: 0,
    key: null,
    warpEnabled: false,
    warpSourceBpm: null,
    master: { gain: 1 },
    compactColumnWidthRem: null,
    ...overrides,
  };
}

function marker(
  overrides: Partial<SectionMarkerSummary> &
    Pick<SectionMarkerSummary, "id" | "startSeconds">,
): SectionMarkerSummary {
  return {
    name: overrides.id,
    kind: "verse",
    ...overrides,
  };
}

/**
 * Minimal song: 120 BPM 4/4 → one bar = 2s. Two songs back to back, each with
 * one section marker inside it, so we can assert next-marker / next-song /
 * bars-remaining deterministically.
 */
function makeSong(): SongView {
  return {
    id: "song",
    title: "Set",
    bpm: 120,
    timeSignature: "4/4",
    durationSeconds: 40,
    tempoMarkers: [],
    timeSignatureMarkers: [],
    regions: [
      region({ id: "A", name: "Song A", startSeconds: 0, endSeconds: 20, key: "C" }),
      region({ id: "B", name: "Song B", startSeconds: 20, endSeconds: 40, key: "G" }),
    ],
    sectionMarkers: [
      marker({ id: "chorus-a", name: "Chorus", startSeconds: 8, kind: "chorus" }),
      // A lone dynamic cue: its own point on the timeline, and its own card in
      // the jump grid, so it is a "next marker" like any section.
      marker({ id: "build", name: "Build", startSeconds: 12, kind: "build" }),
      marker({ id: "verse-b", name: "Verse", startSeconds: 24, kind: "verse" }),
    ],
    clips: [],
    tracks: [],
    projectRevision: 1,
  };
}

describe("deriveLiveMusicalContext", () => {
  it("reports the current region and its transposed key", () => {
    const song = makeSong();
    const context = deriveLiveMusicalContext(song, 4);
    expect(context.currentRegion?.id).toBe("A");
    expect(context.currentKey).toBe("C");
  });

  it("finds the next marker ahead of the playhead", () => {
    const song = makeSong();
    // At 4s the next point is the chorus at 8s.
    const context = deriveLiveMusicalContext(song, 4);
    expect(context.nextMarkerId).toBe("chorus-a");
    expect(context.nextMarkerName).toBe("Chorus");
    expect(context.secondsToMarker).toBeCloseTo(4, 5);
  });

  it("counts a lone cue as the next marker", () => {
    const song = makeSong();
    // At 10s the nearest point ahead is the Build cue at 12s. It has its own
    // card in the jump grid, so the widgets must count down to it rather than
    // skipping ahead to the next section.
    const context = deriveLiveMusicalContext(song, 10);
    expect(context.nextMarkerId).toBe("build");
    expect(context.nextMarkerName).toBe("Build");
    expect(context.secondsToMarker).toBeCloseTo(2, 5);
  });

  it("reports the section, not the cue, when the two share a position", () => {
    // A cue stacked on a section is drawn INSIDE that section's card, so the
    // section owns the point. Naming the cue would highlight a card that does
    // not exist and leave the grid unable to scroll to it.
    const song = makeSong();
    song.sectionMarkers = [
      marker({ id: "chorus-a", name: "Chorus", startSeconds: 8, kind: "chorus" }),
      marker({ id: "all-in", name: "All In", startSeconds: 8, kind: "build" }),
    ];
    const context = deriveLiveMusicalContext(song, 4);
    expect(context.nextMarkerId).toBe("chorus-a");
    expect(context.nextMarkerName).toBe("Chorus");
  });

  it("computes bars remaining to the next section using the tempo map", () => {
    const song = makeSong();
    // 4s → 8s is 4s = 2 bars at 120 BPM 4/4.
    const context = deriveLiveMusicalContext(song, 4);
    expect(context.barsToMarker).toBe(2);
  });

  it("reports the next region and time/bars until it starts", () => {
    const song = makeSong();
    const context = deriveLiveMusicalContext(song, 16);
    expect(context.nextRegion?.id).toBe("B");
    expect(context.secondsToSong).toBeCloseTo(4, 5);
    // 16s → 20s is 4s = 2 bars.
    expect(context.barsToSong).toBe(2);
  });

  it("returns nulls past the last marker and last region", () => {
    const song = makeSong();
    const context = deriveLiveMusicalContext(song, 30);
    expect(context.nextMarkerId).toBeNull();
    expect(context.nextMarkerName).toBeNull();
    expect(context.secondsToMarker).toBeNull();
    expect(context.nextRegion).toBeNull();
    expect(context.secondsToSong).toBeNull();
    expect(context.currentRegion?.id).toBe("B");
    expect(context.currentKey).toBe("G");
  });

  it("handles a null song view gracefully", () => {
    const context = deriveLiveMusicalContext(null, 5);
    expect(context.currentRegion).toBeNull();
    expect(context.nextMarkerName).toBeNull();
    expect(context.currentKey).toBeNull();
  });
});
