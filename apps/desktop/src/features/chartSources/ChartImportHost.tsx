import { FEATURE_FLAGS } from "@libretracks/shared/featureFlags";
import { reviewTimingForSong } from "@libretracks/shared/charts/chartImportReview";
import type { SongChart } from "@libretracks/shared/models";

import { useChartEditorStore } from "../transport/charts/chartEditorStore";
import { setSongRegionChart } from "../transport/desktopApi";
import { getSong } from "../transport/songStore";
import { ChartImportDialog } from "./ChartImportDialog";
import { useChartImportStore, type AdjustInput } from "./chartImportStore";

type Props = {
  /** Folds the snapshot a chart change returns into the transport. */
  onSnapshot: (snapshot: unknown) => void;
};

/**
 * The one place the Planning Center picker mounts (from `LyricsRoot`). The
 * picked sheet goes to the chart editor: back to the one that opened the
 * picker, or a new one when it came from the song menu (saving with the song
 * chart command, `set_song_region_chart`, like the editor everywhere).
 */
export function ChartImportHost({ onSnapshot }: Props) {
  const session = useChartImportStore((state) => state.session);
  const close = useChartImportStore((state) => state.close);
  if (!FEATURE_FLAGS.chartSources || !session) return null;

  const picked = (input: AdjustInput) => {
    close();
    if (session.onPicked) {
      session.onPicked(input);
      return;
    }
    const region = session.region;
    const timing = reviewTimingForSong(getSong(), region);
    useChartEditorStore.getState().open({
      region,
      markers: session.markers,
      chart: session.chart,
      secondsPerBeatAt: timing.secondsPerBeatAt!,
      onSave: async (chart: SongChart | null) => {
        onSnapshot(await setSongRegionChart(region.id, chart));
      },
      initialImport: input,
    });
  };

  return <ChartImportDialog key={session.region.id} session={session} onPicked={picked} onClose={close} />;
}
