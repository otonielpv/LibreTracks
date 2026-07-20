import type {
  LibraryAssetSummary,
  SongView,
  TransportSnapshot,
} from "@libretracks/shared/models";

/**
 * Dependencies for the compact-view song/clip handlers extracted from
 * TransportPanelContent — the per-song context-menu actions (rename, BPM,
 * delete, export, key) and the two per-clip ones (move to track, delete).
 *
 * These all follow the same shape: read the live region off `getSong()`,
 * confirm/prompt if the action is destructive or needs a value, then run the
 * IPC through `runAction` and publish the returned snapshot.
 *
 * Deliberately NOT in this module: the import/drop handlers and
 * handleCompactPlaySong. Those depend on `handleDroppedSongPackagePath` and
 * `scheduleRegionJumpWithOptions`, which are resolved through hoisting and a
 * hook instantiated further down the component body. Extracting them means
 * untangling that ordering first — see the slice notes.
 */
export type CompactSongHandlerDeps = {
  getSong: () => SongView | null;
  runAction: (
    action: () => Promise<void>,
    options?: { busy?: boolean },
  ) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  setStatus: (message: string) => void;
  setSelectedRegionId: (regionId: string | null) => void;
  setExportSongTarget: (
    target: { regionId: string; regionName: string } | null,
  ) => void;
  setLibraryAssets: (assets: LibraryAssetSummary[]) => void;
  setLibraryFolders: (folders: string[]) => void;
  /** Current library assets + folders, straight from the backend. */
  loadLibraryState: () => Promise<{
    assets: LibraryAssetSummary[];
    folders: string[];
  }>;
  prompt: (message: string, defaultValue?: string) => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  t: (key: string, options?: Record<string, unknown>) => string;
  /** Effective BPM at a timeline position, honouring tempo markers. */
  getEffectiveBpmAt: (song: SongView, seconds: number) => number;
  moveClipToTrack: (args: {
    clipId: string;
    targetTrackId: string;
  }) => Promise<TransportSnapshot>;
  deleteClip: (clipId: string) => Promise<TransportSnapshot>;
  updateSongRegion: (
    regionId: string,
    name: string,
    startSeconds: number,
    endSeconds: number,
  ) => Promise<TransportSnapshot>;
  updateSongRegionKey: (
    regionId: string,
    key: string | null,
  ) => Promise<TransportSnapshot>;
  upsertSongTempoMarker: (
    startSeconds: number,
    bpm: number,
  ) => Promise<TransportSnapshot>;
  deleteSongRegion: (regionId: string) => Promise<TransportSnapshot>;
  exportRegionAsPackage: (
    regionId: string,
    includeAudio: boolean,
  ) => Promise<boolean>;
  renameLibraryFolder: (
    oldFolderPath: string,
    newFolderPath: string,
  ) => Promise<LibraryAssetSummary[]>;
  moveLibraryAsset: (
    filePath: string,
    folderPath: string,
  ) => Promise<LibraryAssetSummary[]>;
  deleteLibraryFolder: (folderPath: string) => Promise<LibraryAssetSummary[]>;
};

/** True when `folderPath` is `branchRoot` itself or nested under it. */
export function isLibraryFolderInBranch(
  folderPath: string,
  branchRoot: string,
) {
  return folderPath === branchRoot || folderPath.startsWith(`${branchRoot}/`);
}

/**
 * Re-root `folderPath` from `oldFolderPath` onto `newFolderPath`, preserving
 * whatever nesting sat below the old root.
 */
export function resolveRenamedLibraryFolderBranch(
  folderPath: string,
  oldFolderPath: string,
  newFolderPath: string,
) {
  if (folderPath === oldFolderPath) {
    return newFolderPath;
  }

  const suffix = folderPath.slice(oldFolderPath.length).replace(/^\/+/, "");
  return suffix ? `${newFolderPath}/${suffix}` : newFolderPath;
}

