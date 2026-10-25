import { open } from "@tauri-apps/plugin-dialog";
import type {
  LibraryAssetSummary,
  SectionMarkerSummary,
  SongChart,
  SongRegionSummary,
  SongView,
  TransportSnapshot,
} from "@libretracks/shared/models";

import {
  cancelMarkerJump,
  createClipsWithAutoTracks,
  createLibraryFolder,
  importAudioFilesFromBytes,
  importAudioFilesFromPaths,
  isTauriApp,
  moveLibraryAsset,
  playTransport,
  reorderSongRegion,
  setSongRegionChart,
  updateSongRegionMasterGain,
} from "../desktopApi";
import { resolveNativeAudioImportPayloads } from "../helpers";
import { isAcceptedDroppedFileName } from "../library/dragDrop";
import { skippedImportsMessage } from "../library/importPipeline";
import { resolveFolderSongAnchorSeconds } from "../library/libraryPlacement";
import { useTransportStore } from "../store";

/**
 * Song-level actions shared by every song view (Compacta, Live, Setlist):
 * play a song, drop audio into it, import a `.ltpkg`, its master gain,
 * reorder, chart, vamp, cancel a jump and a marker's primary action.
 *
 * They lived inline in TransportPanelContent; here they are one factory so a
 * new view gets them through `songBindings` instead of a second copy. The
 * deps are read through a getter on every call (same pattern as
 * ./library/libraryPlacement): the factory is created once and never sees a
 * stale `song` or a stale scheduler.
 */
export type SongViewHandlerDeps = {
  t: (key: string, options?: Record<string, unknown>) => string;
  getSong: () => SongView | null;
  runAction: (
    action: () => Promise<void>,
    options?: { busy?: boolean },
  ) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  setStatus: (message: string) => void;
  mergeLibraryAssets: (assets: LibraryAssetSummary[]) => void;
  refreshLibraryState: (options: {
    preserveAssets: LibraryAssetSummary[];
  }) => Promise<unknown>;
  /** The panel's last-wins realtime stream for a region's master gain. */
  streamRegionMasterGain: (regionId: string, gain: number) => Promise<unknown>;
  /** The DAW's own `.ltpkg` import at an explicit timeline position. */
  importSongPackageAt: (packagePath: string, insertAt: number) => Promise<void>;
  isPlaying: () => boolean;
  seek: (positionSeconds: number) => Promise<void>;
  /** The global song-jump scheduler (same path as Shift+digit). */
  scheduleSongJump: (regionId: string, regionName: string) => Promise<unknown>;
  toggleVamp: () => Promise<unknown>;
  markerPrimaryAction: (marker: SectionMarkerSummary) => Promise<void>;
};

