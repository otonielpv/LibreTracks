import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryAssetSummary } from "@libretracks/shared/models";
import type { LibraryImportProgressEvent } from "../desktopApi";
import {
  getLibraryAssets,
  getLibraryFolders,
  isTauriApp,
  listenToLibraryImportProgress,
} from "../desktopApi";
import { mergeLibraryAssetsByFilePath } from "../library/pendingAudioImports";

type UseLibraryActionsProps = {
  playbackSongDir: string | null;
};

export function useLibraryActions({ playbackSongDir }: UseLibraryActionsProps) {
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
  };
}