export function createCompactSongHandlers(deps: CompactSongHandlerDeps) {
  const {
    getSong,
    runAction,
    applyPlaybackSnapshot,
    setStatus,
    setSelectedRegionId,
    setExportSongTarget,
    setLibraryAssets,
    setLibraryFolders,
    loadLibraryState,
    prompt,
    confirm,
    t,
    getEffectiveBpmAt,
    moveClipToTrack,
    deleteClip,
    updateSongRegion,
    updateSongRegionKey,
    upsertSongTempoMarker,
    deleteSongRegion,
    exportRegionAsPackage,
    renameLibraryFolder,
    moveLibraryAsset,
    deleteLibraryFolder,
  } = deps;

  const findRegion = (regionId: string) =>
    getSong()?.regions.find((region) => region.id === regionId) ?? null;

  /**
   * Keep the song's Library folder in sync when the song is renamed.
   *
   * Two cases: if no folder already carries the new name we can rename in
   * place; otherwise the two folders have to be merged, so every asset under
   * the old branch is moved across individually and the now-empty old folder
   * is dropped.
   */
  const syncSongLibraryFolderAfterRename = async (
    oldSongName: string,
    newSongName: string,
  ) => {
    const oldFolderPath = oldSongName.trim();
    const newFolderPath = newSongName.trim();
    if (!oldFolderPath || !newFolderPath || oldFolderPath === newFolderPath) {
      return;
    }

    const { assets, folders } = await loadLibraryState();
    const oldFolderExists =
      folders.includes(oldFolderPath) ||
      assets.some((asset) => asset.folderPath === oldFolderPath);
    if (!oldFolderExists) {
      return;
    }

    const newFolderExists =
      folders.includes(newFolderPath) ||
      assets.some((asset) => asset.folderPath === newFolderPath);

    let nextAssets: LibraryAssetSummary[] = assets;
    if (!newFolderExists) {
      nextAssets = await renameLibraryFolder(oldFolderPath, newFolderPath);
    } else {
      for (const asset of assets) {
        if (
          !asset.folderPath ||
          !isLibraryFolderInBranch(asset.folderPath, oldFolderPath)
        ) {
          continue;
        }

        nextAssets = await moveLibraryAsset(
          asset.filePath,
          resolveRenamedLibraryFolderBranch(
            asset.folderPath,
            oldFolderPath,
            newFolderPath,
          ),
        );
      }
      nextAssets = await deleteLibraryFolder(oldFolderPath);
    }

    const { folders: nextFolders } = await loadLibraryState();
    setLibraryAssets(nextAssets);
    setLibraryFolders(nextFolders);
  };

  // Per-clip context menu handlers from the compact view.
  const handleCompactMoveClipToTrack = (
    clipId: string,
    targetTrackId: string,
  ) => {
    void runAction(async () => {
      const snapshot = await moveClipToTrack({ clipId, targetTrackId });
      applyPlaybackSnapshot(snapshot);
    });
  };

  const handleCompactDeleteClip = (clipId: string) => {
    void runAction(async () => {
      const snapshot = await deleteClip(clipId);
      applyPlaybackSnapshot(snapshot);
    });
  };

  // Rename song via window.prompt, the same way the DAW track header's
  // "Renombrar" context-menu entry works. We keep the song's existing
  // bounds + transpose; only the name changes.
  const handleCompactRenameSong = async (regionId: string) => {
    const currentRegion = findRegion(regionId);
    if (!currentRegion) return;
    const nextName = (
      await prompt("Renombrar canción", currentRegion.name)
    )?.trim();
    if (!nextName || nextName === currentRegion.name) return;
    void runAction(async () => {
      const snapshot = await updateSongRegion(
        regionId,
        nextName,
        currentRegion.startSeconds,
        currentRegion.endSeconds,
      );
      applyPlaybackSnapshot(snapshot);
      await syncSongLibraryFolderAfterRename(currentRegion.name, nextName);
      setStatus(`Canción renombrada como "${nextName}"`);
    });
  };

  // Set BPM for a song. Always inserts (or replaces) a tempo marker at the
  // song's start_seconds — we agreed this stays consistent whether the song
  // is the project's first or not, so reordering songs never silently
  // changes which tempo applies to which section. Backend's
  // upsertSongTempoMarker semantics handle the "create-or-replace" part.
  const handleCompactSetSongBpm = async (regionId: string) => {
    const currentSong = getSong();
    const currentRegion = findRegion(regionId);
    if (!currentSong || !currentRegion) return;
    const currentBpm = getEffectiveBpmAt(
      currentSong,
      currentRegion.startSeconds,
    );
    const raw = await prompt(
      `BPM de "${currentRegion.name}"`,
      currentBpm.toFixed(2),
    );
    if (raw === null) return;
    const nextBpm = Number(raw.replace(",", "."));
    if (!Number.isFinite(nextBpm) || nextBpm <= 0) {
      setStatus("BPM inválido");
      return;
    }
    void runAction(async () => {
      const snapshot = await upsertSongTempoMarker(
        currentRegion.startSeconds,
        nextBpm,
      );
      applyPlaybackSnapshot(snapshot);
      setStatus(
        `BPM de "${currentRegion.name}" ajustado a ${nextBpm.toFixed(2)}`,
      );
    });
  };

  // Delete a song from the compact view. Confirms when the song still holds
  // clips since the backend will take them with it (delete_song_region also
  // evicts clips inside the region and tempo markers that lived in its
  // range). Same pattern the DAW's songRegionContextMenu uses.
  const handleCompactDeleteSong = async (regionId: string) => {
    const currentSong = getSong();
    const currentRegion = findRegion(regionId);
    if (!currentSong || !currentRegion) return;
    const clipCount = currentSong.clips.filter(
      (clip) =>
        clip.timelineStartSeconds >= currentRegion.startSeconds &&
        clip.timelineStartSeconds < currentRegion.endSeconds,
    ).length;
    if (clipCount > 0) {
      const confirmed = await confirm(
        `Borrar canción "${currentRegion.name}" y sus ${clipCount} ${
          clipCount === 1 ? "clip" : "clips"
        }?`,
      );
      if (!confirmed) return;
    }
    void runAction(async () => {
      const snapshot = await deleteSongRegion(regionId);
      applyPlaybackSnapshot(snapshot);
      setSelectedRegionId(null);
      setStatus(`Canción "${currentRegion.name}" eliminada`);
    });
  };

  // Export the song as a LibreTracks package (.ltpkg). Reuses the exact
  // same backend command the DAW's "Exportar Canción" right-click action
  // calls, so the output format and file-dialog flow are identical
  // regardless of which view triggered the export.
  const handleCompactExportSong = (regionId: string) => {
    const currentRegion = findRegion(regionId);
    if (!currentRegion) return;
    // Open the Light/Full chooser; the actual export runs on confirm.
    setExportSongTarget({ regionId, regionName: currentRegion.name });
  };

  // Compact view "Nota de la canción" submenu → sets the region's original key.
  // Reuses the same backend command as the DAW context menu so the effective-key
  // badge (which recomputes with the transpose) stays consistent across views.
  const handleCompactSetSongKey = (regionId: string, key: string | null) => {
    const currentRegion = findRegion(regionId);
    if (!currentRegion || (currentRegion.key ?? null) === key) {
      return;
    }
    void runAction(async () => {
      const nextSnapshot = await updateSongRegionKey(regionId, key);
      applyPlaybackSnapshot(nextSnapshot);
      setStatus(
        key
          ? t("transport.status.songKeyUpdated", {
              defaultValue: `Nota de «{{name}}» → {{key}}`,
              name: currentRegion.name,
              key,
            })
          : t("transport.status.songKeyCleared", {
              defaultValue: `Nota de «{{name}}» eliminada`,
              name: currentRegion.name,
            }),
      );
    });
  };

  // Runs the export once the user picked a mode in the ExportSongModal.
  const handleConfirmExportSong = (regionId: string, includeAudio: boolean) => {
    const currentRegion = findRegion(regionId);
    setExportSongTarget(null);
    void runAction(
      async () => {
        const exported = await exportRegionAsPackage(regionId, includeAudio);
        if (exported) {
          setStatus(
            `Paquete exportado para ${currentRegion?.name ?? "la canción"}`,
          );
        }
      },
      { busy: true },
    );
  };

  return {
    syncSongLibraryFolderAfterRename,
    handleCompactMoveClipToTrack,
    handleCompactDeleteClip,
    handleCompactRenameSong,
    handleCompactSetSongBpm,
    handleCompactDeleteSong,
    handleCompactExportSong,
    handleCompactSetSongKey,
    handleConfirmExportSong,
  };
}

export type CompactSongHandlers = ReturnType<typeof createCompactSongHandlers>;
