import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LibraryAssetSummary } from "@libretracks/shared/models";
import { useLibraryActions } from "./useLibraryActions";

const getLibraryAssets = vi.fn();
const getLibraryFolders = vi.fn();
const listenToLibraryImportProgress = vi.fn();

vi.mock("../desktopApi", () => ({
  isTauriApp: false, // skip the Tauri-only event subscription effect
  getLibraryAssets: () => getLibraryAssets(),
  getLibraryFolders: () => getLibraryFolders(),
  listenToLibraryImportProgress: (...a: unknown[]) =>
    listenToLibraryImportProgress(...a),
}));

function asset(filePath: string): LibraryAssetSummary {
  return {
    fileName: filePath.split("/").at(-1) ?? filePath,
    filePath,
    durationSeconds: 1,
    isMissing: false,
  };
}

beforeEach(() => {
  getLibraryAssets.mockReset();
  getLibraryFolders.mockReset();
  getLibraryAssets.mockResolvedValue([]);
  getLibraryFolders.mockResolvedValue([]);
});

afterEach(() => vi.clearAllMocks());

describe("useLibraryActions", () => {
  it("starts empty", () => {
    const { result } = renderHook(() =>
      useLibraryActions({ playbackSongDir: null }),
    );
    expect(result.current.libraryAssets).toEqual([]);
    expect(result.current.libraryFolders).toEqual([]);
    expect(result.current.isLibraryLoading).toBe(false);
  });

  it("loadLibraryState short-circuits without a song dir", async () => {
    const { result } = renderHook(() =>
      useLibraryActions({ playbackSongDir: null }),
    );
    const state = await result.current.loadLibraryState();
    expect(state).toEqual({ assets: [], folders: [] });
    expect(getLibraryAssets).not.toHaveBeenCalled();
  });

  it("refreshLibraryState pulls assets and folders for a song dir", async () => {
    getLibraryAssets.mockResolvedValue([asset("audio/a.wav")]);
    getLibraryFolders.mockResolvedValue(["Drums"]);
    const { result } = renderHook(() =>
      useLibraryActions({ playbackSongDir: "C:/song" }),
    );

    await act(async () => {
      await result.current.refreshLibraryState();
    });

    expect(result.current.libraryAssets.map((a) => a.filePath)).toEqual([
      "audio/a.wav",
    ]);
    expect(result.current.libraryFolders).toEqual(["Drums"]);
  });

  it("ignores a stale refresh when a newer one supersedes it", async () => {
    // First call resolves slowly with stale data; a second, faster call wins.
    let resolveSlow: (v: LibraryAssetSummary[]) => void = () => {};
    getLibraryAssets
      .mockImplementationOnce(
        () =>
          new Promise<LibraryAssetSummary[]>((resolve) => {
            resolveSlow = resolve;
          }),
      )
      .mockResolvedValueOnce([asset("audio/fresh.wav")]);

    const { result } = renderHook(() =>
      useLibraryActions({ playbackSongDir: "C:/song" }),
    );

    let slow: Promise<unknown>;
    await act(async () => {
      slow = result.current.refreshLibraryState();
      await result.current.refreshLibraryState();
    });
    await act(async () => {
      resolveSlow([asset("audio/stale.wav")]);
      await slow;
    });

    // The fresh result must remain; the late stale one is discarded.
    expect(result.current.libraryAssets.map((a) => a.filePath)).toEqual([
      "audio/fresh.wav",
    ]);
  });

  it("mergeLibraryAssets adds imported assets and dedupes by file path", async () => {
    getLibraryAssets.mockResolvedValue([asset("audio/a.wav")]);
    const { result } = renderHook(() =>
      useLibraryActions({ playbackSongDir: "C:/song" }),
    );
    await act(async () => {
      await result.current.refreshLibraryState();
    });

    act(() => {
      result.current.mergeLibraryAssets([
        asset("audio/a.wav"),
        asset("audio/b.wav"),
      ]);
    });

    const paths = result.current.libraryAssets.map((a) => a.filePath).sort();
    expect(paths).toEqual(["audio/a.wav", "audio/b.wav"]);
  });

  it("mergeLibraryAssets is a no-op for an empty list", async () => {
    const { result } = renderHook(() =>
      useLibraryActions({ playbackSongDir: "C:/song" }),
    );
    act(() => {
      result.current.mergeLibraryAssets([]);
    });
    expect(result.current.libraryAssets).toEqual([]);
  });
});
