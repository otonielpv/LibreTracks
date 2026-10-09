import { importAudioFilesFromPaths, type LibraryAssetSummary } from "../../desktopApi";
import { libraryAssetFileName } from "../../helpers";
import { classifyDroppedPaths, resolveFolderDropLayout } from "../dragDrop";
import type { LibraryDragDrop } from "../libraryDragDrop";

export type BrowserDropDeps = {
  dragDrop: () => Pick<
    LibraryDragDrop,
    "resolveTimelineDropFromClientPoint" | "handleNativeExternalTimelineDrop" | "dropLibraryFolder"
  >;
  hasSession: () => boolean;
  runAction: (action: () => Promise<void>) => Promise<unknown>;
  mergeLibraryAssets: (assets: LibraryAssetSummary[]) => void;
  setStatus: (message: string) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
};

/**
 * Drops from the folder library onto the timeline. The files come straight
 * from the user's disk, so they take the same road as files dropped from the
 * OS file manager (import by reference, then place) — no second import path to
 * keep in step. A folder becomes one song named after it, like dropping a
 * folder of the classic library.
 *
 * Both return false when the pointer is not over the timeline, so the caller
 * can treat the gesture as cancelled.
 */
export function createBrowserDrop(deps: BrowserDropDeps) {
  function dropPathsAt(paths: string[], clientX: number, clientY: number): boolean {
    if (!paths.length) return false;
    const drop = deps.dragDrop().resolveTimelineDropFromClientPoint(clientX, clientY);
    if (!drop.isOverTimeline) return false;
    deps
      .dragDrop()
      .handleNativeExternalTimelineDrop(
        classifyDroppedPaths(paths),
        drop.dropSeconds,
        drop.targetTrackId,
      );
    return true;
  }

  function dropFolderAt(args: {
    folderName: string;
    audioPaths: string[];
    clientX: number;
    clientY: number;
    ctrlKey: boolean;
    metaKey: boolean;
  }): boolean {
    const drop = deps.dragDrop().resolveTimelineDropFromClientPoint(args.clientX, args.clientY);
    if (!drop.isOverTimeline) return false;
    if (!deps.hasSession()) {
      deps.setStatus(deps.t("transport.status.importRequiresSession"));
      return true;
    }
    void deps.runAction(async () => {
      deps.setStatus(deps.t("library.folders.importingFolder", { name: args.folderName }));
      const imported = args.audioPaths.length
        ? await importAudioFilesFromPaths(
            args.audioPaths.map((path) => ({
              fileName: libraryAssetFileName(path),
              sourcePath: path,
            })),
          )
        : { assets: [], skipped: [] };
      deps.mergeLibraryAssets(imported.assets);
      await deps.dragDrop().dropLibraryFolder({
        payload: imported.assets.map((asset) => ({
          file_path: asset.filePath,
          durationSeconds: asset.durationSeconds,
        })),
        folderName: args.folderName,
        timelineStartSeconds: drop.dropSeconds,
        layout: resolveFolderDropLayout(args.ctrlKey, args.metaKey),
      });
    });
    return true;
  }

  return { dropPathsAt, dropFolderAt };
}

export type BrowserDrop = ReturnType<typeof createBrowserDrop>;
