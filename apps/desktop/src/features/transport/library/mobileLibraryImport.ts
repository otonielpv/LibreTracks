import type {
  LibraryAssetSummary,
  LibraryImportProgressEvent,
  SkippedImport,
  TransportSnapshot,
} from "@libretracks/shared/models";
import { confirmDialog } from "../../../shared/dialog/dialogService";
import {
  createClipsWithAutoTracks,
  importLibraryAssetsFromDialog,
  importStagedAudioFiles,
} from "../desktopApi";
import { useTransportStore } from "../store";
import { createPendingAudioImports, nextPaint } from "./pendingAudioImports";
import { runAudioImportPipeline } from "./importPipeline";
import { pickFilesViaWebView, stageFileForImport } from "./mobileFilePicker";

/**
 * "Import audio to the library" on phones and tablets — one route per platform,
 * kept out of `libraryDragDrop.ts` because neither shares anything with the
 * drag-and-drop pipeline beyond the store callbacks below.
 *
 * The two routes exist because the platforms offer different things:
 *
 * - **Android** ([`runAndroidLibraryImport`]) picks and copies entirely
 *   backend-side, streaming each `content://` descriptor into the session.
 * - **iOS** ([`runIosLibraryImport`]) has no SAF and no rfd dialog, so the
 *   WebView chooser hands over file CONTENTS, staged to the backend in slices.
 *
 * Android used to take the iOS route too. Measured on the phone this came from,
 * that base64-over-IPC staging sustained ~7 MB/s on a device whose disk does
 * 119 MB/s — the "Leyendo archivo…" that lasted minutes on a multitrack.
 */
export type MobileLibraryImportDeps = {
  /** Assets already in the library, read at call time (not captured). */
  libraryAssets: LibraryAssetSummary[];
  t: (key: string, options?: Record<string, unknown>) => string;
  setStatus: (status: string) => void;
  mergeLibraryAssets: (assets: LibraryAssetSummary[]) => void;
  refreshLibraryState: (options?: {
    preserveAssets?: LibraryAssetSummary[];
  }) => Promise<unknown>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot) => void;
  /** Where new clips land if the user accepts the timeline prompt. */
  getImportPositionSeconds: () => number;
  /**
   * Drives the library panel's spinner. Both routes must set this: a phone
   * import can run for minutes, and with no indicator the panel looks frozen —
   * the panel only shows the spinner while `isImporting` AND a progress event
   * are both present, so the picker itself stays quiet.
   */
  setIsImportingLibrary: (importing: boolean) => void;
  setLibraryImportProgress: (progress: LibraryImportProgressEvent | null) => void;
};

/** iOS additionally reports files the backend could not read. */
export type IosLibraryImportDeps = MobileLibraryImportDeps & {
  reportSkipped: (skipped: SkippedImport[]) => void;
};

/**
 * Offer to place what was just imported on the timeline — the usual mobile
 * intent behind importing a song's multitracks. Shared so both routes word and
 * position it identically.
 */
async function offerToPlaceOnTimeline(
  deps: MobileLibraryImportDeps,
  importedAssets: LibraryAssetSummary[],
): Promise<void> {
  if (importedAssets.length === 0) {
    return;
  }
  const shouldPlace = await confirmDialog(
    deps.t("library.addImportedToTimelinePrompt", {
      count: importedAssets.length,
      defaultValue: "¿Añadir los {{count}} audios importados al timeline?",
    }),
  );
  if (!shouldPlace) {
    return;
  }
  const startSeconds = deps.getImportPositionSeconds();
  const snapshot = await createClipsWithAutoTracks(
    importedAssets.map((asset) => ({
      filePath: asset.filePath,
      timelineStartSeconds: startSeconds,
    })),
  );
  deps.applyPlaybackSnapshot(snapshot);
}

/**
 * iOS route: the WebView chooser, then staged slices.
 *
 * NOTE: the chooser only opens inside the tap's user-gesture window, so the
 * pick must be the first thing this does — no awaits before it.
 */
