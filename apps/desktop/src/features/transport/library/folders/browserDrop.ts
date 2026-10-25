import {
  importAudioFilesFromPaths,
  listLibraryFolderAudio,
  type LibraryAssetSummary,
} from "../../desktopApi";
import { libraryAssetFileName } from "../../helpers";
import { classifyDroppedPaths, resolveFolderDropLayout } from "../dragDrop";
import type { LibraryDragDrop } from "../libraryDragDrop";

export type BrowserDropDeps = {
  dragDrop: () => Pick<
    LibraryDragDrop,
    | "resolveTimelineDropFromClientPoint"
    | "handleNativeExternalTimelineDrop"
    | "dropLibraryFolder"
    | "previewDropAtClientPoint"
    | "clearDropPreview"
    | "resolveCompactRegionAtPoint"
    | "dropPathsIntoSong"
    | "addLibraryAssetsToSong"
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
 * folder of the classic library; its audio may sit in a subfolder (see
 * list_library_folder_audio).
 *
 * Over a song of Compacta or Setlist the drop goes into that song (its start,
 * new tracks), like a drop from the file manager there.
 *
 * Both return false when the pointer is over neither, so the caller can treat
 * the gesture as cancelled.
 */
export function createBrowserDrop(deps: BrowserDropDeps) {
  function placePaths(paths: string[], seconds: number, trackId: string | null) {
    deps
      .dragDrop()
      .handleNativeExternalTimelineDrop(classifyDroppedPaths(paths), seconds, trackId);
  }

  /** The song (of Compacta or Setlist) under the pointer, if any. */
  function songAt(clientX: number, clientY: number): string | null {
    const hit = deps.dragDrop().resolveCompactRegionAtPoint(clientX, clientY);
    return hit.hit ? hit.regionId : null;
  }

  function placeFolder(args: {
    folderPath: string;
    folderName: string;
    seconds: number;
    layout: "horizontal" | "vertical";
    /** Into this existing song instead of a new song on the timeline. */
    regionId?: string;
  }) {
    if (!deps.hasSession()) {
      deps.setStatus(deps.t("transport.status.importRequiresSession"));
      return;
    }
    void deps.runAction(async () => {
      deps.setStatus(deps.t("library.folders.importingFolder", { name: args.folderName }));
      const audio = await listLibraryFolderAudio(args.folderPath);
      if (audio.truncated) {
        // Not one song: a folder of several (the MultiTracks folder itself).
        deps.setStatus(
          deps.t("library.folders.tooMuchAudio", { name: args.folderName, count: audio.paths.length }),
        );
        return;
      }
      if (!audio.paths.length) {
        deps.setStatus(deps.t("library.folders.noAudioInFolder", { name: args.folderName }));
        return;
      }
      const imported = await importAudioFilesFromPaths(
        audio.paths.map((path) => ({
          fileName: libraryAssetFileName(path),
          sourcePath: path,
        })),
      );
      deps.mergeLibraryAssets(imported.assets);
      if (args.regionId) {
        deps.dragDrop().addLibraryAssetsToSong(
          args.regionId,
          imported.assets.map((asset) => ({ filePath: asset.filePath, durationSeconds: asset.durationSeconds })),
        );
        return;
      }
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
    const regionId = songAt(clientX, clientY);
    if (regionId) return deps.dragDrop().dropPathsIntoSong(regionId, classifyDroppedPaths(paths));
    const drop = deps.dragDrop().resolveTimelineDropFromClientPoint(clientX, clientY);
    if (!drop.isOverTimeline) return false;
    placePaths(paths, drop.dropSeconds, drop.targetTrackId);
    return true;
  }

  function dropFolderAt(args: {
    folderPath: string;
    folderName: string;
    clientX: number;
    clientY: number;
    ctrlKey: boolean;
    metaKey: boolean;
  }): boolean {
    const regionId = songAt(args.clientX, args.clientY);
    if (regionId) {
      placeFolder({ folderPath: args.folderPath, folderName: args.folderName, seconds: 0, layout: "vertical", regionId });
      return true;
    }
    const drop = deps.dragDrop().resolveTimelineDropFromClientPoint(args.clientX, args.clientY);
    if (!drop.isOverTimeline) return false;
    placeFolder({
      folderPath: args.folderPath,
      folderName: args.folderName,
      seconds: drop.dropSeconds,
      layout: resolveFolderDropLayout(args.ctrlKey, args.metaKey),
    });
    return true;
  }

  /** While dragging: where it would land, drawn on the timeline (the guide
   * line and badge of a drop from the file manager). A folder is a song of
   * audio. */
  function previewAt(item: { kind: "files"; paths: string[] } | { kind: "folder" }, clientX: number, clientY: number) {
    const kind = item.kind === "folder" ? "audio" : classifyDroppedPaths(item.paths).kind;
    const count = item.kind === "folder" ? 1 : item.paths.length;
    deps.dragDrop().previewDropAtClientPoint(clientX, clientY, kind, count);
  }

  function clearPreview() {
    deps.dragDrop().clearDropPreview();
  }

  /** Touch: no drag, so the selection lands at the playhead on new tracks. */
  function addPathsAtPlayhead(paths: string[]) {
    if (paths.length) placePaths(paths, deps.getPlayheadSeconds(), null);
  }

  /** Touch: a folder becomes a song starting at the playhead. */
  function addFolderAtPlayhead(folderPath: string, folderName: string) {
    placeFolder({
      folderPath,
      folderName,
      seconds: deps.getPlayheadSeconds(),
      layout: resolveFolderDropLayout(false, false),
    });
  }

  return { dropPathsAt, dropFolderAt, addPathsAtPlayhead, addFolderAtPlayhead, previewAt, clearPreview };
}

export type BrowserDrop = ReturnType<typeof createBrowserDrop>;
