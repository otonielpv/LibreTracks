import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  LibraryAssetSummary,
  SongView,
  TransportSnapshot,
} from "@libretracks/shared/models";

const api = vi.hoisted(() => ({
  cancelMarkerJump: vi.fn(),
  createClipsWithAutoTracks: vi.fn(),
  createLibraryFolder: vi.fn(),
  importAudioFilesFromBytes: vi.fn(),
  importAudioFilesFromPaths: vi.fn(),
  moveLibraryAsset: vi.fn(),
  playTransport: vi.fn(),
  reorderSongRegion: vi.fn(),
  setSongRegionChart: vi.fn(),
  updateSongRegionMasterGain: vi.fn(),
}));
const dialog = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  ...api,
  isTauriApp: false,
}));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);

import { useTransportStore } from "../store";
import {
  createSongViewHandlers,
  type SongViewHandlerDeps,
} from "./songViewHandlers";

const snapshot = (revision: number) =>
  ({ projectRevision: revision }) as unknown as TransportSnapshot;

const region = (id: string, name: string, startSeconds: number, endSeconds: number) => ({
  id,
  name,
  startSeconds,
  endSeconds,
});

const asset = (filePath: string, folderPath: string | null) =>
  ({ filePath, folderPath, fileName: filePath }) as unknown as LibraryAssetSummary;

function setup(overrides: Partial<SongViewHandlerDeps> = {}) {
  const song = {
    regions: [region("r1", "Canción 1", 0, 30), region("r2", "Canción 2", 40, 70)],
    bpm: 120,
    timeSignature: "4/4",
    tempoMarkers: [],
    timeSignatureMarkers: [],
    clips: [],
  } as unknown as SongView;
  const deps: SongViewHandlerDeps = {
    t: (key, options) => `${key}:${JSON.stringify(options ?? {})}`,
    getSong: () => song,
    runAction: vi.fn(async (action) => {
      await action();
    }),
    applyPlaybackSnapshot: vi.fn(),
    setStatus: vi.fn(),
    mergeLibraryAssets: vi.fn(),
    refreshLibraryState: vi.fn(async () => undefined),
    streamRegionMasterGain: vi.fn(async () => undefined),
    importSongPackageAt: vi.fn(async () => undefined),
    isPlaying: () => false,
    seek: vi.fn(async () => undefined),
    scheduleSongJump: vi.fn(async () => undefined),
    toggleVamp: vi.fn(async () => undefined),
    markerPrimaryAction: vi.fn(async () => undefined),
    ...overrides,
  };
  return { deps, handlers: createSongViewHandlers(() => deps) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  dialog.open.mockReset();
  useTransportStore.setState({ optimisticRegionMaster: {} });
});

describe("master gain", () => {
  it("streams a clamped optimistic value and commits it once", async () => {
    const { deps, handlers } = setup();
    api.updateSongRegionMasterGain.mockResolvedValue(snapshot(7));

    handlers.changeRegionMasterGain("r1", 3);
    expect(useTransportStore.getState().optimisticRegionMaster.r1).toBe(2);
    expect(deps.streamRegionMasterGain).toHaveBeenCalledWith("r1", 2);

    handlers.commitRegionMasterGain("r1");
    await flush();
    expect(api.updateSongRegionMasterGain).toHaveBeenCalledWith("r1", 2);
    expect(deps.applyPlaybackSnapshot).toHaveBeenCalledWith(snapshot(7));
    expect(useTransportStore.getState().optimisticRegionMaster.r1).toBeUndefined();
  });

  it("does not commit without an optimistic value", () => {
    const { handlers } = setup();
    handlers.commitRegionMasterGain("r1");
    expect(api.updateSongRegionMasterGain).not.toHaveBeenCalled();
  });
});

describe("dropOsFilesIntoSong", () => {
  it("refuses a mixed drop whole", () => {
    const { deps, handlers } = setup();
    handlers.dropOsFilesIntoSong("r1", [
      new File(["a"], "a.wav"),
      new File(["b"], "b.txt"),
    ]);
    expect(deps.setStatus).toHaveBeenCalledWith(
      expect.stringContaining("transport.status.unsupportedDrop"),
    );
    expect(deps.runAction).not.toHaveBeenCalled();
  });

  it("imports, files into the song folder and lands each clip at the song start", async () => {
    const { deps, handlers } = setup();
    const imported = asset("audio/a.wav", null);
    api.importAudioFilesFromBytes.mockResolvedValue({ assets: [imported], skipped: [] });
    api.moveLibraryAsset.mockResolvedValue([asset("audio/a.wav", "Canción 2")]);
    api.createClipsWithAutoTracks.mockResolvedValue(snapshot(3));

    // jsdom's File has no arrayBuffer(); the bytes are irrelevant here.
    const file = Object.assign(new File(["a"], "a.wav"), {
      arrayBuffer: async () => new ArrayBuffer(1),
    });
    handlers.dropOsFilesIntoSong("r2", [file]);
    await vi.waitFor(() => expect(deps.applyPlaybackSnapshot).toHaveBeenCalled());

    expect(api.createLibraryFolder).toHaveBeenCalledWith("Canción 2");
    expect(api.moveLibraryAsset).toHaveBeenCalledWith("audio/a.wav", "Canción 2");
    expect(api.createClipsWithAutoTracks).toHaveBeenCalledWith([
      { filePath: "audio/a.wav", timelineStartSeconds: 40 },
    ]);
    expect(deps.applyPlaybackSnapshot).toHaveBeenCalledWith(snapshot(3));
  });
});

