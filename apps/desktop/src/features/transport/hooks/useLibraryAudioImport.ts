import type { MutableRefObject } from "react";
import type { TFunction } from "i18next";
import type {
  ClipSummary,
  LibraryAssetSummary,
  TrackSummary,
  TransportSnapshot,
} from "@libretracks/shared/models";
import {
  createClipsBatch,
  createTrack,
  getSongView,
  isTauriApp,
  importAudioFilesFromBytes,
  importAudioFilesFromPaths,
  importSongPackage,
} from "../desktopApi";
import {
  createPendingAudioImports,
  createPendingAudioImportsFromPaths,
  nextPaint,
  type PendingAudioImport,
} from "../pendingAudioImports";
import {
  humanizeLibraryTrackName,
  libraryAssetFileName,
  resolveNativeAudioImportPayloads,
} from "../helpers";
import { useTransportStore } from "../store";

type UseLibraryAudioImportProps = {
  resolveDraggedLibraryAsset: (
    filePath: string,
    durationSeconds: number,
  ) => LibraryAssetSummary;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  refreshLibraryState: (options?: {
    preserveAssets?: LibraryAssetSummary[];
  }) => Promise<LibraryAssetSummary[]>;
  mergeLibraryAssets: (assets: LibraryAssetSummary[]) => void;
  refreshSongView: () => Promise<unknown>;
  startOptimisticClipOperation: (clips: ClipSummary[]) => string;
  completeOptimisticClipOperation: (
    operationId: string,
    projectRevision: number,
  ) => void;
  discardOptimisticClipOperation: (operationId: string) => void;
  tracksByIdRef: MutableRefObject<Record<string, TrackSummary>>;
  setSelectedSectionId: (id: string | null) => void;
  selectTrack: (ids: string[]) => void;
  t: TFunction;
  setStatus: (status: string) => void;
};

