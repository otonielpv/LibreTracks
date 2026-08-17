import type { LibraryAssetSummary } from "@libretracks/shared/models";
import { alertDialog } from "../../../shared/dialog/dialogService";
import { recordProductEvent } from "../../telemetry/telemetry";
import { forgetLibraryAssets } from "../desktopApi";
import { useTransportStore } from "../store";

/** Shared audio-import pipeline for ALL entry points (drag files, drag paths,
 * library dialog). It owns the pending-status transitions and the library
 * refresh so the three flows behave identically; the only per-flow difference
 * is `onImported` (drag adds timeline tracks/clips; the library dialog omits
 * it). Implemented as a plain module function — NOT a hook — so it captures no
 * render-scoped state and adds no re-render hazard to the large transport
 * component. The store is a singleton accessed via getState(). */
export type RunAudioImportPipelineArgs = {
  /** ids of the pending placeholders already added to the store. */
  pendingIds: string[];
  /** Performs the actual import (paths/bytes) and returns the imported assets.
   * Status is "importing" while this runs. For flows that must do prep work
   * first (e.g. reading File bytes), use `beforeImport`. */
  importFn: () => Promise<LibraryAssetSummary[]>;
  /** Optional prep before the import call, run while status is "reading". */
  beforeImport?: () => Promise<void>;
  /** Optional flow-specific tail run while status is "analyzing" (drag adds
   * timeline tracks/clips). Omitted for library-only imports. */
  onImported?: (importedAssets: LibraryAssetSummary[]) => Promise<void>;
  /** Stable component callbacks. */
  mergeLibraryAssets: (assets: LibraryAssetSummary[]) => void;
  refreshLibraryState: (options?: {
    preserveAssets?: LibraryAssetSummary[];
  }) => Promise<unknown>;
  setStatus: (status: string) => void;
  /** Success status message builder (lets callers pick "clip added" vs
   * "library updated"). */
  successMessage: (importedAssets: LibraryAssetSummary[]) => string;
};

/** Fallback shown only when the failure carries no usable text at all. */
const GENERIC_IMPORT_ERROR =
  "Could not import audio files. Please check the files and try again.";

/**
 * Extract the human-readable reason from whatever a rejected import threw.
 *
 * Tauri rejects `invoke` with a plain STRING, not an `Error`, so the old
 * `error instanceof Error ? error.message : <generic>` check discarded every
 * backend message and always showed the generic text — which is why a clip
 * that simply did not fit between two songs was reported as if the audio file
 * were broken. Strings, `Error`s and `{ message }` objects all carry their
 * reason through; only genuinely empty values fall back.
 */
export function importErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error.trim() || GENERIC_IMPORT_ERROR;
  }
  if (error instanceof Error) {
    return error.message.trim() || GENERIC_IMPORT_ERROR;
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  }
  return GENERIC_IMPORT_ERROR;
}

export async function runAudioImportPipeline({
  pendingIds,
  importFn,
  beforeImport,
  onImported,
  mergeLibraryAssets,
  refreshLibraryState,
  setStatus,
  successMessage,
}: RunAudioImportPipelineArgs): Promise<void> {
  const store = useTransportStore.getState();
  // Assets that made it into the library before a later step failed. Files are
  // registered BEFORE they are placed, so a drop the region rules reject would
  // otherwise leave its audio in the library while telling the user nothing was
  // imported. Tracked here so the catch can roll them back out again.
  let assetsToRollBack: LibraryAssetSummary[] = [];
  try {
    if (beforeImport) {
      store.updatePendingAudioImportStatus(pendingIds, "reading");
      await beforeImport();
    }

    store.updatePendingAudioImportStatus(pendingIds, "importing");
    const importedAssets = await importFn();

    store.updatePendingAudioImportStatus(pendingIds, "metadata");
    mergeLibraryAssets(importedAssets);
    await refreshLibraryState({ preserveAssets: importedAssets });

    store.updatePendingAudioImportStatus(pendingIds, "analyzing");
    if (onImported) {
      // Only the placement tail can strand assets: everything before this
      // point either failed before importing, or is what we would roll back.
      assetsToRollBack = importedAssets;
      await onImported(importedAssets);
      assetsToRollBack = [];
    }

    store.removePendingAudioImports(pendingIds);
    recordProductEvent("audio_imported");
    setStatus(successMessage(importedAssets));
  } catch (error) {
    recordProductEvent("audio_import_failed");
    const message = importErrorMessage(error);
    store.markPendingAudioImportsFailed(pendingIds, message);
    setStatus(message);

    // Roll the half-done import back out of the library. Registering the files
    // happens before placing them, so without this a rejected drop still left
    // its audio in the library list — the user was told the import failed while
    // the assets were sitting right there. Best-effort: a failing rollback must
    // not replace the real error the user needs to read.
    if (assetsToRollBack.length) {
      try {
        await forgetLibraryAssets(
          assetsToRollBack.map((asset) => asset.filePath),
        );
        await refreshLibraryState();
      } catch {
        // Leave the assets in place rather than surfacing a second failure.
      }
    }

    // The status bar alone was not enough: on a wide window it can sit outside
    // the user's field of view, so a rejected drop looked like nothing had
    // happened while the timeline still showed placeholder tracks/clips reading
    // "Error al importar" — which reads as a corrupt file rather than a
    // placement that did not fit. Show the real reason in a modal, then drop
    // the placeholders so the timeline matches what was actually saved: nothing.
    // The backend is atomic (create_audio_tracks_with_clips aborts before
    // persisting), so there is no partial state to keep on screen.
    void alertDialog(message).then((acknowledged) => {
      // Only clear once the user has actually seen the reason. With no dialog
      // host mounted (early startup, tests) the placeholders stay put, so the
      // failure stays visible instead of vanishing unexplained.
      if (acknowledged) {
        useTransportStore.getState().removePendingAudioImports(pendingIds);
      }
    });
  }
}
