import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LibraryAssetSummary,
  LibraryImportResult,
} from "@libretracks/shared/models";
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

/** The backend returns what went in AND what it had to leave out; most tests
 * only care about the first half. */
function importedOk(...assets: LibraryAssetSummary[]): LibraryImportResult {
  return { assets, skipped: [] };
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
        return importedOk(...imported);
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
        return importedOk(asset("b.wav"));
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
      importFn: async () => importedOk(asset("c.wav")),
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
      importFn: async () => importedOk(asset("e.wav")),
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
      importFn: async () => importedOk(asset("f.wav")),
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

  it("reports the files it had to skip instead of a plain success", async () => {
    seedPending(["p1", "p2"]);
    const skipped: string[] = [];
    let status = "";

    await runAudioImportPipeline({
      pendingIds: ["p1", "p2"],
      importFn: async () => ({
        assets: [asset("p1.wav")],
        skipped: [
          {
            fileName: "p2.ogg",
            sourcePath: "C:/audio/p2.ogg",
            reason: "unsupported audio format for file: C:/audio/p2.ogg",
          },
        ],
      }),
      mergeLibraryAssets: () => {},
      refreshLibraryState: async () => {},
      setStatus: (next) => {
        status = next;
      },
      successMessage: () => "todo bien",
      reportSkipped: (entries) => {
        skipped.push(...entries.map((entry) => entry.fileName));
      },
    });

    // The good file went in, so the placeholders are gone either way...
    expect(statusOf("p1")).toBeUndefined();
    expect(statusOf("p2")).toBeUndefined();
    // ...but the caller hears about the one that did not, and the "all good"
    // message never claims otherwise.
    expect(skipped).toEqual(["p2.ogg"]);
    expect(status).not.toBe("todo bien");
  });

  it("clears the placeholders a previous failed import left behind", async () => {
    // A failed import keeps its placeholders until the user acknowledges the
    // dialog. Without a sweep at the start of the next one, importing a WAV
    // after a rejected OGG reported the OGG's error all over again.
    seedPending(["stale"]);
    useTransportStore
      .getState()
      .markPendingAudioImportsFailed(["stale"], "unsupported audio format");
    expect(statusOf("stale")).toBe("failed");

    seedPending(["fresh"]);
    await runAudioImportPipeline({
      pendingIds: ["fresh"],
      importFn: async () => importedOk(asset("fresh.wav")),
      mergeLibraryAssets: () => {},
      refreshLibraryState: async () => {},
      setStatus: () => {},
      successMessage: () => "ok",
    });

    expect(statusOf("stale")).toBeUndefined();
    expect(statusOf("fresh")).toBeUndefined();
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
      importFn: async () => importedOk(asset("h.wav")),
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
