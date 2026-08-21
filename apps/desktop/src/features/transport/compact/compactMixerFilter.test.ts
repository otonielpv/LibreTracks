import { describe, expect, it } from "vitest";

import type { TrackSummary } from "../desktopApi";

import { computeActiveSongTrackIds, type CompactClipEntry } from "./CompactView";
import { resolveMixerRows, resolveVisibleTracks } from "./CompactMixer";

const clip = (id: string, trackId: string): CompactClipEntry => ({
  id,
  clipName: `${id}.wav`,
  trackId,
  trackName: trackId,
});

const track = (id: string, parentTrackId: string | null = null) =>
  ({
    id,
    name: id,
    kind: "audio",
    parentTrackId,
  }) as unknown as TrackSummary;

const folder = (id: string, parentTrackId: string | null = null) =>
  ({
    id,
    name: id,
    kind: "folder",
    parentTrackId,
  }) as unknown as TrackSummary;

// Two songs that do NOT share tracks, so a stale filter is visible as
// "the mixer is showing the other song's strips".
const clipsByRegion: Record<string, CompactClipEntry[]> = {
  "song-a": [clip("c1", "voz"), clip("c2", "guitarra")],
  "song-b": [clip("c3", "bajo")],
};

const tracks = [track("voz"), track("guitarra"), track("bajo")];

describe("computeActiveSongTrackIds", () => {
  it("returns the tracks of the region the playhead is on", () => {
    expect(computeActiveSongTrackIds("song-a", clipsByRegion)).toEqual(
      new Set(["voz", "guitarra"]),
    );
  });

  // The regression: the filter used to be derived from a playhead position
  // held in a ref, which never triggers a re-render, so crossing into
  // another song left the mixer pinned to the previous song's tracks.
  // Keying on the region id makes the change observable.
  it("follows the playhead when it crosses into another song", () => {
    const onSongA = computeActiveSongTrackIds("song-a", clipsByRegion);
    const onSongB = computeActiveSongTrackIds("song-b", clipsByRegion);

    expect(onSongA).not.toEqual(onSongB);
    expect(onSongB).toEqual(new Set(["bajo"]));
  });

  it("returns null between songs so the filter falls back to showing all", () => {
    expect(computeActiveSongTrackIds(null, clipsByRegion)).toBeNull();
  });

  it("returns an empty set for a song with no clips", () => {
    expect(computeActiveSongTrackIds("song-empty", clipsByRegion)).toEqual(
      new Set(),
    );
  });
});