export function createSongViewHandlers(getDeps: () => SongViewHandlerDeps) {
  const findRegion = (regionId: string) =>
    getDeps().getSong()?.regions.find((region) => region.id === regionId) ??
    null;

  // Master gain follows the track-volume pattern: during the drag an
  // optimistic value goes to the store and the engine gets a realtime
  // stream; on release the commit writes the model and records undo.
  function changeRegionMasterGain(regionId: string, gain: number) {
    const clamped = Math.max(0, Math.min(2, gain));
    useTransportStore.getState().setOptimisticRegionMaster(regionId, clamped);
    void getDeps()
      .streamRegionMasterGain(regionId, clamped)
      .catch(() => {
        // best-effort; commit reconciles
      });
  }

  function commitRegionMasterGain(regionId: string) {
    const deps = getDeps();
    const optimistic =
      useTransportStore.getState().optimisticRegionMaster[regionId];
    if (optimistic === undefined) return;
    void deps.runAction(async () => {
      try {
        deps.applyPlaybackSnapshot(
          await updateSongRegionMasterGain(regionId, optimistic),
        );
      } finally {
        useTransportStore.getState().setOptimisticRegionMaster(regionId, null);
      }
    });
  }

  /**
   * A song's name doubles as a Library folder name. Audio imported by
   * dropping it onto a song lands in that folder (created if missing).
   * Assets that already lived in a folder are respected: the user's manual
   * organisation wins. An empty song name skips the folder.
   */
  async function assignAssetsToSongFolder(
    songName: string,
    assets: LibraryAssetSummary[],
  ) {
    const deps = getDeps();
    const folderName = songName.trim();
    if (!folderName || assets.length === 0) return assets;
    try {
      // Idempotent on the backend: adds the folder if it is missing.
      await createLibraryFolder(folderName);
    } catch {
      // Name collision: the move below still places the assets.
    }
    // moveLibraryAsset returns the full asset list every time, so the last
    // response is the canonical state.
    let latest: LibraryAssetSummary[] = assets;
    for (const asset of assets) {
      if (asset.folderPath && asset.folderPath.trim().length > 0) continue;
      try {
        latest = await moveLibraryAsset(asset.filePath, folderName);
      } catch {
        // A per-asset failure must not abort the whole batch.
      }
    }
    deps.mergeLibraryAssets(latest);
    await deps.refreshLibraryState({ preserveAssets: latest });
    return latest;
  }

  /**
   * Audio files dragged from the OS onto a song. They go through the same
   * import pipeline as the DAW and each lands on its own auto-track at the
   * song's start. Mixed drops (valid + unsupported, or a `.ltpkg`) are
   * refused whole: "some imported, some skipped" would hide the failure.
   */
  function dropOsFilesIntoSong(regionId: string, files: File[]) {
    const deps = getDeps();
    const { t, setStatus } = deps;
    const region = findRegion(regionId);
    if (!region) return;
    const accepted = files.filter((file) =>
      isAcceptedDroppedFileName(file.name),
    );
    const hasPackage = accepted.some((file) =>
      file.name.toLowerCase().endsWith(".ltpkg"),
    );
    if (accepted.length !== files.length || hasPackage || !accepted.length) {
      setStatus(
        t("transport.status.unsupportedDrop", {
          defaultValue: "Tipo de archivo no admitido",
        }),
      );
      return;
    }
    const dropSeconds = region.startSeconds;
    void deps.runAction(async () => {
      const nativePayloads = isTauriApp
        ? resolveNativeAudioImportPayloads(accepted)
        : null;
      const importResult = nativePayloads
        ? await importAudioFilesFromPaths(nativePayloads)
        : await importAudioFilesFromBytes(
            await Promise.all(
              accepted.map(async (file) => ({
                fileName: file.name,
                bytes: new Uint8Array(await file.arrayBuffer()),
              })),
            ),
          );
      const importedAssets = importResult.assets;
      // A file the decoder cannot read no longer sinks the whole drop, so
      // the skipped ones have to be named or they vanish silently.
      if (importResult.skipped.length) {
        setStatus(skippedImportsMessage(importResult.skipped, t));
      }
      deps.mergeLibraryAssets(importedAssets);
      await deps.refreshLibraryState({ preserveAssets: importedAssets });
      if (importedAssets.length === 0) return;
      await assignAssetsToSongFolder(region.name, importedAssets);
      deps.applyPlaybackSnapshot(
        await createClipsWithAutoTracks(
          importedAssets.map((asset) => ({
            filePath: asset.filePath,
            timelineStartSeconds: dropSeconds,
          })),
        ),
      );
      setStatus(
        importedAssets.length === 1
          ? t("transport.status.clipAdded", { name: importedAssets[0].fileName })
          : t("transport.status.clipsAdded", { count: importedAssets.length }),
      );
    });
  }

  /**
   * Imports a `.ltpkg` as a new song at the end of the project, on the first
   * real downbeat after the last song (same anchor as a library folder
   * dropped as a song). The first song of an empty project anchors at 0.
   */
  async function runSongPackageImport(packagePath: string) {
    const deps = getDeps();
    const song = deps.getSong();
    if (!song) return;
    await deps.importSongPackageAt(
      packagePath,
      resolveFolderSongAnchorSeconds(song),
    );
  }

  // Non-blocking on purpose (no `busy: true`): the import runs off the
  // session lock and reports progress through the load-progress events. The
  // blocking shell overlay would freeze the UI for a large package.
  function importSongPackageFromDialog() {
    void getDeps().runAction(async () => {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "LibreTracks Package", extensions: ["ltpkg"] }],
      });
      if (typeof picked !== "string") return;
      await runSongPackageImport(picked);
    });
  }

  /** A `.ltpkg` dragged from the OS over the song strip. Only Tauri can
   * resolve its absolute path; the browser fallback is a no-op. */
  function importSongPackageFromOsFile(file: File) {
    void getDeps().runAction(async () => {
      const payloads = isTauriApp ? resolveNativeAudioImportPayloads([file]) : null;
      const nativePath = payloads?.[0]?.sourcePath;
      if (!nativePath) return;
      await runSongPackageImport(nativePath);
    });
  }

  /**
   * A song's play button. Sounding: the global song-jump scheduler, so the
   * configured trigger and transition apply (same as Shift+digit). Stopped:
   * a scheduled jump would never be heard, so seek to the song and play.
   */
  function playSong(regionId: string, regionName: string) {
    const deps = getDeps();
    void deps.runAction(async () => {
      if (deps.isPlaying()) {
        await deps.scheduleSongJump(regionId, regionName);
        return;
      }
      const region = findRegion(regionId);
      if (!region) return;
      await deps.seek(region.startSeconds);
      deps.applyPlaybackSnapshot(await playTransport());
      deps.setStatus(
        deps.t("transport.status.songStarted", {
          name: regionName,
          defaultValue: `Reproduciendo ${regionName}`,
        }),
      );
    });
  }

  function reorderSong(regionId: string, targetIndex: number) {
    const deps = getDeps();
    void deps.runAction(async () =>
      deps.applyPlaybackSnapshot(await reorderSongRegion(regionId, targetIndex)),
    );
  }

  function setSongChart(regionId: string, chart: SongChart | null) {
    const deps = getDeps();
    return deps.runAction(async () =>
      deps.applyPlaybackSnapshot(await setSongRegionChart(regionId, chart)),
    );
  }

  function toggleVamp() {
    const deps = getDeps();
    void deps.runAction(async () => {
      await deps.toggleVamp();
    });
  }

  function cancelPendingJump() {
    const deps = getDeps();
    void deps.runAction(async () => {
      deps.applyPlaybackSnapshot(await cancelMarkerJump());
      deps.setStatus(deps.t("transport.status.jumpCancelled"));
    });
  }

  function markerAction(marker: SectionMarkerSummary) {
    const deps = getDeps();
    void deps.runAction(() => deps.markerPrimaryAction(marker));
  }

  function songAction(region: SongRegionSummary) {
    playSong(region.id, region.name);
  }

  /** Setlist's "Open in the DAW" shortcut. Wired in step 17 of
   * docs/plans/setlist-view; a no-op until then. */
  function openInDaw(regionId: string) {
    void regionId;
  }

  return {
    changeRegionMasterGain,
    commitRegionMasterGain,
    assignAssetsToSongFolder,
    dropOsFilesIntoSong,
    runSongPackageImport,
    importSongPackageFromDialog,
    importSongPackageFromOsFile,
    playSong,
    reorderSong,
    setSongChart,
    toggleVamp,
    cancelPendingJump,
    markerAction,
    songAction,
    openInDaw,
  };
}

export type SongViewHandlers = ReturnType<typeof createSongViewHandlers>;
