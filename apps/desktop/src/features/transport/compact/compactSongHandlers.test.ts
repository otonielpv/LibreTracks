import { describe, expect, it, vi } from "vitest";

import type {
  LibraryAssetSummary,
  SongView,
  TransportSnapshot,
} from "@libretracks/shared/models";

import {
  createCompactSongHandlers,
  isLibraryFolderInBranch,
  resolveRenamedLibraryFolderBranch,
  type CompactSongHandlerDeps,
} from "./compactSongHandlers";

const snapshot = (revision: number) =>
  ({ projectRevision: revision }) as unknown as TransportSnapshot;

const region = (
  id: string,
  overrides: Partial<{
    name: string;
    startSeconds: number;
    endSeconds: number;
    key: string | null;
  }> = {},
) => ({
  id,
  name: overrides.name ?? id,
  startSeconds: overrides.startSeconds ?? 0,
  endSeconds: overrides.endSeconds ?? 10,
  key: overrides.key ?? null,
});

const asset = (
  filePath: string,
  folderPath: string | null,
): LibraryAssetSummary =>
  ({ filePath, folderPath, fileName: filePath }) as unknown as LibraryAssetSummary;

const songWith = (
  regions: ReturnType<typeof region>[],
  clips: Array<{ timelineStartSeconds: number }> = [],
) => ({ regions, clips }) as unknown as SongView;

function setup(overrides: Partial<CompactSongHandlerDeps> = {}) {
  const deps: CompactSongHandlerDeps = {
    getSong: () => songWith([region("r1", { name: "Canción 1" })]),
    runAction: vi.fn(async (action) => {
      await action();
    }),
    applyPlaybackSnapshot: vi.fn(),
    setStatus: vi.fn(),
    setSelectedRegionId: vi.fn(),
    setExportSongTarget: vi.fn(),
    setLibraryAssets: vi.fn(),
    setLibraryFolders: vi.fn(),
    loadLibraryState: vi.fn(async () => ({ assets: [], folders: [] })),
    prompt: vi.fn(async () => null),
    confirm: vi.fn(async () => true),
    t: (key, options) => `${key}:${JSON.stringify(options ?? {})}`,
    getEffectiveBpmAt: () => 120,
    moveClipToTrack: vi.fn(async () => snapshot(1)),
    deleteClip: vi.fn(async () => snapshot(2)),
    updateSongRegion: vi.fn(async () => snapshot(3)),
    updateSongRegionKey: vi.fn(async () => snapshot(4)),
    upsertSongTempoMarker: vi.fn(async () => snapshot(5)),
    deleteSongRegion: vi.fn(async () => snapshot(6)),
    exportRegionAsPackage: vi.fn(async () => true),
    renameLibraryFolder: vi.fn(async () => []),
    moveLibraryAsset: vi.fn(async () => []),
    deleteLibraryFolder: vi.fn(async () => []),
    ...overrides,
  };

  return { handlers: createCompactSongHandlers(deps), deps };
}

describe("library folder path helpers", () => {
  it("matches the branch root and its descendants only", () => {
    expect(isLibraryFolderInBranch("Song", "Song")).toBe(true);
    expect(isLibraryFolderInBranch("Song/Stems", "Song")).toBe(true);
    // A shared prefix is not a branch: "Songbook" must not match "Song".
    expect(isLibraryFolderInBranch("Songbook", "Song")).toBe(false);
    expect(isLibraryFolderInBranch("Other", "Song")).toBe(false);
  });

  it("re-roots a nested path onto the new branch", () => {
    expect(resolveRenamedLibraryFolderBranch("Old", "Old", "New")).toBe("New");
    expect(resolveRenamedLibraryFolderBranch("Old/Stems", "Old", "New")).toBe(
      "New/Stems",
    );
    expect(
      resolveRenamedLibraryFolderBranch("Old/A/B", "Old", "New"),
    ).toBe("New/A/B");
  });
});

