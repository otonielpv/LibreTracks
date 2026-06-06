import { describe, expect, it, vi } from "vitest";

import type { LibraryAssetSummary } from "@libretracks/shared/models";

import {
  createLibraryHandlers,
  type LibraryHandlerDeps,
} from "./libraryHandlers";

function asset(filePath: string): LibraryAssetSummary {
  return {
    fileName: filePath.split("/").at(-1) ?? filePath,
    filePath,
    durationSeconds: 1,
    isMissing: false,
  };
}

function setup(overrides: Partial<LibraryHandlerDeps> = {}) {
  const deps: LibraryHandlerDeps = {
    getPlaybackSongDir: () => "/songs/demo",
    getLibraryAssets: () => [],
    runAction: vi.fn(async (action) => {
      await action();
    }),
    waitForUiPaint: vi.fn(async () => {}),
    setStatus: vi.fn(),
    setLibraryAssets: vi.fn(),
    setLibraryFolders: vi.fn(),
    setLibraryClipPreview: vi.fn(),
    setIsImportingLibrary: vi.fn(),
    setLibraryImportProgress: vi.fn(),
    setDeletingLibraryFilePath: vi.fn(),
    loadLibraryState: vi.fn(async () => ({ folders: [] })),
    t: (key) => key,
    importLibraryAssetsFromDialog: vi.fn(async () => null),
    getLibraryFolders: vi.fn(async () => []),
    deleteLibraryAsset: vi.fn(async () => []),
    createLibraryFolder: vi.fn(async () => []),
    moveLibraryAsset: vi.fn(async () => []),
    renameLibraryFolder: vi.fn(async () => []),
    deleteLibraryFolder: vi.fn(async () => []),
    confirm: vi.fn(() => true),
    prompt: vi.fn(() => "New Folder"),
    ...overrides,
  };
  return { handlers: createLibraryHandlers(deps), deps };
}

describe("createLibraryHandlers", () => {
  it("import is blocked without an active session", async () => {
    const { handlers, deps } = setup({ getPlaybackSongDir: () => null });
    await handlers.handleImportLibraryAssetsClick();
    expect(deps.setStatus).toHaveBeenCalledWith(
      "transport.status.importRequiresSession",
    );
    expect(deps.setIsImportingLibrary).not.toHaveBeenCalled();
  });

  it("import resets the importing flag even when the dialog is cancelled", async () => {
    const { handlers, deps } = setup({
      importLibraryAssetsFromDialog: vi.fn(async () => null),
    });
    await handlers.handleImportLibraryAssetsClick();
    expect(deps.setIsImportingLibrary).toHaveBeenNthCalledWith(1, true);
    expect(deps.setIsImportingLibrary).toHaveBeenLastCalledWith(false);
    expect(deps.setLibraryAssets).not.toHaveBeenCalled();
  });

  it("delete dedupes assets by path and bails when the user cancels", async () => {
    const confirm = vi.fn(() => false);
    const { handlers, deps } = setup({ confirm });
    await handlers.handleDeleteLibraryAssets([asset("a.wav"), asset("a.wav")]);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(deps.deleteLibraryAsset).not.toHaveBeenCalled();
  });

  it("delete prunes deleted paths from the clip preview", async () => {
    const setLibraryClipPreview = vi.fn();
    const { handlers } = setup({
      getLibraryAssets: () => [asset("a.wav")],
      deleteLibraryAsset: vi.fn(async () => []),
      setLibraryClipPreview,
    });
    await handlers.handleDeleteLibraryAssets([asset("a.wav")]);
    const pruner = setLibraryClipPreview.mock.calls.at(-1)![0] as (
      c: { filePath: string }[],
    ) => unknown[];
    expect(
      pruner([{ filePath: "a.wav" }, { filePath: "b.wav" }]),
    ).toEqual([{ filePath: "b.wav" }]);
  });

  it("create folder is a no-op when the prompt is dismissed", async () => {
    const { handlers, deps } = setup({ prompt: vi.fn(() => null) });
    await handlers.handleCreateLibraryFolder();
    expect(deps.createLibraryFolder).not.toHaveBeenCalled();
  });

  it("move asset iterates each unique path and refreshes state", async () => {
    const moveLibraryAsset = vi.fn(async () => [asset("a.wav")]);
    const { handlers, deps } = setup({ moveLibraryAsset });
    await handlers.handleMoveLibraryAssets(["a.wav", "a.wav", "b.wav"], "Folder");
    expect(moveLibraryAsset).toHaveBeenCalledTimes(2);
    expect(deps.setLibraryFolders).toHaveBeenCalled();
  });
});
