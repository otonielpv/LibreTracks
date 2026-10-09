import { describe, expect, it } from "vitest";

import type { LibraryAssetSummary, SongView } from "@libretracks/shared/models";

import { planOrganizeBySong, songFolderName } from "./organizeBySong";

const asset = (filePath: string) =>
  ({ fileName: filePath, filePath, durationSeconds: 10, isMissing: false }) as LibraryAssetSummary;

const song = {
  regions: [
    { id: "b", name: "Way Maker", startSeconds: 100, endSeconds: 200 },
    { id: "a", name: "Oceans", startSeconds: 0, endSeconds: 100 },
  ],
  clips: [
    { filePath: "D:\\Stems\\Oceans Drums.wav", timelineStartSeconds: 0, durationSeconds: 90 },
    { filePath: "D:/Stems/Way Bass.wav", timelineStartSeconds: 100, durationSeconds: 90 },
    { filePath: "D:/Stems/Click.wav", timelineStartSeconds: 0, durationSeconds: 200 },
  ],
} as unknown as SongView;

describe("planOrganizeBySong", () => {
  it("puts each audio in the folder of the song it is used in", () => {
    const plan = planOrganizeBySong(
      [asset("D:/Stems/Way Bass.wav"), asset("D:/Stems/Oceans Drums.wav")],
      song,
    );
    // Folders in timeline order, whatever order the library lists the audio.
    expect(plan.moves).toEqual([
      { folder: "Oceans", filePaths: ["D:/Stems/Oceans Drums.wav"] },
      { folder: "Way Maker", filePaths: ["D:/Stems/Way Bass.wav"] },
    ]);
  });

  it("leaves audio shared by several songs, or unused, where it is", () => {
    const plan = planOrganizeBySong(
      [asset("D:/Stems/Click.wav"), asset("D:/Stems/Spare.wav")],
      song,
    );
    expect(plan.moves).toEqual([]);
    expect(plan.shared).toBe(1);
    expect(plan.unused).toBe(1);
  });

  it("turns a song name into a usable folder name", () => {
    expect(songFolderName("AC/DC Medley", "Song")).toBe("AC-DC Medley");
    expect(songFolderName("   ", "Song")).toBe("Song");
  });
});
