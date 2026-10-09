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
  };
  const deps = {
    dragDrop: () => dragDrop,
    hasSession: () => true,
    runAction: async (action: () => Promise<void>) => action(),
    mergeLibraryAssets: vi.fn(),
    setStatus: vi.fn(),
    t: (key: string) => key,
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
});
