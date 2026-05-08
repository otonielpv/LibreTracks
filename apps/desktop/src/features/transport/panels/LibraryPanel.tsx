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
}: LibraryPanelProps) {
  const dragTargetFolderPath =
    internalLibraryPointerDrag?.hover?.kind === "library-folder"
      ? internalLibraryPointerDrag.hover.folderPath
      : undefined;

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
        />
      ) : null}
      {internalLibraryPointerDrag?.isDragging ? (
        <div
          aria-hidden="true"
          style={{
            position: "fixed",
            left: internalLibraryPointerDrag.current.x + 18,
            top: internalLibraryPointerDrag.current.y + 18,
            zIndex: 9999,
            pointerEvents: "none",
            padding: "10px 12px",
            borderRadius: 12,
            background: "rgba(14, 18, 28, 0.92)",
            border: "1px solid rgba(138, 161, 255, 0.35)",
            boxShadow: "0 16px 40px rgba(0, 0, 0, 0.28)",
            color: "#f5f7ff",
            minWidth: 160,
          }}
        >
          <strong style={{ display: "block", fontSize: 12, marginBottom: 4 }}>
            {internalLibraryPointerDrag.payload.length === 1
              ? libraryAssetFileName(
                  internalLibraryPointerDrag.payload[0].file_path,
                )
              : `${internalLibraryPointerDrag.payload.length} assets`}
          </strong>
          <span style={{ display: "block", fontSize: 11, opacity: 0.76 }}>
            Drop on timeline to place clip
            {internalLibraryPointerDrag.payload.length === 1 ? "" : "s"}
          </span>
        </div>
      ) : null}
    </>
  );
}
