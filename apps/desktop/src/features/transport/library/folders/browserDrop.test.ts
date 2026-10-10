import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserDrop, type BrowserDropDeps } from "./browserDrop";

const importAudioFilesFromPaths = vi.fn();
vi.mock("../../desktopApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../desktopApi")>();
  return {
    ...actual,
    importAudioFilesFromPaths: (files: unknown) => importAudioFilesFromPaths(files),
  };
});

function setup(overTimeline: boolean) {
  const dragDrop = {
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
    t: (key: string) => key,
    getPlayheadSeconds: () => 7,
  } as unknown as BrowserDropDeps;
  return { drop: createBrowserDrop(deps), dragDrop, deps };
}

describe("folder library drops", () => {
  beforeEach(() => importAudioFilesFromPaths.mockReset());

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

  it("turns a disk folder into one song named after it", async () => {
    importAudioFilesFromPaths.mockResolvedValue({
      assets: [{ filePath: "D:/Oceans/Drums.wav", durationSeconds: 200 }],
      skipped: [],
    });
    const { drop, dragDrop, deps } = setup(true);
    drop.dropFolderAt({
      folderName: "Oceans",
      audioPaths: ["D:/Oceans/Drums.wav"],
      clientX: 0,
      clientY: 0,
      ctrlKey: false,
      metaKey: false,
    });
    await vi.waitFor(() => expect(dragDrop.dropLibraryFolder).toHaveBeenCalled());
    expect(deps.mergeLibraryAssets).toHaveBeenCalled();
    expect(dragDrop.dropLibraryFolder).toHaveBeenCalledWith({
      payload: [{ file_path: "D:/Oceans/Drums.wav", durationSeconds: 200 }],
      folderName: "Oceans",
      timelineStartSeconds: 42,
      layout: "vertical",
    });
  });

  // While dragging, the timeline draws where it would land, labelled by what
  // is being dragged (a folder is a song of audio).
  it("asks the timeline to show where a drag would land, and clears it", () => {
    const { drop, dragDrop } = setup(true);
    drop.previewAt({ kind: "files", paths: ["D:/Stems/Drums.wav"] }, 10, 20);
    expect(dragDrop.previewDropAtClientPoint).toHaveBeenLastCalledWith(10, 20, "audio");
    drop.previewAt({ kind: "files", paths: ["D:/Video/Letras.mp4"] }, 11, 21);
    expect(dragDrop.previewDropAtClientPoint).toHaveBeenLastCalledWith(11, 21, "video");
    drop.previewAt({ kind: "folder" }, 12, 22);
    expect(dragDrop.previewDropAtClientPoint).toHaveBeenLastCalledWith(12, 22, "audio");
    drop.clearPreview();
    expect(dragDrop.clearDropPreview).toHaveBeenCalled();
  });
});
