import { describe, expect, it } from "vitest";

import type {
  ClipSummary,
  SongRegionSummary,
  SongView,
  TrackSummary,
} from "@libretracks/shared/models";

import {
  activeRegion,
  bpmForRegion,
  clipDisplayName,
  clipsForRegion,
  formatBpm,
  keyForRegion,
} from "./songWidgets";

function track(id: string, name: string, color: string | null = null): TrackSummary {
  return {
    id,
    name,
    kind: "audio",
    depth: 0,
    hasChildren: false,
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
    color,
  } as TrackSummary;
}

function clip(
  overrides: Pick<ClipSummary, "id" | "trackId" | "filePath" | "timelineStartSeconds"> &
    Partial<ClipSummary>,
): ClipSummary {
  return {
    trackName: "",
    waveformKey: "",
    isMissing: false,
    sourceStartSeconds: 0,
    sourceWindowDurationSeconds: 1,
    sourceDurationSeconds: 1,
    durationSeconds: 1,
    gain: 1,
    color: null,
    ...overrides,
  } as ClipSummary;
}

function region(
  overrides: Pick<SongRegionSummary, "id" | "startSeconds" | "endSeconds"> &
    Partial<SongRegionSummary>,
): SongRegionSummary {
  return {
    name: overrides.id,
    transposeSemitones: 0,
    key: null,
    warpEnabled: false,
    warpSourceBpm: null,
    master: { gain: 1 },
    ...overrides,
  };
}

function makeSong(): SongView {
  return {
    id: "s",
    title: "Set",
    bpm: 120,
    timeSignature: "4/4",
    durationSeconds: 40,
    tempoMarkers: [{ id: "t", startSeconds: 20, bpm: 90 }],
    timeSignatureMarkers: [],
    regions: [
      region({ id: "A", name: "Song A", startSeconds: 0, endSeconds: 20, key: "C" }),
      region({ id: "B", name: "Song B", startSeconds: 20, endSeconds: 40 }),
    ],
    sectionMarkers: [],
    // Track order: drums(0), bass(1). Clip on bass placed before the drums clip
    // in the array, to prove we sort by track index, not array order.
    tracks: [track("drums", "Drums", "#ff0000"), track("bass", "Bass")],
    clips: [
      clip({ id: "c-bass", trackId: "bass", filePath: "C:\\audio\\bassline.wav", timelineStartSeconds: 2 }),
      clip({ id: "c-drums", trackId: "drums", filePath: "/audio/beat.mp3", timelineStartSeconds: 1 }),
      clip({ id: "c-b2", trackId: "drums", filePath: "kick.flac", timelineStartSeconds: 25 }),
    ],
    projectRevision: 1,
  };
}

describe("clipDisplayName", () => {
  it("strips path and extension", () => {
    expect(clipDisplayName("C:\\audio\\bassline.wav")).toBe("bassline");
    expect(clipDisplayName("/audio/beat.mp3")).toBe("beat");
    expect(clipDisplayName("kick.flac")).toBe("kick");
  });

  it("keeps a name with no extension", () => {
    expect(clipDisplayName("loop")).toBe("loop");
  });
});

describe("clipsForRegion", () => {
  it("returns clips inside the region, ordered by track index", () => {
    const song = makeSong();
    const entries = clipsForRegion(song, song.regions[0]);
    // Only region A's clips (start < 20): drums@1 and bass@2. Drums track has
    // index 0 so it sorts first despite appearing later in the clips array.
    expect(entries.map((e) => e.id)).toEqual(["c-drums", "c-bass"]);
  });

  it("enriches with clip name, track name and colour", () => {
    const song = makeSong();
    const [drums, bass] = clipsForRegion(song, song.regions[0]);
    expect(drums.clipName).toBe("beat");
    expect(drums.trackName).toBe("Drums");
    expect(drums.trackColor).toBe("#ff0000");
    expect(bass.trackColor).toBeNull();
  });

  it("excludes clips outside the region span", () => {
    const song = makeSong();
    const entries = clipsForRegion(song, song.regions[1]);
    expect(entries.map((e) => e.id)).toEqual(["c-b2"]);
  });

  it("returns [] for a null song view", () => {
    expect(clipsForRegion(null, region({ id: "A", startSeconds: 0, endSeconds: 1 }))).toEqual([]);
  });
});

describe("bpm / key / active", () => {
  it("bpmForRegion honours the tempo map at the region start", () => {
    const song = makeSong();
    expect(bpmForRegion(song, song.regions[0])).toBe(120);
    // Region B starts at 20, where a tempo marker sets 90 BPM.
    expect(bpmForRegion(song, song.regions[1])).toBe(90);
  });

  it("formatBpm shows integers without decimals", () => {
    expect(formatBpm(120)).toBe("120");
    expect(formatBpm(128.5)).toBe("128.50");
  });

  it("keyForRegion applies transpose", () => {
    const c = region({ id: "A", startSeconds: 0, endSeconds: 4, key: "C", transposeSemitones: 2 });
    expect(keyForRegion(c)).toBe("D");
    expect(keyForRegion(region({ id: "B", startSeconds: 0, endSeconds: 4 }))).toBeNull();
  });

  it("activeRegion picks the region under the playhead", () => {
    const song = makeSong();
    expect(activeRegion(song, 5)?.id).toBe("A");
    expect(activeRegion(song, 30)?.id).toBe("B");
    expect(activeRegion(song, 100)).toBeNull();
  });
});
