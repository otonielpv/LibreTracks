import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserDrop, type BrowserDropDeps } from "./browserDrop";

const importAudioFilesFromPaths = vi.fn();
const listLibraryFolderAudio = vi.fn();
vi.mock("../../desktopApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../desktopApi")>();
  return {
    ...actual,
    importAudioFilesFromPaths: (files: unknown) => importAudioFilesFromPaths(files),
    listLibraryFolderAudio: (path: string) => listLibraryFolderAudio(path),
  };
});

function setup(overTimeline: boolean, songUnderPointer: string | null = null) {
  const dragDrop = {
    resolveCompactRegionAtPoint: vi.fn(() =>
      songUnderPointer ? { hit: true as const, regionId: songUnderPointer } : { hit: false as const },
    ),
    dropPathsIntoSong: vi.fn(() => true),
    addLibraryAssetsToSong: vi.fn(),
    resolveTimelineDropFromClientPoint: vi.fn(() => ({
      isOverTimeline: overTimeline,
      dropSeconds: 42,
      targetTrackId: "t1",
    })),
    handleNativeExternalTimelineDrop: vi.fn(),
    dropLibraryFolder: vi.fn(async () => {}),
    previewDropAtClientPoint: vi.fn(() => overTimeline),
    clearDropPreview: vi.fn(),
  };
  const deps = {
    dragDrop: () => dragDrop,
    hasSession: () => true,
    runAction: async (action: () => Promise<void>) => action(),
    mergeLibraryAssets: vi.fn(),
    setStatus: vi.fn(),
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
    getPlayheadSeconds: () => 7,
  } as unknown as BrowserDropDeps;
  return { drop: createBrowserDrop(deps), dragDrop, deps };
}

