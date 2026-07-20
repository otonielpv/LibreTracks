import { useEffect } from "react";

import type { LibraryAssetSummary } from "@libretracks/shared/models";

import {
  getLibraryWaveformSummaries,
  type WaveformSummaryDto,
} from "../desktopApi";
import type { LibraryClipPreviewState } from "../types";

/** Max library waveforms requested per pass; mirrors the timeline loader. */
const WAVEFORM_REQUEST_BATCH_SIZE = 4;

export type UseLibraryStateOptions = {
  /** Active session directory; null closes the library. */
  playbackSongDir: string | null;
  /** Song id — a different song re-reads the library even in the same dir. */
  songId: string | null;
  libraryAssets: LibraryAssetSummary[];
  waveformCache: Record<string, WaveformSummaryDto>;
  loadLibraryState: () => Promise<{
    assets: LibraryAssetSummary[];
    folders: string[];
  }>;
  setLibraryAssets: (assets: LibraryAssetSummary[]) => void;
  setLibraryFolders: (folders: string[]) => void;
  setLibraryClipPreview: (preview: LibraryClipPreviewState[]) => void;
  setIsLibraryLoading: (loading: boolean) => void;
  setWaveformCache: (
    update: (
      current: Record<string, WaveformSummaryDto>,
    ) => Record<string, WaveformSummaryDto>,
  ) => void;
  setStatus: (message: string) => void;
  /** Translates a thrown error into a user-facing status line. */
  formatErrorStatus: (error: unknown) => string;
  /** Guards against a stale response overwriting a newer session's library. */
  libraryStateRequestIdRef: { current: number };
  /** Waveform keys already requested, so a batch is never sent twice. */
  inFlightWaveformKeysRef: { current: Set<string> };
};

/**
 * Owns the session library: loads assets/folders when the session changes and
 * pre-warms waveform peaks for the assets that don't have them yet.
 *
 * Both passes are request-id / `active` guarded because a session switch can
 * land while an earlier fetch is still in flight.
 */
export function useLibraryState({
  playbackSongDir,
  songId,
  libraryAssets,
  waveformCache,
  loadLibraryState,
  setLibraryAssets,
  setLibraryFolders,
  setLibraryClipPreview,
  setIsLibraryLoading,
  setWaveformCache,
  setStatus,
  formatErrorStatus,
  libraryStateRequestIdRef,
  inFlightWaveformKeysRef,
}: UseLibraryStateOptions) {
  // Load the library assets/folders for the active session.
  useEffect(() => {
    let active = true;

    async function loadLibraryAssets() {
      if (!playbackSongDir) {
        libraryStateRequestIdRef.current += 1;
        setLibraryAssets([]);
        setLibraryFolders([]);
        setLibraryClipPreview([]);
        return;
      }

      const requestId = ++libraryStateRequestIdRef.current;
      setLibraryAssets([]);
      setLibraryFolders([]);
      setLibraryClipPreview([]);
      setIsLibraryLoading(true);
      try {
        const { assets, folders } = await loadLibraryState();
        if (!active || requestId !== libraryStateRequestIdRef.current) {
          return;
        }

        setLibraryAssets(assets);
        setLibraryFolders(folders);
      } catch (error) {
        if (active) {
          setStatus(formatErrorStatus(error));
        }
      } finally {
        if (active) {
          setIsLibraryLoading(false);
        }
      }
    }

    void loadLibraryAssets();

    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadLibraryState, playbackSongDir, songId]);

  // Pre-warm waveforms for library assets that don't have peaks yet.
  useEffect(() => {
    let active = true;

    async function warmLibraryWaveforms() {
      if (!playbackSongDir || !libraryAssets.length) {
        return;
      }

      const missingWaveformKeys = libraryAssets
        .map((asset) => asset.filePath)
        // Defensive: never request a waveform for a pending placeholder's temp
        // id (not a real file). Real imported assets replace these once ready.
        .filter((filePath) => !filePath.startsWith("pending-asset-"))
        .filter(
          (waveformKey, index, keys) => keys.indexOf(waveformKey) === index,
        )
        .filter((waveformKey) => {
          const summary = waveformCache[waveformKey];
          return !summary && !inFlightWaveformKeysRef.current.has(waveformKey);
        });

      if (!missingWaveformKeys.length) {
        return;
      }

      const batchKeys = missingWaveformKeys.slice(
        0,
        WAVEFORM_REQUEST_BATCH_SIZE,
      );
      for (const waveformKey of batchKeys) {
        inFlightWaveformKeysRef.current.add(waveformKey);
      }

      const summaries = await getLibraryWaveformSummaries(batchKeys);
      if (!active) {
        return;
      }

      // Clear in-flight for the WHOLE batch (see loadMissingWaveforms): a cache
      // miss is generated in the background and not returned here, so leaving it
      // in-flight would strand it until a full refresh.
      for (const waveformKey of batchKeys) {
        inFlightWaveformKeysRef.current.delete(waveformKey);
      }

      if (!summaries.length) {
        return;
      }

      setWaveformCache((current) => ({
        ...current,
        ...Object.fromEntries(
          summaries.map((summary) => [summary.waveformKey, summary]),
        ),
      }));
    }

    void warmLibraryWaveforms();

    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryAssets, playbackSongDir, waveformCache]);
}
