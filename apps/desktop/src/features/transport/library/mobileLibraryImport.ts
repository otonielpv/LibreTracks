import type {
  LibraryAssetSummary,
  LibraryImportProgressEvent,
  SkippedImport,
  TransportSnapshot,
} from "@libretracks/shared/models";
import { confirmDialog } from "../../../shared/dialog/dialogService";
import {
  createClipsWithAutoTracks,
  importPickedLibraryAudio,
  importStagedAudioFiles,
  pickLibraryAudioDocuments,
} from "../desktopApi";
import { useTransportStore } from "../store";
import {
  createPendingAudioImportsFromPaths,
  createPendingAudioImports,
  nextPaint,
} from "./pendingAudioImports";
import { runAudioImportPipeline } from "./importPipeline";
import { pickFilesViaWebView, stageFileForImport } from "./mobileFilePicker";

/**
 * "Import audio to the library" on phones and tablets — one route per platform,
 * both showing a placeholder per file plus the library panel's progress spinner,
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
  /** Reports files the backend could not read. The import SUCCEEDED for the
   * rest, so this is not the error path. */
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
  deps: MobileLibraryImportDeps,
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
 * Android route: the SAF picker runs backend-side, the copy streams each
 * `content://` descriptor straight into the session.
 *
 * Two steps on purpose. A single command that picked AND imported could not
 * tell the frontend the file names until everything had finished, so the
 * library showed nothing at all while a multitrack copied — it looked broken.
 * Picking first means the placeholders appear immediately, and the import that
 * follows drives them through the same pipeline the iOS route uses.
 *
 * NOTE: the picker must be the first thing this does — no awaits before it.
 */
export async function runAndroidLibraryImport(
  deps: MobileLibraryImportDeps,
): Promise<void> {
  const batch = await pickLibraryAudioDocuments();
  if (!batch.fileNames.length) {
    return; // user cancelled
  }

  // The factory takes paths only to derive a display name from each, and these
  // documents have no path — a SAF id like "msf:28" is not one. The names the
  // picker resolved are what the placeholders should show, so pass those.
  const pendingImports = createPendingAudioImportsFromPaths(
    batch.fileNames,
    0,
    false,
  );
  useTransportStore.getState().addPendingAudioImports(pendingImports);
  deps.setStatus(deps.t("transport.status.libraryImportStarting"));
  await nextPaint();

  // The backend emits "Copiando 3/13…" per file as it copies; the panel listens
  // for those. All this side does is arm the spinner and disarm it whatever
  // happens — one left spinning after a failure disables the import button for
  // good.
  deps.setIsImportingLibrary(true);
  deps.setLibraryImportProgress(null);
  try {
    await runAudioImportPipeline({
      pendingIds: pendingImports.map((item) => item.id),
      importFn: () => importPickedLibraryAudio(batch.batchId),
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