describe("folder library drops", () => {
  beforeEach(() => {
    importAudioFilesFromPaths.mockReset();
    listLibraryFolderAudio.mockReset();
  });

  // Same road as a file dropped from the OS file manager: one import path.
  it("sends disk files down the external-drop path at the drop point", () => {
    const { drop, dragDrop } = setup(true);
    expect(drop.dropPathsAt(["D:/Stems/Drums.wav"], 10, 20)).toBe(true);
    expect(dragDrop.handleNativeExternalTimelineDrop).toHaveBeenCalledWith(
      { kind: "audio", audioPaths: ["D:/Stems/Drums.wav"] },
      42,
      "t1",
    );
  });

  // Touch has no drag: the selection lands at the playhead, on new tracks.
  it("adds the selection at the playhead on touch", () => {
    const { drop, dragDrop } = setup(true);
    drop.addPathsAtPlayhead(["/Documents/Stems/Drums.wav"]);
    expect(dragDrop.handleNativeExternalTimelineDrop).toHaveBeenCalledWith(
      { kind: "audio", audioPaths: ["/Documents/Stems/Drums.wav"] },
      7,
      null,
    );
  });

  it("does nothing off the timeline", () => {
    const { drop, dragDrop } = setup(false);
    expect(drop.dropPathsAt(["D:/Stems/Drums.wav"], 10, 20)).toBe(false);
    expect(dragDrop.handleNativeExternalTimelineDrop).not.toHaveBeenCalled();
  });

  // The stems of a Reaper project sit in Media/: the backend looks there.
  it("turns a disk folder into one song named after it", async () => {
    listLibraryFolderAudio.mockResolvedValue({
      paths: ["D:/Oceans/Media/Drums.wav"],
      truncated: false,
    });
    importAudioFilesFromPaths.mockResolvedValue({
      assets: [{ filePath: "D:/Oceans/Media/Drums.wav", durationSeconds: 200 }],
      skipped: [],
    });
    const { drop, dragDrop, deps } = setup(true);
    drop.dropFolderAt({
      folderPath: "D:/Oceans",
      folderName: "Oceans",
      clientX: 0,
      clientY: 0,
      ctrlKey: false,
      metaKey: false,
    });
    await vi.waitFor(() => expect(dragDrop.dropLibraryFolder).toHaveBeenCalled());
    expect(listLibraryFolderAudio).toHaveBeenCalledWith("D:/Oceans");
    expect(importAudioFilesFromPaths).toHaveBeenCalledWith([
      { fileName: "Drums.wav", sourcePath: "D:/Oceans/Media/Drums.wav" },
    ]);
    expect(deps.mergeLibraryAssets).toHaveBeenCalled();
    expect(dragDrop.dropLibraryFolder).toHaveBeenCalledWith({
      payload: [{ file_path: "D:/Oceans/Media/Drums.wav", durationSeconds: 200 }],
      folderName: "Oceans",
      timelineStartSeconds: 42,
      layout: "vertical",
    });
  });

  it("says so when a folder has no audio, instead of an empty song", async () => {
    listLibraryFolderAudio.mockResolvedValue({ paths: [], truncated: false });
    const { drop, dragDrop, deps } = setup(true);
    drop.addFolderAtPlayhead("/Documents/Empty", "Empty");
    await vi.waitFor(() =>
      expect(deps.setStatus).toHaveBeenLastCalledWith(
        'library.folders.noAudioInFolder {"name":"Empty"}',
      ),
    );
    expect(importAudioFilesFromPaths).not.toHaveBeenCalled();
    expect(dragDrop.dropLibraryFolder).not.toHaveBeenCalled();
  });

  it("refuses a folder of several songs", async () => {
    listLibraryFolderAudio.mockResolvedValue({ paths: ["a.wav", "b.wav"], truncated: true });
    const { drop, dragDrop, deps } = setup(true);
    drop.addFolderAtPlayhead("D:/MultiTracks", "MultiTracks");
    await vi.waitFor(() =>
      expect(deps.setStatus).toHaveBeenLastCalledWith(
        'library.folders.tooMuchAudio {"name":"MultiTracks","count":2}',
      ),
    );
    expect(importAudioFilesFromPaths).not.toHaveBeenCalled();
    expect(dragDrop.dropLibraryFolder).not.toHaveBeenCalled();
  });

  // While dragging, the timeline draws where it would land, labelled by what
  // is being dragged (a folder is a song of audio).
  it("asks the timeline to show where a drag would land, and clears it", () => {
    const { drop, dragDrop } = setup(true);
    drop.previewAt({ kind: "files", paths: ["D:/Stems/Drums.wav"] }, 10, 20);
    expect(dragDrop.previewDropAtClientPoint).toHaveBeenLastCalledWith(10, 20, "audio", 1);
    drop.previewAt({ kind: "files", paths: ["D:/Video/Letras.mp4"] }, 11, 21);
    expect(dragDrop.previewDropAtClientPoint).toHaveBeenLastCalledWith(11, 21, "video", 1);
    drop.previewAt({ kind: "folder" }, 12, 22);
    expect(dragDrop.previewDropAtClientPoint).toHaveBeenLastCalledWith(12, 22, "audio", 1);
    drop.clearPreview();
    expect(dragDrop.clearDropPreview).toHaveBeenCalled();
  });

  // Compacta and Setlist: the song under the pointer takes the files, like a
  // drop from the file manager there (the timeline is not even looked at).
  it("drops disk files into the song under the pointer", () => {
    const { drop, dragDrop } = setup(false, "song-2");
    expect(drop.dropPathsAt(["D:/Stems/Bass.wav"], 10, 20)).toBe(true);
    expect(dragDrop.dropPathsIntoSong).toHaveBeenCalledWith("song-2", {
      kind: "audio",
      audioPaths: ["D:/Stems/Bass.wav"],
    });
    expect(dragDrop.resolveTimelineDropFromClientPoint).not.toHaveBeenCalled();
    expect(dragDrop.handleNativeExternalTimelineDrop).not.toHaveBeenCalled();
  });

  it("a disk folder dropped on a song adds its audio to that song", async () => {
    listLibraryFolderAudio.mockResolvedValue({ paths: ["D:/Oceans/Media/Drums.wav"], truncated: false });
    importAudioFilesFromPaths.mockResolvedValue({
      assets: [{ filePath: "audio/Drums.wav", durationSeconds: 12 }],
      skipped: [],
    });
    const { drop, dragDrop } = setup(false, "song-2");
    expect(
      drop.dropFolderAt({
        folderPath: "D:/Oceans",
        folderName: "Oceans",
        clientX: 10,
        clientY: 20,
        ctrlKey: false,
        metaKey: false,
      }),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(dragDrop.addLibraryAssetsToSong).toHaveBeenCalledWith("song-2", [
        { filePath: "audio/Drums.wav", durationSeconds: 12 },
      ]),
    );
    expect(dragDrop.dropLibraryFolder).not.toHaveBeenCalled();
  });

  it("the preview counts the dragged files for the song's placeholders", () => {
    const { drop, dragDrop } = setup(false);
    drop.previewAt({ kind: "files", paths: ["a.wav", "b.wav"] }, 10, 20);
    expect(dragDrop.previewDropAtClientPoint).toHaveBeenCalledWith(10, 20, "audio", 2);
  });
});
