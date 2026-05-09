import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { TFunction } from "i18next";
import type { LibraryAssetSummary } from "@libretracks/shared/models";
import type { LibraryClipPreviewState } from "../types";
import type { LibraryImportProgressEvent } from "../desktopApi";
import {
  createLibraryFolder,
  deleteLibraryAsset,
  deleteLibraryFolder,
  getLibraryAssets,
  getLibraryFolders,
  importLibraryAssetsFromDialog,
  isTauriApp,
  listenToLibraryImportProgress,
  moveLibraryAsset,
  renameLibraryFolder,
} from "../desktopApi";
import { mergeLibraryAssetsByFilePath } from "../pendingAudioImports";
import { libraryAssetFileName, waitForUiPaint } from "../helpers";

type UseLibraryActionsProps = {
  playbackSongDir: string | null;
  runAction: (
    work: () => Promise<void>,
    options?: { busy?: boolean },
  ) => Promise<void>;
  t: TFunction;
  setStatus: (status: string) => void;
  setLibraryClipPreview: Dispatch<SetStateAction<LibraryClipPreviewState[]>>;
};

export function useLibraryActions({
  playbackSongDir,
  runAction,
  t,
  setStatus,
  setLibraryClipPreview,
}: UseLibraryActionsProps) {
  const [libraryAssets, setLibraryAssets] = useState<LibraryAssetSummary[]>(
    [],
  );
  const [libraryFolders, setLibraryFolders] = useState<string[]>([]);
  const [isLibraryLoading, setIsLibraryLoading] = useState(false);
  const [isImportingLibrary, setIsImportingLibrary] = useState(false);
  const [libraryImportProgress, setLibraryImportProgress] =
    useState<LibraryImportProgressEvent | null>(null);
  const [deletingLibraryFilePath, setDeletingLibraryFilePath] = useState<
    string | null
  >(null);
  const libraryStateRequestIdRef = useRef(0);

  const loadLibraryState = useCallback(async () => {
    if (!playbackSongDir) {
      return {
        assets: [] as LibraryAssetSummary[],
        folders: [] as string[],
      };
    }

    const [assets, folders] = await Promise.all([
      getLibraryAssets(),
      getLibraryFolders(),
    ]);
    return { assets, folders };
  }, [playbackSongDir]);

  const refreshLibraryState = useCallback(
    async (options?: { preserveAssets?: LibraryAssetSummary[] }) => {
      const requestId = ++libraryStateRequestIdRef.current;
      const { assets, folders } = await loadLibraryState();
      if (requestId !== libraryStateRequestIdRef.current) {
        return assets;
      }

      const nextAssets = options?.preserveAssets?.length
        ? mergeLibraryAssetsByFilePath(assets, options.preserveAssets)
        : assets;

      setLibraryAssets(nextAssets);
      setLibraryFolders(folders);
      return nextAssets;
    },
    [loadLibraryState],
  );

  const mergeLibraryAssets = useCallback(
    (importedAssets: LibraryAssetSummary[]) => {
      if (!importedAssets.length) {
        return;
      }

      libraryStateRequestIdRef.current += 1;

      setLibraryAssets((current) => {
        return mergeLibraryAssetsByFilePath(current, importedAssets);
      });
    },
    [],
  );

  useEffect(() => {
    if (!isTauriApp) {
      return () => {};
    }

    let active = true;
    let unlisten: (() => void) | undefined;

    void listenToLibraryImportProgress((event) => {
      if (!active) {
        return;
      }

      setLibraryImportProgress(event);
    }).then((nextUnlisten) => {
      if (!active) {
        nextUnlisten();
        return;
      }

      unlisten = nextUnlisten;
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const handleImportLibraryAssetsClick = useCallback(async () => {
    if (!playbackSongDir) {
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
      setStatus(t("transport.status.libraryUpdated", { count: assets.length }));
    });
    setIsImportingLibrary(false);
    setLibraryImportProgress(null);
  }, [playbackSongDir, runAction, t, setStatus]);

  const handleDeleteLibraryAssets = useCallback(
    async (assetsToDelete: LibraryAssetSummary[]) => {
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
      if (!window.confirm(confirmationMessage)) {
        return;
      }

      try {
        await runAction(async () => {
          let nextAssets = libraryAssets;
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
          setLibraryClipPreview((current: LibraryClipPreviewState[]) =>
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
    [libraryAssets, loadLibraryState, runAction, t, setStatus, setLibraryClipPreview],
  );

  const handleCreateLibraryFolder = useCallback(async () => {
    if (!playbackSongDir) {
      setStatus(t("transport.status.createFolderRequiresSession"));
      return;
    }

    const folderPath = window.prompt(
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
  }, [playbackSongDir, runAction, t, setStatus]);

  const handleMoveLibraryAssets = useCallback(
    async (filePaths: string[], newFolderPath: string | null) => {
      const uniqueFilePaths = [...new Set(filePaths)];
      if (!uniqueFilePaths.length) {
        return;
      }

      await runAction(async () => {
        let nextAssets = libraryAssets;

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
    [libraryAssets, loadLibraryState, runAction, t, setStatus],
  );

  const handleRenameLibraryFolder = useCallback(
    async (folderPath: string) => {
      if (!playbackSongDir) {
        setStatus(t("transport.status.renameFolderRequiresSession"));
        return;
      }

      const nextFolderPath = window.prompt(
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
    [playbackSongDir, loadLibraryState, runAction, t, setStatus],
  );

  const handleDeleteLibraryFolder = useCallback(
    async (folderPath: string) => {
      if (
        !window.confirm(
          t("transport.confirm.deleteLibraryFolder", { name: folderPath }),
        )
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
    [loadLibraryState, runAction, t, setStatus],
  );

  return {
    libraryAssets,
    libraryFolders,
    isLibraryLoading,
    isImportingLibrary,
    libraryImportProgress,
    deletingLibraryFilePath,
    libraryStateRequestIdRef,
    loadLibraryState,
    refreshLibraryState,
    mergeLibraryAssets,
    setLibraryAssets,
    setLibraryFolders,
    setIsLibraryLoading,
    setIsImportingLibrary,
    setLibraryImportProgress,
    setDeletingLibraryFilePath,
    handleImportLibraryAssetsClick,
    handleDeleteLibraryAssets,
    handleCreateLibraryFolder,
    handleMoveLibraryAssets,
    handleRenameLibraryFolder,
    handleDeleteLibraryFolder,
  };
}
