import { create } from "zustand";

/**
 * Which song the "Render audio" modal is open for.
 *
 * A store rather than state in TransportPanelContent so every entry point —
 * the timeline's song menu, the mobile selection bar, the compact view's
 * column menu — opens the modal with one call and no props threaded through
 * the monolith.
 */
export type RenderSongTarget = {
  regionId: string;
  regionName: string;
};

type RenderStore = {
  target: RenderSongTarget | null;
  open: (target: RenderSongTarget) => void;
  close: () => void;
};

export const useRenderStore = create<RenderStore>()((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));

export const openRenderSong = (target: RenderSongTarget) =>
  useRenderStore.getState().open(target);
