import { describe, expect, it } from "vitest";

import type { MixSceneSummary, SongView } from "@libretracks/shared/models";

import {
  folderNames,
  ministerScene,
  moveId,
  parseWords,
  resolveSceneTrackIds,
} from "./sceneRules";

const track = (id: string, name: string, kind = "audio", parentTrackId: string | null = null) => ({
  id,
  name,
  kind,
  parentTrackId,
});

/** One song with voices, a folder, a video and a click; and a second song. */
const song = {
  regions: [
    { id: "r1", startSeconds: 0, endSeconds: 100 },
    { id: "r2", startSeconds: 100, endSeconds: 200 },
  ],
  tracks: [
    track("inst", "Instrumentos", "folder"),
    track("bajo", "Bajo", "audio", "inst"),
    track("piano", "Piano", "audio", "inst"),
    track("video", "Vídeo", "video", "inst"),
    track("voz1", "Voz 1"),
    track("coros", "BGVox"),
    track("guia", "Guía"),
    track("click", "Click"),
    track("bajo2", "Bajo"),
  ],
  clips: [
    { trackId: "bajo", timelineStartSeconds: 0 },
    { trackId: "piano", timelineStartSeconds: 0 },
    { trackId: "voz1", timelineStartSeconds: 0 },
    { trackId: "coros", timelineStartSeconds: 0 },
    { trackId: "guia", timelineStartSeconds: 0 },
    { trackId: "click", timelineStartSeconds: 0 },
    { trackId: "bajo2", timelineStartSeconds: 100 },
  ],
  videoClips: [{ trackId: "video", timelineStartSeconds: 0 }],
  midiClips: [],
} as unknown as SongView;

describe("scene rules preview", () => {
  it("the quick minister scene leaves voices, click, guide, folder and video out", () => {
    const scene = ministerScene("s", "Ministrar");
    expect(resolveSceneTrackIds(scene, song, "r1")).toEqual(["bajo", "piano"]);
    expect(resolveSceneTrackIds(scene, song, "r2")).toEqual(["bajo2"]);
    expect(resolveSceneTrackIds(scene, song, null)).toEqual([]);
  });

  it("a folder rule picks its audio children, not itself nor the video", () => {
    const scene: MixSceneSummary = {
      id: "s",
      name: "s",
      rampSeconds: 0,
      rules: [
        {
          select: { type: "folder", name: "instrumentos" },
          change: { muted: true },
        },
      ],
    };
    expect(resolveSceneTrackIds(scene, song, "r1")).toEqual(["bajo", "piano"]);
  });

  it("a track rule picks that track in any song, and empty changes pick nothing", () => {
    const scene: MixSceneSummary = {
      id: "s",
      name: "s",
      rampSeconds: 0,
      rules: [
        { select: { type: "track", trackId: "inst" }, change: { solo: true } },
        { select: { type: "activeSong" }, change: {} },
      ],
    };
    expect(resolveSceneTrackIds(scene, song, "r2")).toEqual(["inst"]);
  });

  it("parses words, lists folders once and moves ids", () => {
    expect(parseWords(" voz, ,vox ,")).toEqual(["voz", "vox"]);
    expect(folderNames(song)).toEqual(["Instrumentos"]);
    expect(moveId(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    const same = ["a"];
    expect(moveId(same, 0, 1)).toBe(same);
  });
});
