import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryAssetSummary } from "@libretracks/shared/models";
import { importErrorMessage, runAudioImportPipeline } from "./importPipeline";
import { forgetLibraryAssets } from "../desktopApi";
import { useTransportStore } from "../store";

vi.mock("../desktopApi", () => ({
  forgetLibraryAssets: vi.fn(async () => []),
}));

function asset(fileName: string): LibraryAssetSummary {
  return {
    fileName,
    filePath: `audio/${fileName}`,
    durationSeconds: 1,
    isMissing: false,
    folderPath: null,
  };
}

function seedPending(ids: string[]) {
  useTransportStore.getState().addPendingAudioImports(
    ids.map((id) => ({
      id,
      fileName: `${id}.wav`,
      temporaryAssetId: `pending-asset-${id}`,
      temporaryTrackId: `pending-track-${id}`,
      temporaryClipId: `pending-clip-${id}`,
      dropSeconds: 0,
      status: "queued",
      showInTimeline: true,
    })),
  );
}

function statusOf(id: string): string | undefined {
  return useTransportStore
    .getState()
    .pendingAudioImports.find((item) => item.id === id)?.status;
}

describe("runAudioImportPipeline", () => {
  beforeEach(() => {
    // Clear any leftover pending imports between tests.
    const ids = useTransportStore
      .getState()
      .pendingAudioImports.map((item) => item.id);
    useTransportStore.getState().removePendingAudioImports(ids);
    vi.mocked(forgetLibraryAssets).mockClear();
  });

  it("walks importing->metadata->analyzing, runs the tail, then clears pending", async () => {
    seedPending(["a"]);
    const order: string[] = [];
    const imported = [asset("a.wav")];

    await runAudioImportPipeline({
      pendingIds: ["a"],
      importFn: async () => {
        order.push(`status:${statusOf("a")}`);
        return imported;
      },
      onImported: async (assets) => {
        order.push(`tail:${statusOf("a")}:${assets.length}`);
      },
      mergeLibraryAssets: () => order.push("merge"),
      refreshLibraryState: async () => order.push("refresh"),
      setStatus: (s) => order.push(`done:${s}`),
      successMessage: (assets) => `ok ${assets.length}`,
    });

    expect(order).toEqual([
      "status:importing",
      "merge",
      "refresh",
      "tail:analyzing:1",
      "done:ok 1",
    ]);
    // Pending placeholder removed on success.
    expect(statusOf("a")).toBeUndefined();
  });

  it("runs beforeImport under 'reading' before the import", async () => {
    seedPending(["b"]);
    const order: string[] = [];

    await runAudioImportPipeline({
      pendingIds: ["b"],
      beforeImport: async () => {
        order.push(`reading:${statusOf("b")}`);
      },
      importFn: async () => {
        order.push(`importing:${statusOf("b")}`);
        return [asset("b.wav")];
      },
      mergeLibraryAssets: () => {},
      refreshLibraryState: async () => {},
      setStatus: () => {},
      successMessage: () => "ok",
    });

    expect(order).toEqual(["reading:reading", "importing:importing"]);
  });

  it("works without an onImported tail (library-only import)", async () => {
    seedPending(["c"]);
    let tailRan = false;

    await runAudioImportPipeline({
      pendingIds: ["c"],
      importFn: async () => [asset("c.wav")],
      mergeLibraryAssets: () => {},
      refreshLibraryState: async () => {},
      setStatus: () => {},
      successMessage: () => "ok",
    });

    expect(tailRan).toBe(false);
    expect(statusOf("c")).toBeUndefined();
  });

  it("marks pending failed and surfaces the error message on import failure", async () => {
    seedPending(["d"]);
    let statusMessage = "";

    await runAudioImportPipeline({
      pendingIds: ["d"],
      importFn: async () => {
        throw new Error("disk full");
      },
      mergeLibraryAssets: () => {},
      refreshLibraryState: async () => {},
      setStatus: (s) => {
        statusMessage = s;
      },
      successMessage: () => "ok",
    });

    expect(statusMessage).toBe("disk full");
    expect(statusOf("d")).toBe("failed");
  });

  /// Regression: Tauri rejects `invoke` with a plain STRING, not an `Error`.
  /// The old `error instanceof Error ? … : <generic>` check therefore threw the
  /// backend's explanation away on every real rejection and always showed
  /// "Could not import audio files. Please check the files and try again." —
  /// so a clip that simply did not fit between two songs was reported as if the
  /// audio file itself were broken.
  it("keeps the backend reason when the rejection is a plain string", async () => {
    seedPending(["e"]);
    let statusMessage = "";
    const backendReason =
      "'Bajo.mp3' (4:00) no cabe en este hueco.\n\nEl hueco solo tiene 2:40.";

    await runAudioImportPipeline({
      pendingIds: ["e"],
      importFn: async () => [asset("e.wav")],
      onImported: async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw backendReason;
      },
      mergeLibraryAssets: () => {},
      refreshLibraryState: async () => {},
      setStatus: (s) => {
        statusMessage = s;
      },
      successMessage: () => "ok",
    });

    expect(statusMessage).toBe(backendReason);
    expect(
      useTransportStore
        .getState()
        .pendingAudioImports.find((item) => item.id === "e")?.error,
    ).toBe(backendReason);
  });

  /// Files are registered in the library BEFORE they are placed on the
  /// timeline, so a drop the region rules reject used to leave its audio in the
  /// library while telling the user the import had failed.
  it("rolls the imported assets back out of the library when placement fails", async () => {
    seedPending(["f"]);

    await runAudioImportPipeline({
      pendingIds: ["f"],
      importFn: async () => [asset("f.wav")],
      onImported: async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "no cabe en este hueco";
      },
      mergeLibraryAssets: () => {},
      refreshLibraryState: async () => {},
      setStatus: () => {},
      successMessage: () => "ok",
    });

    expect(forgetLibraryAssets).toHaveBeenCalledWith(["audio/f.wav"]);
  });

  it("keeps the library untouched when the import itself never succeeded", async () => {
    seedPending(["g"]);

    await runAudioImportPipeline({
      pendingIds: ["g"],
      importFn: async () => {
        throw new Error("disk full");
      },
      onImported: async () => {},
      mergeLibraryAssets: () => {},
      refreshLibraryState: async () => {},
      setStatus: () => {},
      successMessage: () => "ok",
    });

    // Nothing was imported, so there is nothing to roll back.
    expect(forgetLibraryAssets).not.toHaveBeenCalled();
  });

  it("does not roll back after a successful placement", async () => {
    seedPending(["h"]);

    await runAudioImportPipeline({
      pendingIds: ["h"],
      importFn: async () => [asset("h.wav")],
      onImported: async () => {},
      mergeLibraryAssets: () => {},
      refreshLibraryState: async () => {},
      setStatus: () => {},
      successMessage: () => "ok",
    });

    expect(forgetLibraryAssets).not.toHaveBeenCalled();
  });

  describe("importErrorMessage", () => {
    it("passes through the reason for every shape a rejection can take", () => {
      expect(importErrorMessage("no cabe aqui")).toBe("no cabe aqui");
      expect(importErrorMessage(new Error("disk full"))).toBe("disk full");
      expect(importErrorMessage({ message: "from an object" })).toBe(
        "from an object",
      );
    });

    it("falls back only when there is no usable text", () => {
      const generic = "Could not import audio files. Please check the files and try again.";
      expect(importErrorMessage("")).toBe(generic);
      expect(importErrorMessage("   ")).toBe(generic);
      expect(importErrorMessage(new Error(""))).toBe(generic);
      expect(importErrorMessage(null)).toBe(generic);
      expect(importErrorMessage(undefined)).toBe(generic);
      expect(importErrorMessage({ code: 42 })).toBe(generic);
    });
  });
});