describe("createCompactSongHandlers", () => {
  describe("clip actions", () => {
    it("moves a clip to a track and publishes the snapshot", async () => {
      const { handlers, deps } = setup();
      handlers.handleCompactMoveClipToTrack("c1", "t2");
      await vi.waitFor(() =>
        expect(deps.applyPlaybackSnapshot).toHaveBeenCalledWith(snapshot(1)),
      );
      expect(deps.moveClipToTrack).toHaveBeenCalledWith({
        clipId: "c1",
        targetTrackId: "t2",
      });
    });

    it("deletes a clip and publishes the snapshot", async () => {
      const { handlers, deps } = setup();
      handlers.handleCompactDeleteClip("c1");
      await vi.waitFor(() =>
        expect(deps.applyPlaybackSnapshot).toHaveBeenCalledWith(snapshot(2)),
      );
    });
  });

  describe("rename", () => {
    it("renames the region and syncs the library folder", async () => {
      const { handlers, deps } = setup({
        prompt: vi.fn(async () => "Nueva"),
        loadLibraryState: vi.fn(async () => ({
          assets: [],
          folders: ["Canción 1"],
        })),
      });
      await handlers.handleCompactRenameSong("r1");

      expect(deps.updateSongRegion).toHaveBeenCalledWith("r1", "Nueva", 0, 10);
      // Old folder exists, new one does not → rename in place. The rename
      // fires inside `void runAction(...)`, so it lands after the handler's
      // own promise settles.
      await vi.waitFor(() =>
        expect(deps.renameLibraryFolder).toHaveBeenCalledWith(
          "Canción 1",
          "Nueva",
        ),
      );
    });

    it("does nothing when the prompt is cancelled or unchanged", async () => {
      const cancelled = setup({ prompt: vi.fn(async () => null) });
      await cancelled.handlers.handleCompactRenameSong("r1");
      expect(cancelled.deps.updateSongRegion).not.toHaveBeenCalled();

      const unchanged = setup({ prompt: vi.fn(async () => "Canción 1") });
      await unchanged.handlers.handleCompactRenameSong("r1");
      expect(unchanged.deps.updateSongRegion).not.toHaveBeenCalled();
    });

    it("merges into an existing folder by moving assets, then drops the old one", async () => {
      const { handlers, deps } = setup({
        prompt: vi.fn(async () => "Destino"),
        loadLibraryState: vi.fn(async () => ({
          assets: [
            asset("a.wav", "Canción 1"),
            asset("b.wav", "Canción 1/Stems"),
            asset("c.wav", "Otra"),
          ],
          folders: ["Canción 1", "Destino"],
        })),
      });
      await handlers.handleCompactRenameSong("r1");

      // Both folders exist → merge path, not rename.
      await vi.waitFor(() =>
        expect(deps.moveLibraryAsset).toHaveBeenCalledWith("a.wav", "Destino"),
      );
      expect(deps.renameLibraryFolder).not.toHaveBeenCalled();
      expect(deps.moveLibraryAsset).toHaveBeenCalledWith(
        "b.wav",
        "Destino/Stems",
      );
      // The asset outside the branch is left alone.
      expect(deps.moveLibraryAsset).not.toHaveBeenCalledWith(
        "c.wav",
        expect.anything(),
      );
      expect(deps.deleteLibraryFolder).toHaveBeenCalledWith("Canción 1");
    });

    it("skips the library sync when the old folder does not exist", async () => {
      const { handlers, deps } = setup({
        prompt: vi.fn(async () => "Nueva"),
        loadLibraryState: vi.fn(async () => ({ assets: [], folders: [] })),
      });
      await handlers.handleCompactRenameSong("r1");

      // Wait for the sync to actually run (it reads the library state first),
      // otherwise the negative assertions below would pass vacuously.
      await vi.waitFor(() => expect(deps.loadLibraryState).toHaveBeenCalled());
      expect(deps.updateSongRegion).toHaveBeenCalled();
      expect(deps.renameLibraryFolder).not.toHaveBeenCalled();
      expect(deps.deleteLibraryFolder).not.toHaveBeenCalled();
    });
  });

  describe("BPM", () => {
    it("upserts a tempo marker at the region start", async () => {
      const { handlers, deps } = setup({ prompt: vi.fn(async () => "128") });
      await handlers.handleCompactSetSongBpm("r1");

      expect(deps.upsertSongTempoMarker).toHaveBeenCalledWith(0, 128);
    });

    it("accepts a comma decimal separator", async () => {
      const { handlers, deps } = setup({ prompt: vi.fn(async () => "128,5") });
      await handlers.handleCompactSetSongBpm("r1");

      expect(deps.upsertSongTempoMarker).toHaveBeenCalledWith(0, 128.5);
    });

    it("rejects non-numeric and non-positive input", async () => {
      for (const raw of ["abc", "0", "-5"]) {
        const { handlers, deps } = setup({ prompt: vi.fn(async () => raw) });
        await handlers.handleCompactSetSongBpm("r1");

        expect(deps.upsertSongTempoMarker).not.toHaveBeenCalled();
        expect(deps.setStatus).toHaveBeenCalledWith("BPM inválido");
      }
    });

    it("does nothing when cancelled", async () => {
      const { handlers, deps } = setup({ prompt: vi.fn(async () => null) });
      await handlers.handleCompactSetSongBpm("r1");

      expect(deps.upsertSongTempoMarker).not.toHaveBeenCalled();
      expect(deps.setStatus).not.toHaveBeenCalled();
    });
  });

  describe("delete", () => {
    it("deletes without confirming when the song holds no clips", async () => {
      const { handlers, deps } = setup({
        getSong: () => songWith([region("r1", { startSeconds: 0, endSeconds: 10 })]),
      });
      await handlers.handleCompactDeleteSong("r1");

      expect(deps.confirm).not.toHaveBeenCalled();
      expect(deps.deleteSongRegion).toHaveBeenCalledWith("r1");
      expect(deps.setSelectedRegionId).toHaveBeenCalledWith(null);
    });

    it("confirms first when clips fall inside the region", async () => {
      const { handlers, deps } = setup({
        getSong: () =>
          songWith(
            [region("r1", { startSeconds: 0, endSeconds: 10 })],
            [{ timelineStartSeconds: 5 }, { timelineStartSeconds: 50 }],
          ),
      });
      await handlers.handleCompactDeleteSong("r1");

      // Only the clip inside [0, 10) is counted.
      expect(deps.confirm).toHaveBeenCalledWith(expect.stringContaining("1 clip"));
      expect(deps.deleteSongRegion).toHaveBeenCalled();
    });

    it("aborts when the confirmation is declined", async () => {
      const { handlers, deps } = setup({
        getSong: () =>
          songWith(
            [region("r1", { startSeconds: 0, endSeconds: 10 })],
            [{ timelineStartSeconds: 5 }],
          ),
        confirm: vi.fn(async () => false),
      });
      await handlers.handleCompactDeleteSong("r1");

      expect(deps.deleteSongRegion).not.toHaveBeenCalled();
    });
  });

  describe("export", () => {
    it("opens the mode chooser instead of exporting directly", () => {
      const { handlers, deps } = setup();
      handlers.handleCompactExportSong("r1");

      expect(deps.setExportSongTarget).toHaveBeenCalledWith({
        regionId: "r1",
        regionName: "Canción 1",
      });
      expect(deps.exportRegionAsPackage).not.toHaveBeenCalled();
    });

    it("runs the export behind the blocking overlay on confirm", async () => {
      const { handlers, deps } = setup();
      handlers.handleConfirmExportSong("r1", true);

      expect(deps.setExportSongTarget).toHaveBeenCalledWith(null);
      expect(deps.runAction).toHaveBeenCalledWith(expect.any(Function), {
        busy: true,
      });
      await vi.waitFor(() =>
        expect(deps.exportRegionAsPackage).toHaveBeenCalledWith("r1", true),
      );
    });

    it("stays silent when the export dialog is dismissed", async () => {
      const { handlers, deps } = setup({
        exportRegionAsPackage: vi.fn(async () => false),
      });
      handlers.handleConfirmExportSong("r1", false);

      await vi.waitFor(() =>
        expect(deps.exportRegionAsPackage).toHaveBeenCalled(),
      );
      expect(deps.setStatus).not.toHaveBeenCalled();
    });
  });

  describe("song key", () => {
    it("updates the region key", async () => {
      const { handlers, deps } = setup();
      handlers.handleCompactSetSongKey("r1", "F#m");

      await vi.waitFor(() =>
        expect(deps.updateSongRegionKey).toHaveBeenCalledWith("r1", "F#m"),
      );
    });

    it("is a no-op when the key is unchanged", () => {
      const { handlers, deps } = setup({
        getSong: () => songWith([region("r1", { key: "C" })]),
      });
      handlers.handleCompactSetSongKey("r1", "C");

      expect(deps.updateSongRegionKey).not.toHaveBeenCalled();
    });

    it("treats clearing an already-absent key as a no-op", () => {
      const { handlers, deps } = setup();
      handlers.handleCompactSetSongKey("r1", null);

      expect(deps.updateSongRegionKey).not.toHaveBeenCalled();
    });
  });

  it("every region-scoped handler ignores an unknown region id", async () => {
    const { handlers, deps } = setup({ getSong: () => songWith([]) });

    await handlers.handleCompactRenameSong("nope");
    await handlers.handleCompactSetSongBpm("nope");
    await handlers.handleCompactDeleteSong("nope");
    handlers.handleCompactExportSong("nope");
    handlers.handleCompactSetSongKey("nope", "C");

    expect(deps.updateSongRegion).not.toHaveBeenCalled();
    expect(deps.upsertSongTempoMarker).not.toHaveBeenCalled();
    expect(deps.deleteSongRegion).not.toHaveBeenCalled();
    expect(deps.setExportSongTarget).not.toHaveBeenCalled();
    expect(deps.updateSongRegionKey).not.toHaveBeenCalled();
  });
});
