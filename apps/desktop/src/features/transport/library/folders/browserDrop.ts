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
  /** Where "add to timeline" lands on touch, where there is no drag. */
  getPlayheadSeconds: () => number;
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
  function placePaths(paths: string[], seconds: number, trackId: string | null) {
    deps
      .dragDrop()
      .handleNativeExternalTimelineDrop(classifyDroppedPaths(paths), seconds, trackId);
  }

  function placeFolder(args: {
    folderName: string;
    audioPaths: string[];
    seconds: number;
    layout: "horizontal" | "vertical";
  }) {
    if (!deps.hasSession()) {
      deps.setStatus(deps.t("transport.status.importRequiresSession"));
      return;
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
        timelineStartSeconds: args.seconds,
        layout: args.layout,
      });
    });
  }

  function dropPathsAt(paths: string[], clientX: number, clientY: number): boolean {
    if (!paths.length) return false;
    const drop = deps.dragDrop().resolveTimelineDropFromClientPoint(clientX, clientY);
    if (!drop.isOverTimeline) return false;
    placePaths(paths, drop.dropSeconds, drop.targetTrackId);
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
    placeFolder({
      folderName: args.folderName,
      audioPaths: args.audioPaths,
      seconds: drop.dropSeconds,
      layout: resolveFolderDropLayout(args.ctrlKey, args.metaKey),
    });
    return true;
  }

  /** Touch: no drag, so the selection lands at the playhead on new tracks. */
  function addPathsAtPlayhead(paths: string[]) {
    if (paths.length) placePaths(paths, deps.getPlayheadSeconds(), null);
  }

  /** Touch: a folder becomes a song starting at the playhead. */
  function addFolderAtPlayhead(folderName: string, audioPaths: string[]) {
    placeFolder({
      folderName,
      audioPaths,
      seconds: deps.getPlayheadSeconds(),
      layout: resolveFolderDropLayout(false, false),
    });
  }

  return { dropPathsAt, dropFolderAt, addPathsAtPlayhead, addFolderAtPlayhead };
}

export type BrowserDrop = ReturnType<typeof createBrowserDrop>;
