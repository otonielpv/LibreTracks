import { create } from "zustand";

/**
 * Which song the "Analizar canción" modal is open for. A store, like the
 * render modal's, so every song menu opens it with one call and nothing is
 * threaded through TransportPanelContent.
 */
type SongAnalysisTarget = { regionId: string; regionName: string };

type SongAnalysisStore = {
  target: SongAnalysisTarget | null;
  show: (target: SongAnalysisTarget) => void;
  close: () => void;
};

export const useSongAnalysisStore = create<SongAnalysisStore>()((set) => ({
  target: null,
  show: (target) => set({ target }),
  close: () => set({ target: null }),
}));

export const openSongAnalysis = (target: SongAnalysisTarget) =>
  useSongAnalysisStore.getState().show(target);

/** Whether "Analizar todas las canciones" is open: a store so the File menu
 * (desktop and mobile) opens it without threading state through the panel. */
type BatchSongAnalysisStore = {
  open: boolean;
  show: () => void;
  close: () => void;
};

export const useBatchSongAnalysisStore = create<BatchSongAnalysisStore>()((set) => ({
  open: false,
  show: () => set({ open: true }),
  close: () => set({ open: false }),
}));

export const openBatchSongAnalysis = () => useBatchSongAnalysisStore.getState().show();
