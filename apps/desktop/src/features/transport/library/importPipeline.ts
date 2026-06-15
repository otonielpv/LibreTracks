import type { LibraryAssetSummary } from "@libretracks/shared/models";
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
      await onImported(importedAssets);
    }

    store.removePendingAudioImports(pendingIds);
    setStatus(successMessage(importedAssets));
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Could not import audio files. Please check the files and try again.";
    store.markPendingAudioImportsFailed(pendingIds, message);
    setStatus(message);
  }
}
