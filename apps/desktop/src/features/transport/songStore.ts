import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

import type { SongView } from "@libretracks/shared/models";

/**
 * The loaded project (tracks, clips, regions, tempo markers, waveform
 * summaries) — the single most widely read piece of state in the transport
 * panel.
 *
 * It lives in a store rather than in `TransportPanelContent`'s `useState` so
 * each UI zone can subscribe with a selector and re-render only when the slice
 * it actually reads changes. Held as component state, every mutation
 * re-rendered the whole panel, and with it the ~72 props handed to the timeline
 * canvas.
 *
 * The store deliberately mirrors the old `useState` semantics exactly:
 * `setSong` accepts either the next value or an updater, so the optimistic
 * patches spread through the handler factories (see colors/colorHandlers.ts)
 * keep working untouched.
 */
type SongStore = {
  song: SongView | null;
  setSong: (
    next: SongView | null | ((previous: SongView | null) => SongView | null),
  ) => void;
};

export const useSongStore = create<SongStore>()(
  subscribeWithSelector((set) => ({
    song: null,
    setSong: (next) =>
      set((state) => ({
        song: typeof next === "function" ? next(state.song) : next,
      })),
  })),
);

/**
 * Read the current song outside React (event handlers, effect bodies, the
 * non-React canvas path). Equivalent to the old `songRef.current`.
 */
export const getSong = () => useSongStore.getState().song;

/** Write the song outside React. Same updater semantics as `setSong`. */
export const setSong = (
  next: SongView | null | ((previous: SongView | null) => SongView | null),
) => useSongStore.getState().setSong(next);
