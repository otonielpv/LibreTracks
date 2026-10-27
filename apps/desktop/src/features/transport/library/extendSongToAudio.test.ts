import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClipSummary, SongView } from "@libretracks/shared/models";

const api = vi.hoisted(() => ({ song: null as unknown, updateSongRegion: vi.fn() }));
vi.mock("../desktopApi", () => ({
  getSongView: vi.fn(async () => api.song),
  updateSongRegion: api.updateSongRegion,
}));

import { dropFolderOverNewSong } from "./folderOverNewSong";
import { extendSongToAudio } from "./extendSongToAudio";

const clip = (filePath: string, start: number, duration: number) =>
  ({ id: filePath, filePath, timelineStartSeconds: start, durationSeconds: duration }) as ClipSummary;
const region = (id: string, start: number, end: number) => ({ id, name: id, startSeconds: start, endSeconds: end });
const song = (regions: ReturnType<typeof region>[], clips: ClipSummary[]) =>
  ({ bpm: 120, timeSignature: "4/4", tempoMarkers: [], timeSignatureMarkers: [], regions, clips, tracks: [], sectionMarkers: [] }) as unknown as SongView;

beforeEach(() => {
  api.updateSongRegion.mockReset();
  api.updateSongRegion.mockResolvedValue({ projectRevision: 9 });
});

// The report: «+ New song» (one bar long), then the stems dropped on it:
// «Analyze song» found no click, guide or drums, because it only reads inside
// the song and the song ended after one bar.
describe("extendSongToAudio", () => {
  it("an empty one-bar song grows to the longest audio dropped on it", async () => {
    api.song = song([region("r", 0, 2)], [clip("click.wav", 0, 200), clip("guide.wav", 0, 205)]);
    await extendSongToAudio("r", ["click.wav", "guide.wav"]);
    expect(api.updateSongRegion).toHaveBeenCalledWith("r", "r", 0, 205);
  });

  it("never into the next song", async () => {
    api.song = song([region("r", 0, 2), region("next", 100, 140)], [clip("a.wav", 0, 200)]);
    await extendSongToAudio("r", ["a.wav"]);
    expect(api.updateSongRegion).toHaveBeenCalledWith("r", "r", 0, 100);
  });

  it("a song that already had audio is not resized behind the user's back", async () => {
    api.song = song([region("r", 0, 180)], [clip("old.wav", 0, 180), clip("new.wav", 0, 190)]);
    expect(await extendSongToAudio("r", ["new.wav"])).toBeNull();
    expect(api.updateSongRegion).not.toHaveBeenCalled();
  });

  it("audio that already fits changes nothing", async () => {
    api.song = song([region("r", 0, 200)], [clip("a.wav", 0, 150)]);
    expect(await extendSongToAudio("r", ["a.wav"])).toBeNull();
    expect(api.updateSongRegion).not.toHaveBeenCalled();
  });
});

describe("dropFolderOverNewSong", () => {
  const payload = [{ file_path: "C:/stems/click.wav", durationSeconds: 200 }];
  const tile = () => {
    const element = document.createElement("div");
    element.className = "lt-setlist-add-song";
    const inner = document.createElement("button");
    element.appendChild(inner);
    return inner;
  };

  it("a library folder over «+ New song» becomes a song at the end, named after the folder", () => {
    const dropFolder = vi.fn(async () => {});
    const runAction = vi.fn((action: () => Promise<void>) => action());
    const existing = song([region("r", 0, 60)], []);
    expect(dropFolderOverNewSong(tile(), "Gratitud", payload as never, existing, dropFolder, runAction)).toBe(true);
    expect(dropFolder).toHaveBeenCalledWith(
      expect.objectContaining({ folderName: "Gratitud", layout: "vertical", payload }),
    );
    // After the last song, on a downbeat.
    expect((dropFolder.mock.calls[0] as unknown as [{ timelineStartSeconds: number }])[0].timelineStartSeconds).toBeGreaterThanOrEqual(60);
  });

  it("a single file, or anywhere else, is not taken", () => {
    const dropFolder = vi.fn(async () => {});
    const runAction = vi.fn();
    expect(dropFolderOverNewSong(tile(), null, payload as never, null, dropFolder, runAction)).toBe(false);
    expect(dropFolderOverNewSong(document.createElement("div"), "Gratitud", payload as never, null, dropFolder, runAction)).toBe(false);
    expect(runAction).not.toHaveBeenCalled();
  });
});