describe("assignAssetsToSongFolder", () => {
  it("respects assets that already have a folder", async () => {
    const { handlers } = setup();
    await handlers.assignAssetsToSongFolder("Canción", [asset("x.wav", "Mía")]);
    expect(api.moveLibraryAsset).not.toHaveBeenCalled();
  });

  it("skips an empty song name", async () => {
    const { handlers } = setup();
    await handlers.assignAssetsToSongFolder("  ", [asset("x.wav", null)]);
    expect(api.createLibraryFolder).not.toHaveBeenCalled();
  });
});

describe("song package import", () => {
  it("appends the package on the first downbeat after the last song", async () => {
    const { deps, handlers } = setup();
    await handlers.runSongPackageImport("/x/song.ltpkg");
    // 70 s at 120 BPM 4/4 → bars every 2 s → next downbeat at 70 s.
    expect(deps.importSongPackageAt).toHaveBeenCalledWith("/x/song.ltpkg", 70);
  });

  it("anchors the first song of an empty project at 0", async () => {
    const empty = { regions: [], bpm: 120, timeSignature: "4/4", tempoMarkers: [], timeSignatureMarkers: [], clips: [] } as unknown as SongView;
    const { deps, handlers } = setup({ getSong: () => empty });
    await handlers.runSongPackageImport("/x/song.ltpkg");
    expect(deps.importSongPackageAt).toHaveBeenCalledWith("/x/song.ltpkg", 0);
  });

  it("the dialog entry point does nothing when cancelled", async () => {
    const { deps, handlers } = setup();
    dialog.open.mockResolvedValue(null);
    handlers.importSongPackageFromDialog();
    await flush();
    expect(deps.importSongPackageAt).not.toHaveBeenCalled();
  });
});

describe("playSong", () => {
  it("stopped: seeks to the song and plays", async () => {
    const { deps, handlers } = setup();
    api.playTransport.mockResolvedValue(snapshot(9));
    handlers.playSong("r2", "Canción 2");
    await flush();
    expect(deps.seek).toHaveBeenCalledWith(40);
    expect(deps.applyPlaybackSnapshot).toHaveBeenCalledWith(snapshot(9));
    expect(deps.scheduleSongJump).not.toHaveBeenCalled();
  });

  it("sounding: goes through the global song-jump scheduler", async () => {
    const { deps, handlers } = setup({ isPlaying: () => true });
    handlers.songAction(region("r2", "Canción 2", 40, 70) as never);
    await flush();
    expect(deps.scheduleSongJump).toHaveBeenCalledWith("r2", "Canción 2");
    expect(deps.seek).not.toHaveBeenCalled();
  });
});

describe("cueSong and seekTo", () => {
  it("cue seeks to the song start only while stopped", async () => {
    const stopped = setup();
    stopped.handlers.cueSong("r2");
    await flush();
    expect(stopped.deps.seek).toHaveBeenCalledWith(40);

    const sounding = setup({ isPlaying: () => true });
    sounding.handlers.cueSong("r2");
    await flush();
    expect(sounding.deps.seek).not.toHaveBeenCalled();
  });

  it("seekTo goes through the panel's (coalesced) seek", async () => {
    const { deps, handlers } = setup();
    handlers.seekTo(12.5);
    await flush();
    expect(deps.seek).toHaveBeenCalledWith(12.5);
  });
});

describe("one-line actions", () => {
  it("reorder, chart, cancel, vamp and marker go through runAction", async () => {
    const { deps, handlers } = setup();
    api.reorderSongRegion.mockResolvedValue(snapshot(1));
    api.setSongRegionChart.mockResolvedValue(snapshot(2));
    api.cancelMarkerJump.mockResolvedValue(snapshot(3));

    handlers.reorderSong("r2", 0);
    await handlers.setSongChart("r1", null);
    handlers.cancelPendingJump();
    handlers.toggleVamp();
    const marker = { id: "m1" } as never;
    handlers.markerAction(marker);
    await flush();

    expect(api.reorderSongRegion).toHaveBeenCalledWith("r2", 0);
    expect(api.setSongRegionChart).toHaveBeenCalledWith("r1", null);
    expect(deps.applyPlaybackSnapshot).toHaveBeenCalledWith(snapshot(3));
    expect(deps.setStatus).toHaveBeenCalledWith(
      expect.stringContaining("transport.status.jumpCancelled"),
    );
    expect(deps.toggleVamp).toHaveBeenCalled();
    expect(deps.markerPrimaryAction).toHaveBeenCalledWith(marker);
    expect(deps.runAction).toHaveBeenCalledTimes(5);
  });
});
