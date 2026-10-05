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
  pickLibraryAudioDocuments,
} from "../desktopApi";
import { useTransportStore } from "../store";
import {
  createPendingAudioImportsFromPaths,
  nextPaint,
} from "./pendingAudioImports";
import { runAudioImportPipeline } from "./importPipeline";

/**
 * "Import audio to the library" on phones and tablets: a placeholder per file
 * plus the library panel's progress spinner, kept out of `libraryDragDrop.ts`
 * because it shares nothing with the drag-and-drop pipeline beyond the store
 * callbacks below.
 *
 * One route for Android and iOS ([`runNativeLibraryImport`]): the system
 * picker and the import both run backend-side, referencing the originals
 * where they are (the "import without copying" setting) or copying them
 * straight into the session.
 *
 * Both platforms used to stage every file through the WebView in base64
 * slices. Measured on the phone this came from, that sustained ~7 MB/s on a
 * device whose disk does 119 MB/s — the "Leyendo archivo…" that lasted
 * minutes on a multitrack — and on iOS it always copied.
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
 * The system picker runs backend-side (SAF on Android, the Files picker on
 * iOS); the import references or copies each document.
 *
 * Two steps on purpose. A single command that picked AND imported could not
 * tell the frontend the file names until everything had finished, so the
 * library showed nothing at all while a multitrack copied — it looked broken.
 * Picking first means the placeholders appear immediately, and the import that
 * follows drives them through the shared import pipeline.
 *
 * NOTE: the picker must be the first thing this does — no awaits before it.
 */
export async function runNativeLibraryImport(
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
