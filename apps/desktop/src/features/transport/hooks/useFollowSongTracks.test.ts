import { describe, expect, it } from "vitest";

import type { SongView } from "@libretracks/shared/models";

import type { TimelineTrackSummary } from "../library/pendingAudioImports";
import { buildUniformRowLayout } from "../tracks/trackLayout";
import { songTracksScrollTop } from "./useFollowSongTracks";

const ROW = 80;

/** Three songs, one after another; song N has its clips on tracks sN-a/sN-b,
 * and song 3's tracks live in a folder. */
function session(): SongView {
  const tracks = [
    { id: "s1-a" }, { id: "s1-b" },
    { id: "s2-a" }, { id: "s2-b" },
    { id: "f3" }, { id: "s3-a", parentTrackId: "f3" }, { id: "s3-b", parentTrackId: "f3" },
  ];
  const clip = (trackId: string, start: number) => ({ trackId, timelineStartSeconds: start });
  return {
    tracks,
    regions: [
      { id: "song1", startSeconds: 0, endSeconds: 100 },
      { id: "song2", startSeconds: 100, endSeconds: 200 },
      { id: "song3", startSeconds: 200, endSeconds: 300 },
    ],
    clips: [clip("s1-a", 0), clip("s1-b", 0), clip("s2-a", 100), clip("s2-b", 120), clip("s3-a", 200), clip("s3-b", 200)],
    midiClips: [],
  } as unknown as SongView;
}

function rows(ids: string[]) {
  return ids.map((id) => ({ id }) as TimelineTrackSummary);
}

const all = ["s1-a", "s1-b", "s2-a", "s2-b", "f3", "s3-a", "s3-b"];

function target(activeRegionId: string | null, visible = all, extra: Partial<Parameters<typeof songTracksScrollTop>[0]> = {}) {
  return songTracksScrollTop({
    song: session(),
    activeRegionId,
    visibleTracks: rows(visible),
    layout: buildUniformRowLayout(visible, ROW),
    listOffset: 40,
    stickyHeight: 40,
    maxScrollTop: 10_000,
    ...extra,
  });
}

describe("songTracksScrollTop", () => {
  it("puts the song's first track right under the sticky header", () => {
    expect(target("song1")).toBe(0);
    expect(target("song2")).toBe(2 * ROW);
  });

  it("a song inside a folder scrolls to the folder, even collapsed", () => {
    expect(target("song3")).toBe(4 * ROW);
    expect(target("song3", ["s1-a", "s1-b", "s2-a", "s2-b", "f3"])).toBe(4 * ROW);
  });

  it("counts where the list starts inside the scrolled content", () => {
    expect(target("song2", all, { listOffset: 100, stickyHeight: 40 })).toBe(2 * ROW + 60);
  });

  it("stops at the bottom when the song's tracks are the last ones", () => {
    expect(target("song3", all, { maxScrollTop: 200 })).toBe(200);
  });

  it("does nothing between songs or for a song with no clips", () => {
    expect(target(null)).toBeNull();
    expect(target("missing")).toBeNull();
  });
});
