import { create } from "zustand";

import type { LyricsConfigView, LyricsStatus } from "./lyricsApi";

/**
 * Lyrics sync as the UI sees it: the status the worker publishes
 * (`lyrics:status`, 10 Hz at most), the saved settings and which lyrics
 * panel is open. Narrow selectors: the pill re-renders on its colour, not on
 * every send.
 */
export type LyricsStoreState = {
  status: LyricsStatus | null;
  configView: LyricsConfigView | null;
  linkerOpen: boolean;
  /** The song whose lyrics panel is open. */
  songPanelRegionId: string | null;
  /** Bumped when a song's link changed behind the user's back. */
  linksVersion: number;
  setStatus: (status: LyricsStatus) => void;
  setConfigView: (view: LyricsConfigView) => void;
  openLinker: () => void;
  closeLinker: () => void;
  openSongPanel: (regionId: string) => void;
  closeSongPanel: () => void;
  bumpLinks: () => void;
};

export const INITIAL_LYRICS_STATE = {
  status: null,
  configView: null,
  linkerOpen: false,
  songPanelRegionId: null,
  linksVersion: 0,
} satisfies Partial<LyricsStoreState>;

export const useLyricsStore = create<LyricsStoreState>((set) => ({
  ...INITIAL_LYRICS_STATE,
  setStatus: (status) => set({ status }),
  setConfigView: (configView) => set({ configView }),
  openLinker: () => set({ linkerOpen: true }),
  closeLinker: () => set({ linkerOpen: false }),
  openSongPanel: (songPanelRegionId) => set({ songPanelRegionId }),
  closeSongPanel: () => set({ songPanelRegionId: null }),
  bumpLinks: () => set((state) => ({ linksVersion: state.linksVersion + 1 })),
}));

export type PillTone = "ok" | "warning" | "error" | "paused";

/** The pill's colour: green connected, amber songs unlinked, red no
 * connection or permissions, grey paused. `null` = not shown. */
export function selectPillTone(state: LyricsStoreState): PillTone | null {
  const config = state.configView?.config;
  if (!config?.enabled || !config.software) return null;
  if (config.paused) return "paused";
  const connection = state.status?.connection;
  switch (connection?.state) {
    case "paused":
      return "paused";
    case "unreachable":
    case "unauthorized":
      return "error";
    case "ok":
      return (state.status?.unlinkedSongs ?? 0) > 0 ? "warning" : "ok";
    default:
      return "warning";
  }
}
