import { useCallback } from "react";

import type { SongChart } from "@libretracks/shared/models";

import { setSongRegionChart } from "../transport/desktopApi";
import { useSongStore } from "../transport/songStore";
import { PlanImportDialog } from "./PlanImportDialog";
import { usePlanImportStore } from "./planImportStore";
import { useChartSourcesAvailable } from "./useChartSourcesAvailable";

type Props = {
  /** Folds the snapshot a chart change returns into the transport. */
  onSnapshot: (snapshot: unknown) => void;
};

/**
 * The plan import, mounted from `LyricsRoot`. Each song is saved with the
 * song chart command (`set_song_region_chart`, one undo step per song), the
 * same one the lyrics editor saves through.
 */
export function PlanImportHost({ onSnapshot }: Props) {
  const open = usePlanImportStore((state) => state.open);
  const close = usePlanImportStore((state) => state.close);
  const song = useSongStore((state) => state.song);
  const available = useChartSourcesAvailable();
  const save = useCallback(
    async (regionId: string, chart: SongChart) => {
      onSnapshot(await setSongRegionChart(regionId, chart));
    },
    [onSnapshot],
  );
  if (!open || !available || !song) return null;
  return <PlanImportDialog song={song} save={save} onClose={close} />;
}