describe("resolveVisibleTracks", () => {
  it("hides tracks that have no clip in the active song", () => {
    const visible = resolveVisibleTracks(
      tracks,
      new Set(["bajo"]),
      true,
    );

    expect(visible.map((t) => t.id)).toEqual(["bajo"]);
  });

  it("shows every track when the filter is off", () => {
    const visible = resolveVisibleTracks(tracks, new Set(["bajo"]), false);

    expect(visible.map((t) => t.id)).toEqual(["voz", "guitarra", "bajo"]);
  });

  it("shows every track when no song is active", () => {
    const visible = resolveVisibleTracks(tracks, null, true);

    expect(visible.map((t) => t.id)).toEqual(["voz", "guitarra", "bajo"]);
  });

  it("keeps ancestor folders so a visible child is never orphaned", () => {
    const nested = [
      track("banda"),
      track("cuerdas", "banda"),
      track("guitarra", "cuerdas"),
      track("bateria"),
    ];

    const visible = resolveVisibleTracks(nested, new Set(["guitarra"]), true);

    // Project order preserved; both ancestors pulled in.
    expect(visible.map((t) => t.id)).toEqual(["banda", "cuerdas", "guitarra"]);
  });

  it("does not loop forever on a parent cycle", () => {
    const cyclic = [track("a", "b"), track("b", "a")];

    const visible = resolveVisibleTracks(cyclic, new Set(["a"]), true);

    expect(visible.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

// Folding in the compact mixer reuses the DAW's collapsed set, so a folder
// folded in either view hides its children in both.
describe("resolveVisibleTracks folding", () => {
  const nested = [
    folder("banda"),
    track("voz", "banda"),
    folder("cuerdas", "banda"),
    track("guitarra", "cuerdas"),
    track("bateria"),
  ];

  it("hides the children of a collapsed folder", () => {
    const visible = resolveVisibleTracks(
      nested,
      null,
      false,
      new Set(["cuerdas"]),
    );

    expect(visible.map((t) => t.id)).toEqual([
      "banda",
      "voz",
      "cuerdas",
      "bateria",
    ]);
  });

  // The nested case is what a per-row rule would get wrong: folding the outer
  // folder must also hide the grandchildren under its inner folder.
  it("hides descendants at any depth", () => {
    const visible = resolveVisibleTracks(
      nested,
      null,
      false,
      new Set(["banda"]),
    );

    expect(visible.map((t) => t.id)).toEqual(["banda", "bateria"]);
  });

  it("shows everything when nothing is collapsed", () => {
    const visible = resolveVisibleTracks(nested, null, false, new Set());

    expect(visible.map((t) => t.id)).toEqual([
      "banda",
      "voz",
      "cuerdas",
      "guitarra",
      "bateria",
    ]);
  });

  it("keeps the active-song filter working alongside folding", () => {
    // "guitarra" is the only track in the song, so the filter pulls in its
    // ancestors — but the fold on "banda" still wins over them.
    const visible = resolveVisibleTracks(
      nested,
      new Set(["guitarra"]),
      true,
      new Set(["banda"]),
    );

    expect(visible.map((t) => t.id)).toEqual(["banda"]);
  });

  it("does not loop forever on a parent cycle", () => {
    const cyclic = [track("a", "b"), track("b", "a")];

    const visible = resolveVisibleTracks(cyclic, null, false, new Set(["c"]));

    expect(visible.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

// The count a folded folder shows on its face. It must match what unfolding
// actually gives back, so it is derived from the same walk that hides them.
describe("resolveMixerRows hidden counts", () => {
  const nested = [
    folder("banda"),
    track("voz", "banda"),
    folder("cuerdas", "banda"),
    track("guitarra", "cuerdas"),
    track("bateria"),
  ];

  it("counts the strips a folded folder is hiding", () => {
    const { hiddenCountByFolderId } = resolveMixerRows(
      nested,
      null,
      false,
      new Set(["cuerdas"]),
    );

    expect(hiddenCountByFolderId.get("cuerdas")).toBe(1);
  });

  // "banda" hides voz + cuerdas + guitarra = 3, not just its 2 direct
  // children: unfolding it brings back all three, so 3 is what it must say.
  it("counts descendants at any depth, not just direct children", () => {
    const { hiddenCountByFolderId } = resolveMixerRows(
      nested,
      null,
      false,
      new Set(["banda"]),
    );

    expect(hiddenCountByFolderId.get("banda")).toBe(3);
  });

  // With both folded, the strip the user can SEE is "banda", so the whole
  // count belongs to it; "cuerdas" is itself hidden and shows nothing.
  it("credits the outermost folded folder when folds nest", () => {
    const { hiddenCountByFolderId } = resolveMixerRows(
      nested,
      null,
      false,
      new Set(["banda", "cuerdas"]),
    );

    expect(hiddenCountByFolderId.get("banda")).toBe(3);
    expect(hiddenCountByFolderId.get("cuerdas")).toBeUndefined();
  });

  // The song filter already removed "voz", so unfolding would give back only
  // "cuerdas" + "guitarra". Reporting 3 here would promise a strip that the
  // filter is never going to show.
  it("does not count strips the active-song filter already removed", () => {
    const { hiddenCountByFolderId } = resolveMixerRows(
      nested,
      new Set(["guitarra"]),
      true,
      new Set(["banda"]),
    );

    expect(hiddenCountByFolderId.get("banda")).toBe(2);
  });

  it("reports no counts when nothing is folded", () => {
    const { hiddenCountByFolderId } = resolveMixerRows(
      nested,
      null,
      false,
      new Set(),
    );

    expect(hiddenCountByFolderId.size).toBe(0);
  });
});