export async function runIosLibraryImport(
  deps: IosLibraryImportDeps,
): Promise<void> {
  // iOS Files may expose valid audio documents with a generic content type;
  // `audio/*` then greys them out. Leave the native filter unrestricted and let
  // the existing import pipeline validate the selected formats.
  const files = await pickFilesViaWebView();
  if (!files.length) {
    return; // user cancelled
  }

  const pendingImports = createPendingAudioImports(files, 0).map((item) => ({
    ...item,
    showInTimeline: false,
  }));
  useTransportStore.getState().addPendingAudioImports(pendingImports);
  deps.setStatus(deps.t("transport.status.libraryImportStarting"));
  await nextPaint();

  // Nothing on the backend emits progress for this route — the staging loop
  // below IS the slow part and it runs here — so this side has to report it, or
  // the panel sits on "Leyendo archivo…" for minutes and reads as hung.
  deps.setIsImportingLibrary(true);
  const reportStagingProgress = (done: number) => {
    deps.setLibraryImportProgress({
      // 0..90%: the staged import that follows only renames and probes.
      percent: files.length === 0 ? 0 : Math.round((done * 90) / files.length),
      message: deps.t("library.importProgressStaging", {
        done,
        total: files.length,
        defaultValue: "Leyendo archivo {{done}} de {{total}}...",
      }),
    });
  };
  reportStagingProgress(0);

  // Stage sequentially: one in-flight slice at a time keeps the WebView
  // renderer's heap flat — reading whole files into Uint8Arrays here
  // OOM-crashed the renderer on low-RAM phones.
  const stagedPayloads: Array<{ fileName: string; sourcePath: string }> = [];
  try {
    await runAudioImportPipeline({
      pendingIds: pendingImports.map((item) => item.id),
      beforeImport: async () => {
        for (let index = 0; index < files.length; index += 1) {
          const file = files[index];
          stagedPayloads.push({
            fileName: file.name,
            sourcePath: await stageFileForImport(file, index === 0),
          });
          reportStagingProgress(index + 1);
        }
      },
      importFn: () => {
        deps.setLibraryImportProgress({
          percent: 95,
          message: deps.t("library.importProgressFinishing", {
            defaultValue: "Añadiendo a la biblioteca...",
          }),
        });
        return importStagedAudioFiles(stagedPayloads);
      },
      onImported: (importedAssets) =>
        offerToPlaceOnTimeline(deps, importedAssets),
      mergeLibraryAssets: deps.mergeLibraryAssets,
      refreshLibraryState: deps.refreshLibraryState,
      setStatus: deps.setStatus,
      reportSkipped: deps.reportSkipped,
      successMessage: (importedAssets) =>
        deps.t("transport.status.libraryUpdated", {
          count: importedAssets.length,
        }),
    });
  } finally {
    deps.setIsImportingLibrary(false);
    deps.setLibraryImportProgress(null);
  }
}

/**
 * Android route: picker and copy both run backend-side. Resolves when the
 * import (and the optional timeline placement) is done; returns silently if the
 * user cancels the picker.
 */
export async function runAndroidLibraryImport(
  deps: MobileLibraryImportDeps,
): Promise<void> {
  const knownPaths = new Set(deps.libraryAssets.map((asset) => asset.filePath));
  deps.setStatus(deps.t("transport.status.libraryImportStarting"));

  // The backend owns the progress here: it emits "Copiando 3/13…" per file as
  // it streams each document in, and the panel listens for those events. All
  // this side has to do is arm the indicator and disarm it no matter how the
  // import ends.
  deps.setIsImportingLibrary(true);
  deps.setLibraryImportProgress(null);
  let assets: LibraryAssetSummary[] | null;
  try {
    assets = await importLibraryAssetsFromDialog();
  } finally {
    deps.setIsImportingLibrary(false);
    deps.setLibraryImportProgress(null);
  }
  if (!assets) {
    return; // user cancelled
  }

  deps.mergeLibraryAssets(assets);
  await deps.refreshLibraryState({ preserveAssets: assets });

  // The backend event carries the FULL asset list, so "what just came in" is
  // whatever was not there before the picker opened.
  const importedAssets = assets.filter(
    (asset) => !knownPaths.has(asset.filePath),
  );
  deps.setStatus(
    deps.t("transport.status.libraryUpdated", { count: importedAssets.length }),
  );
  await offerToPlaceOnTimeline(deps, importedAssets);
}
