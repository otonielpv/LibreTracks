import { useCallback } from "react";

import { FEATURE_FLAGS } from "@libretracks/shared/featureFlags";
import type { SongChart } from "@libretracks/shared/models";

import { setSongRegionChart } from "../transport/desktopApi";
import { ChartImportDialog } from "./ChartImportDialog";
import { useChartImportStore } from "./chartImportStore";

type Props = {
  /** Folds the snapshot a chart change returns into the transport. */
  onSnapshot: (snapshot: unknown) => void;
};

/** The one place the Planning Center import mounts (from `LyricsRoot`). */
export function ChartImportHost({ onSnapshot }: Props) {
  const session = useChartImportStore((state) => state.session);
  const close = useChartImportStore((state) => state.close);
  const regionId = session?.region.id;
  const saveToSong = useCallback(
    async (chart: SongChart) => {
      if (regionId) onSnapshot(await setSongRegionChart(regionId, chart));
    },
    [onSnapshot, regionId],
  );
  if (!FEATURE_FLAGS.chartSources || !session) return null;
  return (
    <ChartImportDialog
      key={session.region.id}
      session={{ ...session, onSave: session.onSave ?? saveToSong }}
      onClose={close}
    />
  );
}
