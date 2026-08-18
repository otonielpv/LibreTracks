import { describe, expect, it } from "vitest";

import type {
  SectionMarkerSummary,
  SongRegionSummary,
} from "@libretracks/shared/models";
import {
  buildLiveMarkerGroups,
  liveMarkerGroupsForRegion,
  resolveLivePlaybackPosition,
} from "./liveMarkerModel";

const marker = (
  id: string,
  name: string,
  startSeconds: number,
  kind: SectionMarkerSummary["kind"] = "verse",
): SectionMarkerSummary => ({ id, name, startSeconds, kind });

const region = (
  id: string,
  name: string,
  startSeconds: number,
  endSeconds: number,
): SongRegionSummary => ({
  id,
  name,
  startSeconds,
  endSeconds,
  transposeSemitones: 0,
  key: null,
  warpEnabled: false,
  warpSourceBpm: null,
  master: { gain: 1 },
  compactColumnWidthRem: null,
});

describe("buildLiveMarkerGroups", () => {
  it("shows a section and coincident warnings in one timeline position", () => {
    const groups = buildLiveMarkerGroups([
      marker("cue-2", "Todos dentro", 20.019, "all_in"),
      marker("section", "Estribillo", 20),
      marker("cue-1", "Preparados", 19.99, "get_ready"),
      marker("lone-cue", "Bajar", 35, "ease_down"),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      id: "section",
      category: "section",
      startSeconds: 20,
    });
    expect(groups[0].cues.map((cue) => cue.id)).toEqual(["cue-1", "cue-2"]);
    expect(groups[1]).toMatchObject({ id: "lone-cue", category: "cue" });
  });

  it("respects an explicit cue-lane category override", () => {
    const groups = buildLiveMarkerGroups([
      { ...marker("custom", "Aviso manual", 12, "custom"), categoryOverride: "cue" },
    ]);

    expect(groups[0].category).toBe("cue");
  });
});

describe("resolveLivePlaybackPosition", () => {
  const groups = buildLiveMarkerGroups([
    marker("intro", "Intro", 0, "intro"),
    marker("verse", "Estrofa", 10),
    marker("chorus", "Estribillo", 30, "chorus"),
  ]);
  const regions = [
    region("song-1", "Cancion 1", 0, 40),
    region("song-2", "Cancion 2", 40, 80),
  ];

  it("moves active/next markers and calculates bounded progress", () => {
    expect(resolveLivePlaybackPosition(groups, regions, 20)).toMatchObject({
      activeGroupId: "verse",
      nextGroupId: "chorus",
      currentRegionId: "song-1",
      nextRegionId: "song-2",
      secondsToNextGroup: 10,
      progressPercent: 50,
    });
  });

  it("points at the first upcoming marker before playback reaches it", () => {
    const futureGroups = buildLiveMarkerGroups([marker("first", "Intro", 5)]);
    expect(resolveLivePlaybackPosition(futureGroups, regions, 0)).toMatchObject({
      activeGroupId: null,
      nextGroupId: "first",
      secondsToNextGroup: 5,
      progressPercent: 0,
    });
  });
});

describe("liveMarkerGroupsForRegion", () => {
  it("keeps only the selected song and assigns boundary markers to the next song", () => {
    const groups = buildLiveMarkerGroups([
      marker("first", "Primera", 10),
      marker("boundary", "Segunda", 40),
      marker("later", "Final", 55),
    ]);

    expect(
      liveMarkerGroupsForRegion(groups, region("song-1", "Cancion 1", 0, 40))
        .map((group) => group.id),
    ).toEqual(["first"]);
    expect(
      liveMarkerGroupsForRegion(groups, region("song-2", "Cancion 2", 40, 80))
        .map((group) => group.id),
    ).toEqual(["boundary", "later"]);
  });
});
