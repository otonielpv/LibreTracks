import type { LibraryAssetSummary } from "@libretracks/shared/models";

import type { LibraryClipPreviewState } from "../types";

/** The library folder list is modelled as plain virtual-folder path strings. */
type LibraryFolderSummary = string;

/**
 * Dependencies for the library mutation handlers (import / delete assets,
 * create / rename / delete / move folders). Extracted from TransportPanelContent
 * so the ~185 lines of asset-and-folder plumbing live next to the rest of the
 * library code rather than in the monolith.
 *
 * `getLibraryAssets` is a getter (not a snapshot): the async `runAction` bodies
 * iterate over the *current* asset list, so reading it lazily avoids capturing a
 * stale render value — the same reason the originals referenced the live state.
 */
export type LibraryHandlerDeps = {
  getPlaybackSongDir: () => string | null;
  getLibraryAssets: () => LibraryAssetSummary[];
  runAction: (action: () => Promise<void>) => Promise<void>;
  waitForUiPaint: () => Promise<void>;
  setStatus: (message: string) => void;
  setLibraryAssets: (assets: LibraryAssetSummary[]) => void;
  setLibraryFolders: (folders: LibraryFolderSummary[]) => void;
  setLibraryClipPreview: (
    update: (current: LibraryClipPreviewState[]) => LibraryClipPreviewState[],
  ) => void;
  setIsImportingLibrary: (importing: boolean) => void;
  setLibraryImportProgress: (progress: null) => void;
  setDeletingLibraryFilePath: (filePath: string | null) => void;
  loadLibraryState: () => Promise<{ folders: LibraryFolderSummary[] }>;
  t: (key: string, options?: Record<string, unknown>) => string;
  // Persistence API.
  importLibraryAssetsFromDialog: () => Promise<LibraryAssetSummary[] | null>;
  getLibraryFolders: () => Promise<LibraryFolderSummary[]>;
  deleteLibraryAsset: (filePath: string) => Promise<LibraryAssetSummary[]>;
  createLibraryFolder: (folderPath: string) => Promise<LibraryFolderSummary[]>;
  moveLibraryAsset: (
    filePath: string,
    newFolderPath: string | null,
  ) => Promise<LibraryAssetSummary[]>;
  renameLibraryFolder: (
    folderPath: string,
    nextFolderPath: string,
  ) => Promise<LibraryAssetSummary[]>;
  deleteLibraryFolder: (folderPath: string) => Promise<LibraryAssetSummary[]>;
  // Browser prompts (injected so the module is testable without a DOM global).
  confirm: (message: string) => Promise<boolean>;
  prompt: (message: string, defaultValue?: string) => Promise<string | null>;
};

