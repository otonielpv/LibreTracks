import { create } from "zustand";

import type { SectionMarkerSummary, SongChart, SongRegionSummary } from "@libretracks/shared/models";

/**
 * The Planning Center import open for one song. Lives outside the views (like
 * `chartEditorStore`) so turning the phone or a view re-mounting does not
 * close it. Mounted by `ChartImportHost` in `LyricsRoot`.
 */
export type ChartImportSession = {
  region: SongRegionSummary;
  /** The song's section markers in timeline order, repeats included. */
  markers: SectionMarkerSummary[];
  chart: SongChart | null;
  /** The song's existing chart action. Absent when opened from the song
   * menu: the host then saves with `set_song_region_chart`, as the editor. */
  onSave?: (chart: SongChart) => Promise<void>;
  /** Seconds per beat at a song position, to measure markers in beats. */
  secondsPerBeatAt?: (seconds: number) => number;
  /** "refresh": update the imported `chart` from its source (08). */
  mode?: "import" | "refresh";
};

type ChartImportState = {
  session: ChartImportSession | null;
  open: (session: ChartImportSession) => void;
  close: () => void;
};

export const useChartImportStore = create<ChartImportState>((set) => ({
  session: null,
  open: (session) => set({ session }),
  close: () => set({ session: null }),
}));
