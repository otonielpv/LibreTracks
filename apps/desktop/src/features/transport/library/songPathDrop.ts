import type { SkippedImport } from "@libretracks/shared/models";

import { createClipsWithAutoTracks, importAudioFilesFromPaths } from "../desktopApi";
import type { classifyDroppedPaths } from "./dragDrop";
import type { LibraryDragDropDeps } from "./libraryDragDrop";
import { routeCompactDroppedVideos } from "./videoDropRouting";

/**
 * Files from the disk dropped on a song of Compacta or Setlist (the OS file
 * manager and the folder library): audio is imported by reference and laid at
 * the song's start on new tracks; videos take the video route. False when
 * there is no song or the kind does not go into one.
 */
export function dropPathsIntoSong(
  deps: LibraryDragDropDeps,
  regionId: string | null,
  classification: ReturnType<typeof classifyDroppedPaths>,
  reportSkippedImports: (skipped: SkippedImport[]) => void,
): boolean {
  if (!regionId) return false;
  if (classification.kind === "audio") {
    const region = deps.song?.regions.find((r) => r.id === regionId);
    if (!region) return false;
    const dropSeconds = region.startSeconds;
    void deps.runAction(async () => {
      const payloads = classification.audioPaths.map((path) => ({
        fileName: path.split(/[\\/]/).pop() ?? path,
        sourcePath: path,
      }));
      const { assets: importedAssets, skipped } =
        await importAudioFilesFromPaths(payloads);
      reportSkippedImports(skipped);
      deps.mergeLibraryAssets(importedAssets);
      await deps.refreshLibraryState({ preserveAssets: importedAssets });
      if (importedAssets.length === 0) return;
      // Auto-organise: drop the freshly imported assets into the
      // song's Library folder (creating it if needed).
      await deps.assignAssetsToSongFolder(region.name, importedAssets);
      const snapshot = await createClipsWithAutoTracks(
        importedAssets.map((asset) => ({
          filePath: asset.filePath,
          timelineStartSeconds: dropSeconds,
        })),
      );
      deps.applyPlaybackSnapshot(snapshot);
      deps.setStatus(
        importedAssets.length === 1
          ? deps.t("transport.status.clipAdded", {
              name: importedAssets[0].fileName,
            })
          : deps.t("transport.status.clipsAdded", {
              count: importedAssets.length,
            }),
      );
    });
    return true;
  }
  return routeCompactDroppedVideos(deps, classification, deps.song, regionId);
}
