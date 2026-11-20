import type { SongRegionSummary } from "@libretracks/shared/models";

import { useLyricsStore } from "./lyricsStore";

/**
 * The song menu's "Lyrics on screen…" entry, shared by every view (the DAW,
 * Setlist and Compact song menus and the mobile selection bar all build
 * from `songRegionContextMenu`). Only with the sync on.
 */
export function lyricsSongMenuItems(region: SongRegionSummary, t: (key: string) => string) {
  const config = useLyricsStore.getState().configView?.config;
  if (!config?.enabled || !config.software) return [];
  return [
    {
      label: t("lyrics.menu.songPanel"),
      onSelect: () => useLyricsStore.getState().openSongPanel(region.id),
    },
  ];
}
