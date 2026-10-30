import { useCallback, useRef } from "react";

import type { SongRegionSummary } from "../desktopApi";

/** The parent's song handlers, each keyed by region id. */
export type SongColumnHandlerSource = {
  onMasterGainChange: (regionId: string, gain: number) => void;
  onMasterGainCommit: (regionId: string) => void;
  onDropOsFilesIntoSong: (regionId: string, files: File[]) => void;
  onDropLibraryAssetsIntoSong: (
    regionId: string,
    payload: Array<{ filePath: string; durationSeconds?: number }>,
  ) => void;
  onPlaySong: (regionId: string, name: string) => void;
  onRenameSong: (regionId: string) => void;
  onSetSongBpm: (regionId: string) => void;
  onDeleteSong: (regionId: string) => void;
  onExportSong: (regionId: string) => void;
  onSetSongKey: (regionId: string, key: string | null) => void;
  onSelectRegion: (regionId: string) => void;
};

/** One column's handlers, already bound to its region. */
export type SongColumnHandlers = {
  onMasterGainChange: (gain: number) => void;
  onMasterGainCommit: () => void;
  onDropOsFiles: (files: File[]) => void;
  onDropLibraryAssets: (
    payload: Array<{ filePath: string; durationSeconds?: number }>,
  ) => void;
  onPlay: () => void;
  onRename: () => void;
  onSetBpm: () => void;
  onDelete: () => void;
  onExport: () => void;
  onSetKey: (key: string | null) => void;
  onSelect: () => void;
};

/**
 * Stable per-song handlers for the compact columns.
 *
 * Why: the columns are memoized, but they used to get fresh inline lambdas on
 * every render, so any change re-rendered every column with all its clips.
 * useNearbySongColumns changes state each time a column crosses its margin
 * while scrolling, which re-rendered the whole strip mid-gesture (long tasks
 * in the Android emulator, 10 songs). The closures here are created once per
 * region id and read the latest handlers and song name through refs.
 */
export function useSongColumnHandlers(
  source: SongColumnHandlerSource,
  regions: readonly SongRegionSummary[],
): (regionId: string) => SongColumnHandlers {
  const latestRef = useRef(source);
  latestRef.current = source;
  const namesRef = useRef(new Map<string, string>());
  namesRef.current = new Map(regions.map((region) => [region.id, region.name]));
  const cacheRef = useRef(new Map<string, SongColumnHandlers>());

  return useCallback((regionId: string) => {
    const cached = cacheRef.current.get(regionId);
    if (cached) return cached;
    const latest = () => latestRef.current;
    const handlers: SongColumnHandlers = {
      onMasterGainChange: (gain) => latest().onMasterGainChange(regionId, gain),
      onMasterGainCommit: () => latest().onMasterGainCommit(regionId),
      onDropOsFiles: (files) => latest().onDropOsFilesIntoSong(regionId, files),
      onDropLibraryAssets: (payload) =>
        latest().onDropLibraryAssetsIntoSong(regionId, payload),
      onPlay: () =>
        latest().onPlaySong(regionId, namesRef.current.get(regionId) ?? ""),
      onRename: () => latest().onRenameSong(regionId),
      onSetBpm: () => latest().onSetSongBpm(regionId),
      onDelete: () => latest().onDeleteSong(regionId),
      onExport: () => latest().onExportSong(regionId),
      onSetKey: (key) => latest().onSetSongKey(regionId, key),
      onSelect: () => latest().onSelectRegion(regionId),
    };
    cacheRef.current.set(regionId, handlers);
    return handlers;
  }, []);
}
