import { describe, expect, it } from "vitest";

import type { LibraryAssetSummary } from "../desktopApi";
import {
  createPendingAudioImportsFromPaths,
  mergeLibraryAssetsByFilePath,
  mergePendingClipsByTrack,
} from "./pendingAudioImports";

function asset(overrides: Partial<LibraryAssetSummary> & Pick<LibraryAssetSummary, "fileName" | "filePath">): LibraryAssetSummary {
  return {
    fileName: overrides.fileName,
    filePath: overrides.filePath,
    durationSeconds: overrides.durationSeconds ?? 1,
    isMissing: overrides.isMissing ?? false,
    folderPath: overrides.folderPath ?? null,
  };
}

describe("pendingAudioImports helpers", () => {
  it("preserves incoming assets over stale base entries with the same file path", () => {
    const baseAssets = [asset({ fileName: "Guide.wav", filePath: "/audio/guide.wav", durationSeconds: 4 })];
    const incomingAssets = [
      asset({ fileName: "Guide.wav", filePath: "/audio/guide.wav", durationSeconds: 12 }),
    ];

    expect(mergeLibraryAssetsByFilePath(baseAssets, incomingAssets)).toEqual([
      asset({ fileName: "Guide.wav", filePath: "/audio/guide.wav", durationSeconds: 12 }),
    ]);
  });

  it("keeps merged assets sorted by folder and file name", () => {
    const baseAssets = [asset({ fileName: "Kick.wav", filePath: "/loops/kick.wav", folderPath: "Drums" })];
    const incomingAssets = [
      asset({ fileName: "Bass.wav", filePath: "/bass/bass.wav", folderPath: "Bass" }),
      asset({ fileName: "Snare.wav", filePath: "/loops/snare.wav", folderPath: "Drums" }),
    ];

    expect(mergeLibraryAssetsByFilePath(baseAssets, incomingAssets).map((item) => item.fileName)).toEqual([
      "Bass.wav",
      "Kick.wav",
      "Snare.wav",
    ]);
  });

  it("omits timeline placeholder clips for library-only imports", () => {
    // Regression: the library "import audio" dialog creates pending imports
    // with showInTimeline=false. They must not render a placeholder clip in the
    // timeline (which would flash in at position 0 and vanish on completion).
    const libraryOnly = createPendingAudioImportsFromPaths(
      ["/audio/guide.wav"],
      0,
      false,
    );

    expect(mergePendingClipsByTrack({}, libraryOnly)).toEqual({});
  });

  it("renders a timeline placeholder clip for drag imports", () => {
    const dragImport = createPendingAudioImportsFromPaths(["/audio/loop.wav"], 0);
    const merged = mergePendingClipsByTrack({}, dragImport);

    expect(merged[dragImport[0].temporaryTrackId]).toHaveLength(1);
  });
});