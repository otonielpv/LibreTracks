import { describe, expect, it } from "vitest";

import type { SongView } from "@libretracks/shared/models";

import { activeSongTrackIds, hasStripMappings, midiStripOrder } from "./midiBankStore";

const track = (
  id: string,
  extra: { kind?: string; parentTrackId?: string; collapsed?: boolean } = {},
) => ({ id, kind: "audio", parentTrackId: null, ...extra });

describe("midiBankStore", () => {
  it("orders strips like the mixer, skipping video and folded children", () => {
    const song = {
      tracks: [
        track("drums", { kind: "folder", collapsed: true }),
        track("kick", { parentTrackId: "drums" }),
        track("bass"),
        track("vid", { kind: "video" }),
        track("keys", { kind: "folder" }),
        track("pad", { parentTrackId: "keys" }),
        track("click", { kind: "midi" }),
      ],
    } as unknown as SongView;
    expect(midiStripOrder(song)).toEqual(["drums", "bass", "keys", "pad", "click"]);
    expect(midiStripOrder(null)).toEqual([]);
  });

  it("is active only with a strip binding", () => {
    expect(hasStripMappings({ "action:play": {} })).toBe(false);
    expect(hasStripMappings({ "strip:1:volume": {} })).toBe(true);
  });
});

describe("strips follow the active song", () => {
  const song = {
    regions: [
      { id: "r1", startSeconds: 0, endSeconds: 100 },
      { id: "r2", startSeconds: 100, endSeconds: 200 },
      { id: "r3", startSeconds: 200, endSeconds: 300 },
    ],
    tracks: [
      { id: "s1-drums", kind: "folder", parentTrackId: null },
      { id: "s1-kick", kind: "audio", parentTrackId: "s1-drums" },
      { id: "s1-bass", kind: "audio", parentTrackId: null },
      { id: "s2-bass", kind: "audio", parentTrackId: null },
      { id: "s2-keys", kind: "midi", parentTrackId: null },
    ],
    clips: [
      { trackId: "s1-kick", timelineStartSeconds: 0 },
      { trackId: "s1-bass", timelineStartSeconds: 10 },
      { trackId: "s2-bass", timelineStartSeconds: 100 },
    ],
    midiClips: [{ trackId: "s2-keys", timelineStartSeconds: 150 }],
  } as unknown as SongView;

  it("keeps only the playing song's tracks and the folders that hold them", () => {
    const first = activeSongTrackIds(song, "r1");
    expect(midiStripOrder(song, first)).toEqual(["s1-drums", "s1-kick", "s1-bass"]);
    expect(midiStripOrder(song, activeSongTrackIds(song, "r2"))).toEqual(["s2-bass", "s2-keys"]);
  });

  it("falls back to every track between songs or in an empty song", () => {
    expect(activeSongTrackIds(song, null)).toBeNull();
    expect(activeSongTrackIds(song, "r3")).toBeNull();
    expect(midiStripOrder(song, null)).toHaveLength(5);
  });
});