export function useLibraryAudioImport({
  resolveDraggedLibraryAsset,
  applyPlaybackSnapshot,
  refreshLibraryState,
  mergeLibraryAssets,
  refreshSongView,
  startOptimisticClipOperation,
  completeOptimisticClipOperation,
  discardOptimisticClipOperation,
  tracksByIdRef,
  setSelectedSectionId,
  selectTrack,
  t,
  setStatus,
}: UseLibraryAudioImportProps) {
  async function createLibraryTrackForAsset(asset: LibraryAssetSummary) {
    const snapshot = await createTrack({
      name: humanizeLibraryTrackName(asset.filePath),
      kind: "audio",
    });
    const nextSong = await getSongView();
    return {
      snapshot,
      trackId: nextSong?.tracks.at(-1)?.id ?? null,
    };
  }

  async function commitLibraryClipPlacements(args: {
    placements: Array<{
      asset: LibraryAssetSummary;
      trackId: string;
      timelineStartSeconds: number;
    }>;
    pendingTrackSnapshot?: TransportSnapshot | null;
  }) {
    if (!args.placements.length) {
      if (args.pendingTrackSnapshot) {
        applyPlaybackSnapshot(args.pendingTrackSnapshot);
      }
      return;
    }

    if (args.pendingTrackSnapshot) {
      applyPlaybackSnapshot(args.pendingTrackSnapshot);
    }

    const optimisticOperationId = startOptimisticClipOperation(
      args.placements.map((placement, index) => ({
        id: `optimistic-clip-${Date.now()}-${index}`,
        trackId: placement.trackId,
        trackName:
          tracksByIdRef.current[placement.trackId]?.name ??
          humanizeLibraryTrackName(placement.asset.filePath),
        filePath: placement.asset.filePath,
        waveformKey: placement.asset.filePath,
        isMissing: placement.asset.isMissing,
        timelineStartSeconds: Math.max(0, placement.timelineStartSeconds),
        sourceStartSeconds: 0,
        sourceDurationSeconds: placement.asset.durationSeconds,
        durationSeconds: placement.asset.durationSeconds,
        gain: 1,
      })),
    );

    try {
      const clipSnapshot = await createClipsBatch(
        args.placements.map((placement) => ({
          trackId: placement.trackId,
          filePath: placement.asset.filePath,
          timelineStartSeconds: placement.timelineStartSeconds,
        })),
      );
      completeOptimisticClipOperation(
        optimisticOperationId,
        clipSnapshot.projectRevision,
      );
      applyPlaybackSnapshot(clipSnapshot);
    } catch (error) {
      discardOptimisticClipOperation(optimisticOperationId);
      throw error;
    }
  }

  async function placeLibraryAssetsOnTimeline(args: {
    payload: Array<{ file_path: string; durationSeconds: number }>;
    timelineStartSeconds: number;
    targetTrackId: string | null;
    layout: "horizontal" | "vertical";
  }) {
    const assets = args.payload.map((item) =>
      resolveDraggedLibraryAsset(item.file_path, item.durationSeconds),
    );
    if (!assets.length) {
      return;
    }

    if (args.layout === "horizontal") {
      let targetTrackId = args.targetTrackId;
      let pendingTrackSnapshot: TransportSnapshot | null = null;
      if (!targetTrackId) {
        const createdTrack = await createLibraryTrackForAsset(assets[0]);
        targetTrackId = createdTrack.trackId;
        pendingTrackSnapshot = createdTrack.snapshot;
      }

      if (!targetTrackId) {
        if (pendingTrackSnapshot) {
          applyPlaybackSnapshot(pendingTrackSnapshot);
        }
        return;
      }

      let clipStartSeconds = args.timelineStartSeconds;
      const placements = assets.map((asset) => {
        const nextPlacement = {
          asset,
          trackId: targetTrackId as string,
          timelineStartSeconds: clipStartSeconds,
        };
        clipStartSeconds += asset.durationSeconds;
        return nextPlacement;
      });

      await commitLibraryClipPlacements({ placements, pendingTrackSnapshot });
      selectTrack([targetTrackId]);
    } else {
      let selectedTrackId: string | null = args.targetTrackId;
      let pendingTrackSnapshot: TransportSnapshot | null = null;
      const placements: Array<{
        asset: LibraryAssetSummary;
        trackId: string;
        timelineStartSeconds: number;
      }> = [];

      for (const [index, asset] of assets.entries()) {
        const createdTrack =
          index === 0 && args.targetTrackId
            ? null
            : await createLibraryTrackForAsset(asset);
        const targetTrackId = createdTrack?.trackId ?? args.targetTrackId;
        if (!targetTrackId) {
          if (createdTrack?.snapshot) {
            applyPlaybackSnapshot(createdTrack.snapshot);
          }
          continue;
        }

        if (createdTrack?.snapshot) {
          pendingTrackSnapshot = createdTrack.snapshot;
        }

        placements.push({
          asset,
          trackId: targetTrackId,
          timelineStartSeconds: args.timelineStartSeconds,
        });
        selectedTrackId = targetTrackId;
      }

      await commitLibraryClipPlacements({ placements, pendingTrackSnapshot });

      if (selectedTrackId) {
        selectTrack([selectedTrackId]);
      }
    }

    setSelectedSectionId(null);
    setStatus(
      assets.length === 1
        ? t("transport.status.clipAdded", { name: assets[0].fileName })
        : t("transport.status.clipsAdded", { count: assets.length }),
    );
  }

  async function handleDroppedSongPackagePath(
    packagePath: string,
    dropSeconds: number,
  ) {
    const result = await importSongPackage(packagePath, dropSeconds);
    applyPlaybackSnapshot(result.snapshot);
    mergeLibraryAssets(result.libraryAssets);
    await refreshLibraryState({ preserveAssets: result.libraryAssets });
    await refreshSongView();
    setStatus(
      t("transport.status.packageImportedAt", {
        time: dropSeconds.toFixed(2),
      }),
    );
  }

  async function createRealTracksAndClipsForImportedAssets(args: {
    importedAssets: LibraryAssetSummary[];
    dropSeconds: number;
  }) {
    const placements: Array<{
      asset: LibraryAssetSummary;
      trackId: string;
      timelineStartSeconds: number;
    }> = [];
    let pendingTrackSnapshot: TransportSnapshot | null = null;
    let selectedTrackId: string | null = null;

    for (const asset of args.importedAssets) {
      const createdTrack = await createLibraryTrackForAsset(asset);
      if (!createdTrack.trackId) {
        if (createdTrack.snapshot) {
          applyPlaybackSnapshot(createdTrack.snapshot);
        }
        continue;
      }

      pendingTrackSnapshot = createdTrack.snapshot;
      selectedTrackId = createdTrack.trackId;
      placements.push({
        asset,
        trackId: createdTrack.trackId,
        timelineStartSeconds: args.dropSeconds,
      });
    }

    await commitLibraryClipPlacements({ placements, pendingTrackSnapshot });

    if (selectedTrackId) {
      selectTrack([selectedTrackId]);
    }

    setSelectedSectionId(null);
  }

  async function startDroppedAudioImportJob(args: {
    files: File[];
    pendingImports: PendingAudioImport[];
    dropSeconds: number;
  }) {
    const { files, pendingImports, dropSeconds } = args;
    const pendingIds = pendingImports.map((item) => item.id);

    await nextPaint();

    try {
      const nativePayloads = isTauriApp
        ? resolveNativeAudioImportPayloads(files)
        : null;

      let importedAssets: LibraryAssetSummary[];
      if (nativePayloads) {
        useTransportStore
          .getState()
          .updatePendingAudioImportStatus(pendingIds, "importing");
        importedAssets = await importAudioFilesFromPaths(nativePayloads);
      } else {
        useTransportStore
          .getState()
          .updatePendingAudioImportStatus(pendingIds, "reading");

        const payloads = await Promise.all(
          files.map(async (file) => ({
            fileName: file.name,
            bytes: new Uint8Array(await file.arrayBuffer()),
          })),
        );

        useTransportStore
          .getState()
          .updatePendingAudioImportStatus(pendingIds, "importing");
        importedAssets = await importAudioFilesFromBytes(payloads);
      }

      useTransportStore
        .getState()
        .updatePendingAudioImportStatus(pendingIds, "metadata");
      mergeLibraryAssets(importedAssets);
      await refreshLibraryState({ preserveAssets: importedAssets });

      useTransportStore
        .getState()
        .updatePendingAudioImportStatus(pendingIds, "analyzing");
      await createRealTracksAndClipsForImportedAssets({
        importedAssets,
        dropSeconds,
      });

      useTransportStore.getState().removePendingAudioImports(pendingIds);
      setStatus(
        importedAssets.length === 1
          ? t("transport.status.clipAdded", {
              name: importedAssets[0].fileName,
            })
          : t("transport.status.clipsAdded", {
              count: importedAssets.length,
            }),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not import audio files. Please check the files and try again.";
      useTransportStore
        .getState()
        .markPendingAudioImportsFailed(pendingIds, message);
      setStatus(message);
    }
  }

  function handleDroppedAudioFiles(files: File[], dropSeconds: number) {
    const pendingImports = createPendingAudioImports(files, dropSeconds);
    useTransportStore.getState().addPendingAudioImports(pendingImports);

    setStatus(
      files.length === 1
        ? `Importing ${files[0].name}...`
        : `Importing ${files.length} audio files...`,
    );

    void startDroppedAudioImportJob({ files, pendingImports, dropSeconds });
  }

  async function startDroppedAudioPathImportJob(args: {
    paths: string[];
    pendingImports: PendingAudioImport[];
    dropSeconds: number;
  }) {
    const pendingIds = args.pendingImports.map((item) => item.id);

    await nextPaint();

    try {
      useTransportStore
        .getState()
        .updatePendingAudioImportStatus(pendingIds, "importing");

      const importedAssets = await importAudioFilesFromPaths(
        args.paths.map((path) => ({
          fileName: libraryAssetFileName(path),
          sourcePath: path,
        })),
      );

      useTransportStore
        .getState()
        .updatePendingAudioImportStatus(pendingIds, "metadata");
      mergeLibraryAssets(importedAssets);
      await refreshLibraryState({ preserveAssets: importedAssets });

      useTransportStore
        .getState()
        .updatePendingAudioImportStatus(pendingIds, "analyzing");
      await createRealTracksAndClipsForImportedAssets({
        importedAssets,
        dropSeconds: args.dropSeconds,
      });

      useTransportStore.getState().removePendingAudioImports(pendingIds);
      setStatus(
        importedAssets.length === 1
          ? t("transport.status.clipAdded", {
              name: importedAssets[0].fileName,
            })
          : t("transport.status.clipsAdded", {
              count: importedAssets.length,
            }),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not import audio files. Please check the files and try again.";
      useTransportStore
        .getState()
        .markPendingAudioImportsFailed(pendingIds, message);
      setStatus(message);
    }
  }

  function handleDroppedAudioPaths(paths: string[], dropSeconds: number) {
    const pendingImports = createPendingAudioImportsFromPaths(
      paths,
      dropSeconds,
    );
    useTransportStore.getState().addPendingAudioImports(pendingImports);

    setStatus(
      paths.length === 1
        ? `Importing ${libraryAssetFileName(paths[0])}...`
        : `Importing ${paths.length} audio files...`,
    );

    void startDroppedAudioPathImportJob({ paths, pendingImports, dropSeconds });
  }

  return {
    placeLibraryAssetsOnTimeline,
    handleDroppedSongPackagePath,
    handleDroppedAudioFiles,
    handleDroppedAudioPaths,
  };
}
