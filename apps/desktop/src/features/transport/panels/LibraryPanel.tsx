import { useTranslation } from "react-i18next";

import type { LibraryImportProgressEvent } from "../desktopApi";
import { libraryAssetFileName } from "../helpers";
import { LibrarySidebarPanel } from "../LibrarySidebarPanel";
import type { PendingLibraryAssetSummary } from "../pendingAudioImports";
import type { InternalLibraryPointerDrag, SidebarTab } from "../types";

type LibraryPanelProps = {
  activeSidebarTab: SidebarTab | null;
  assets: PendingLibraryAssetSummary[];
  folders: string[];
  isLoading: boolean;
  isImporting: boolean;
  importProgress: LibraryImportProgressEvent | null;
  deletingFilePath: string | null;
  canImport: boolean;
  internalLibraryPointerDrag: InternalLibraryPointerDrag | null;
  onLocateAsset: (filePath: string) => void;
  onPointerDragStart: (args: {
    payload: Array<{ file_path: string; durationSeconds: number }>;
    origin: { x: number; y: number };
    current: { x: number; y: number };
  }) => void;
  onImport: () => void;
  onCreateFolder: () => void;
  onMoveAssetsToFolder: (filePaths: string[], folderPath: string | null) => void;
  onRenameFolder: (folderPath: string) => void;
  onDeleteFolder: (folderPath: string) => void;
  onDeleteRequested: (assets: PendingLibraryAssetSummary[]) => void;
  onAddSelectionToTimeline?: (assets: PendingLibraryAssetSummary[]) => void;
};

export function LibraryPanel({
  activeSidebarTab,
  assets,
  folders,
  isLoading,
  isImporting,
  importProgress,
  deletingFilePath,
  canImport,
  internalLibraryPointerDrag,
  onLocateAsset,
  onPointerDragStart,
  onImport,
  onCreateFolder,
  onMoveAssetsToFolder,
  onRenameFolder,
  onDeleteFolder,
  onDeleteRequested,
  onAddSelectionToTimeline,
}: LibraryPanelProps) {
  const { t } = useTranslation();
  const dragTargetFolderPath =
    internalLibraryPointerDrag?.hover?.kind === "library-folder"
      ? internalLibraryPointerDrag.hover.folderPath
      : undefined;

  const dragCount = internalLibraryPointerDrag?.payload.length ?? 0;
  const dragTitle =
    dragCount === 1 && internalLibraryPointerDrag
      ? t("library.dragGhostSingle", {
          name: libraryAssetFileName(
            internalLibraryPointerDrag.payload[0].file_path,
          ),
        })
      : t("library.dragGhostMultiple", { count: dragCount });
  // Second line follows where the drop will land: a virtual folder (named, or
  // "root/unfiled" when folderPath is null) vs. the timeline. This is the
  // visual confirmation of *where the assets are going* while dragging.
  const dragHint = (() => {
    const hover = internalLibraryPointerDrag?.hover;
    if (hover?.kind === "library-folder") {
      return t("library.dragHintFolder", {
        folder: hover.folderPath || t("library.rootFolder"),
      });
    }
    return dragCount === 1
      ? t("library.dragHintTimeline")
      : t("library.dragHintTimelineMultiple");
  })();
  const isFolderTarget =
    internalLibraryPointerDrag?.hover?.kind === "library-folder";

  return (
    <>
      {activeSidebarTab === "library" ? (
        <LibrarySidebarPanel
          assets={assets}
          folders={folders}
          isLoading={isLoading}
          isImporting={isImporting}
          importProgress={importProgress}
          deletingFilePath={deletingFilePath}
          canImport={canImport}
          dragTargetFolderPath={dragTargetFolderPath}
          onLocateAsset={onLocateAsset}
          onPointerDragStart={onPointerDragStart}
          onImport={onImport}
          onCreateFolder={onCreateFolder}
          onMoveAssetsToFolder={onMoveAssetsToFolder}
          onRenameFolder={onRenameFolder}
          onDeleteFolder={onDeleteFolder}
          onDeleteRequested={onDeleteRequested}
          onAddSelectionToTimeline={onAddSelectionToTimeline}
        />
      ) : null}
      {internalLibraryPointerDrag?.isDragging ? (
        <div
          aria-hidden="true"
          className="lt-library-drag-ghost"
          data-folder-target={isFolderTarget ? "true" : undefined}
          style={{
            left: internalLibraryPointerDrag.current.x + 16,
            top: internalLibraryPointerDrag.current.y + 16,
          }}
        >
          <span className="lt-library-drag-ghost-badge">
            <span className="material-symbols-outlined">drag_pan</span>
            {dragCount > 1 ? (
              <span className="lt-library-drag-ghost-count">{dragCount}</span>
            ) : null}
          </span>
          <span className="lt-library-drag-ghost-copy">
            <strong>{dragTitle}</strong>
            <span>{dragHint}</span>
          </span>
        </div>
      ) : null}
    </>
  );
}