export function createLibraryHandlers(deps: LibraryHandlerDeps) {
  const {
    getPlaybackSongDir,
    getLibraryAssets,
    runAction,
    waitForUiPaint,
    setStatus,
    setLibraryAssets,
    setLibraryFolders,
    setLibraryClipPreview,
    setIsImportingLibrary,
    setLibraryImportProgress,
    setDeletingLibraryFilePath,
    loadLibraryState,
    t,
    importLibraryAssetsFromDialog,
    getLibraryFolders,
    deleteLibraryAsset,
    createLibraryFolder,
    moveLibraryAsset,
    renameLibraryFolder,
    deleteLibraryFolder,
    confirm,
    prompt,
  } = deps;

  return {
    async handleImportLibraryAssetsClick() {
      if (!getPlaybackSongDir()) {
        setStatus(t("transport.status.importRequiresSession"));
        return;
      }

      setIsImportingLibrary(true);
      setLibraryImportProgress(null);
      setStatus(t("transport.status.libraryImportStarting"));
      await waitForUiPaint();
      await runAction(async () => {
        const assets = await importLibraryAssetsFromDialog();
        if (!assets) {
          setLibraryImportProgress(null);
          return;
        }

        setLibraryAssets(assets);
        setLibraryFolders(await getLibraryFolders());
        setStatus(
          t("transport.status.libraryUpdated", { count: assets.length }),
        );
      });
      setIsImportingLibrary(false);
      setLibraryImportProgress(null);
    },

    async handleDeleteLibraryAssets(assetsToDelete: LibraryAssetSummary[]) {
      const uniqueAssets = [
        ...new Map(
          assetsToDelete.map((asset) => [asset.filePath, asset]),
        ).values(),
      ];
      if (!uniqueAssets.length) {
        return;
      }

      const confirmationMessage =
        uniqueAssets.length === 1
          ? t("transport.confirm.deleteLibraryAsset", {
              name: uniqueAssets[0].fileName,
            })
          : t("transport.confirm.deleteLibraryAssets", {
              count: uniqueAssets.length,
            });
      if (!(await confirm(confirmationMessage))) {
        return;
      }

      try {
        await runAction(async () => {
          let nextAssets = getLibraryAssets();
          const deletedFilePaths = new Set(
            uniqueAssets.map((asset) => asset.filePath),
          );

          for (const asset of uniqueAssets) {
            setDeletingLibraryFilePath(asset.filePath);
            nextAssets = await deleteLibraryAsset(asset.filePath);
          }

          const { folders } = await loadLibraryState();
          setLibraryAssets(nextAssets);
          setLibraryFolders(folders);
          setLibraryClipPreview((current) =>
            current.filter(
              (preview) => !deletedFilePaths.has(preview.filePath),
            ),
          );
          setStatus(
            uniqueAssets.length === 1
              ? t("transport.status.libraryAssetDeleted", {
                  name: uniqueAssets[0].fileName,
                })
              : t("transport.status.libraryAssetsDeleted", {
                  count: uniqueAssets.length,
                }),
          );
        });
      } finally {
        setDeletingLibraryFilePath(null);
      }
    },

    async handleCreateLibraryFolder() {
      if (!getPlaybackSongDir()) {
        setStatus(t("transport.status.createFolderRequiresSession"));
        return;
      }

      const folderPath = await prompt(
        t("transport.prompt.virtualFolderName"),
        t("transport.defaults.virtualFolderName"),
      );
      if (folderPath === null) {
        return;
      }

      await runAction(async () => {
        const folders = await createLibraryFolder(folderPath);
        setLibraryFolders(folders);
        setStatus(
          t("transport.status.virtualFolderCreated", {
            name: folderPath.trim() || t("transport.defaults.unnamedFolder"),
          }),
        );
      });
    },

    async handleMoveLibraryAssets(
      filePaths: string[],
      newFolderPath: string | null,
    ) {
      const uniqueFilePaths = [...new Set(filePaths)];
      if (!uniqueFilePaths.length) {
        return;
      }

      await runAction(async () => {
        let nextAssets = getLibraryAssets();

        for (const filePath of uniqueFilePaths) {
          nextAssets = await moveLibraryAsset(filePath, newFolderPath);
        }

        const { folders } = await loadLibraryState();
        setLibraryAssets(nextAssets);
        setLibraryFolders(folders);
        setStatus(
          newFolderPath
            ? t("transport.status.libraryAssetsMoved", {
                count: uniqueFilePaths.length,
                name: newFolderPath,
              })
            : t("transport.status.libraryAssetsMovedRoot", {
                count: uniqueFilePaths.length,
              }),
        );
      });
    },

    async handleRenameLibraryFolder(folderPath: string) {
      if (!getPlaybackSongDir()) {
        setStatus(t("transport.status.renameFolderRequiresSession"));
        return;
      }

      const nextFolderPath = await prompt(
        t("transport.prompt.virtualFolderRename"),
        folderPath,
      );
      if (nextFolderPath === null) {
        return;
      }

      await runAction(async () => {
        const assets = await renameLibraryFolder(folderPath, nextFolderPath);
        const { folders } = await loadLibraryState();
        setLibraryAssets(assets);
        setLibraryFolders(folders);
        setStatus(
          t("transport.status.virtualFolderRenamed", {
            from: folderPath,
            to: nextFolderPath.trim(),
          }),
        );
      });
    },

    async handleDeleteLibraryFolder(folderPath: string) {
      if (
        !(await confirm(
          t("transport.confirm.deleteLibraryFolder", { name: folderPath }),
        ))
      ) {
        return;
      }

      await runAction(async () => {
        const assets = await deleteLibraryFolder(folderPath);
        const { folders } = await loadLibraryState();
        setLibraryAssets(assets);
        setLibraryFolders(folders);
        setStatus(
          t("transport.status.virtualFolderDeleted", { name: folderPath }),
        );
      });
    },
  };
}

export type LibraryHandlers = ReturnType<typeof createLibraryHandlers>;
