import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryAssetSummary } from "@libretracks/shared/models";
import { runAudioImportPipeline } from "./importPipeline";
import { useTransportStore } from "../store";

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
});
