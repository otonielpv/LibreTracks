import { describe, expect, it } from "vitest";

import type { SongView } from "@libretracks/shared/models";

import {
  defaultTrackIdAt,
  groupTracksBySong,
  trackDisplayName,
} from "./trackSongGroups";

// Dos canciones con su propia «Drums», un click que suena en las dos, una
// pista sin clips y una carpeta.
function session(): SongView {
  return {
    regions: [
      { id: "b", name: "Way Maker", startSeconds: 100, endSeconds: 200 },
      { id: "a", name: "Oceans", startSeconds: 0, endSeconds: 100 },
    ],
    tracks: [
      { id: "folder", name: "Oceans", kind: "folder" },
      { id: "drums-a", name: "Drums", kind: "audio" },
      { id: "drums-b", name: "Drums", kind: "audio" },
      { id: "click", name: "Click", kind: "audio" },
      { id: "empty", name: "Spare", kind: "audio" },
    ],
    clips: [
      { trackId: "drums-a", timelineStartSeconds: 0, durationSeconds: 90 },
      { trackId: "drums-b", timelineStartSeconds: 100, durationSeconds: 90 },
      { trackId: "click", timelineStartSeconds: 0, durationSeconds: 200 },
    ],
    midiClips: [],
  } as unknown as SongView;
}

const ids = (song: SongView) =>
  groupTracksBySong(song).map((group) => ({
    song: group.region?.name ?? null,
    tracks: group.tracks.map((track) => track.id),
  }));

describe("groupTracksBySong", () => {
  it("puts each track under the songs it sounds in, in timeline order", () => {
    expect(ids(session())).toEqual([
      { song: "Oceans", tracks: ["drums-a", "click"] },
      { song: "Way Maker", tracks: ["drums-b", "click"] },
      { song: null, tracks: ["empty"] },
    ]);
  });

  it("leaves folders out", () => {
    const all = groupTracksBySong(session()).flatMap((group) => group.tracks);
    expect(all.some((track) => track.id === "folder")).toBe(false);
  });

  it("does not count a clip that only touches the song's end", () => {
    const song = session();
    song.clips.push({
      trackId: "empty",
      timelineStartSeconds: 200,
      durationSeconds: 10,
    } as SongView["clips"][number]);
    expect(ids(song).at(-1)).toEqual({ song: null, tracks: ["empty"] });
  });

  it("places MIDI clips by their start", () => {
    const song = session();
    song.midiClips = [
      { trackId: "empty", timelineStartSeconds: 150 } as NonNullable<SongView["midiClips"]>[number],
    ];
    expect(ids(song)[1]).toEqual({
      song: "Way Maker",
      tracks: ["drums-b", "click", "empty"],
    });
  });
});

describe("defaultTrackIdAt", () => {
  it("picks the first track of the song under the cue", () => {
    expect(defaultTrackIdAt(session(), 150)).toBe("drums-b");
  });

  it("falls back to the session's first track outside any song", () => {
    expect(defaultTrackIdAt(session(), 500)).toBe("drums-a");
  });
});

describe("trackDisplayName", () => {
  it("adds the song when the name repeats in the session", () => {
    expect(trackDisplayName(session(), "drums-b")).toBe("Drums (Way Maker)");
  });

  it("keeps a unique name as is", () => {
    expect(trackDisplayName(session(), "click")).toBe("Click");
  });
});
