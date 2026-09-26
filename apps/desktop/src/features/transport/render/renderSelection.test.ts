// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type { SongView } from "@libretracks/shared/models";

import {
  DEFAULT_RENDER_PREFERENCES,
  defaultRenderFileName,
  loadRenderPreferences,
  renderableTracks,
  saveRenderPreferences,
} from "./renderSelection";

function song(): SongView {
  const track = (id: string, name: string, extra: Record<string, unknown> = {}) =>
    ({ id, name, kind: "audio", depth: 0, parentTrackId: null, ...extra }) as never;
  const clip = (id: string, trackId: string, start: number, duration: number) =>
    ({ id, trackId, timelineStartSeconds: start, durationSeconds: duration }) as never;
  return {
    id: "s",
    title: "Set",
    bpm: 120,
    timeSignature: "4/4",
    durationSeconds: 600,
    tempoMarkers: [],
    timeSignatureMarkers: [],
    sectionMarkers: [],
    regions: [
      { id: "r1", name: "Song A", startSeconds: 0, endSeconds: 100 } as never,
      { id: "r2", name: "Song B", startSeconds: 100, endSeconds: 200 } as never,
    ],
    tracks: [
      track("f", "Guitars", { kind: "folder" }),
      track("g1", "Gtr L", { parentTrackId: "f", depth: 1 }),
      track("g2", "Gtr R", { parentTrackId: "f", depth: 1 }),
      track("d", "Drums"),
      track("m", "Cues", { kind: "midi" }),
      track("other", "Only in B"),
    ],
    clips: [
      clip("c1", "g1", 0, 100),
      clip("c2", "g2", 10, 50),
      clip("c3", "d", 90, 20), // straddles the boundary: belongs to both
      clip("c4", "other", 100, 50), // starts exactly where A ends
      clip("c5", "m", 0, 100),
    ],
    projectRevision: 1,
  };
}

const t = (key: string, options?: Record<string, unknown>) => {
  const templates: Record<string, string> = {
    "transport.renderModal.stemsFileName": "{{name}} - stems",
    "transport.renderModal.onlyFileName": "{{name}} ({{track}})",
    "transport.renderModal.withoutFileName": "{{name}} (no {{tracks}})",
    "transport.renderModal.andSeparator": " or ",
    "transport.renderModal.customMixFileName": "{{name}} (mix)",
    "transport.renderModal.untitled": "Song",
  };
  return (templates[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_m, name: string) =>
    String(options?.[name] ?? ""),
  );
};

describe("renderableTracks", () => {
  it("lists audio tracks sounding in the song, in session order, with their folders", () => {
    const tracks = renderableTracks(song(), "r1");
    expect(tracks.map((track) => track.id)).toEqual(["g1", "g2", "d"]);
    expect(tracks[0].folderNames).toEqual(["Guitars"]);
    expect(tracks[2].folderNames).toEqual([]);
  });

  it("uses the song's own bounds, not the whole timeline", () => {
    expect(renderableTracks(song(), "r2").map((track) => track.id)).toEqual(["d", "other"]);
    expect(renderableTracks(song(), "missing")).toEqual([]);
    expect(renderableTracks(null, "r1")).toEqual([]);
  });
});

describe("defaultRenderFileName", () => {
  const tracks = renderableTracks(song(), "r1");
  const all = new Set(tracks.map((track) => track.id));

  it("names the mix after what it leaves out", () => {
    expect(defaultRenderFileName(t, "Song A", tracks, all, "mix")).toBe("Song A");
    expect(defaultRenderFileName(t, "Song A", tracks, new Set(["g1", "g2"]), "mix")).toBe(
      "Song A (no Drums)",
    );
    expect(defaultRenderFileName(t, "Song A", tracks, new Set(["d"]), "mix")).toBe(
      "Song A (Drums)",
    );
    expect(defaultRenderFileName(t, "Song A", tracks, new Set(["g1"]), "mix")).toBe(
      "Song A (Gtr L)",
    );
    expect(defaultRenderFileName(t, "Song A", tracks, new Set(), "mix")).toBe("Song A (mix)");
    expect(defaultRenderFileName(t, "Song A", tracks, all, "stems")).toBe("Song A - stems");
  });
});

describe("render preferences", () => {
  afterEach(() => window.localStorage.clear());

  it("round-trips and ignores garbage", () => {
    expect(loadRenderPreferences()).toEqual(DEFAULT_RENDER_PREFERENCES);
    saveRenderPreferences({ ...DEFAULT_RENDER_PREFERENCES, mode: "stems", sampleRate: 44100 });
    expect(loadRenderPreferences().mode).toBe("stems");
    expect(loadRenderPreferences().sampleRate).toBe(44100);
    window.localStorage.setItem(
      "lt.render.preferences",
      JSON.stringify({ format: "mp3", sampleRate: 12345, channels: 7 }),
    );
    const loaded = loadRenderPreferences();
    expect(loaded.format).toBe("pcm24");
    expect(loaded.sampleRate).toBeNull();
    expect(loaded.channels).toBe(2);
    window.localStorage.setItem("lt.render.preferences", "{not json");
    expect(loadRenderPreferences()).toEqual(DEFAULT_RENDER_PREFERENCES);
  });
});
