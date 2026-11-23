import { create } from "zustand";

import type { ImportedChart } from "@libretracks/shared/charts/importedChart";
import type { SectionMarkerSummary, SongChart, SongRegionSummary } from "@libretracks/shared/models";

/**
 * A sheet brought in as it comes, waiting for "Adjust to the sequence": the
 * text and the source's hints (sequence, key), plus, for an update from the
 * source, what to keep of the current links.
 */
export type AdjustInput = {
  imported: ImportedChart;
  locked?: ReadonlyArray<{ markerId: string; section: number | null }>;
  passOverrides?: Readonly<Record<string, number>>;
  keepLineBeats?: Readonly<Record<string, { section: number; lineBeats: number[] }>>;
};

/**
 * The Planning Center picker open for one song. Lives outside the views (like
 * `chartEditorStore`) so turning the phone or a view re-mounting does not
 * close it. Mounted by `ChartImportHost` in `LyricsRoot`.
 */
export type ChartImportSession = {
  region: SongRegionSummary;
  /** The song's section markers in timeline order, repeats included. */
  markers: SectionMarkerSummary[];
  chart: SongChart | null;
  /** "refresh": bring the imported `chart`'s arrangement again (08). */
  mode?: "import" | "refresh";
  /** Opened from the chart editor: the picked sheet goes back to it. From
   * the song menu (absent), the host opens the editor with it. */
  onPicked?: (input: AdjustInput) => void;
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
