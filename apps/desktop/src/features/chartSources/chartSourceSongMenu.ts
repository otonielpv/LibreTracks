import { chartMarkersForRegion } from "@libretracks/shared/charts/chartSync";
import type { SongRegionSummary } from "@libretracks/shared/models";

import { getSong } from "../transport/songStore";
import { useChartImportStore } from "./chartImportStore";
import { chartSourcesAvailableNow } from "./useChartSourcesAvailable";

/**
 * The song menu's Planning Center entries, shared by every view (the DAW,
 * Setlist and Compact song menus and the mobile selection bar all build from
 * `songRegionContextMenu`). Hidden behind the flag, for network guests and
 * for a backup.
 */
export function chartSourceSongMenuItems(region: SongRegionSummary, t: (key: string) => string) {
  if (!chartSourcesAvailableNow()) return [];
  const open = (mode: "import" | "refresh") =>
    useChartImportStore.getState().open({
      region,
      markers: chartMarkersForRegion(getSong()?.sectionMarkers ?? [], region),
      chart: region.chart ?? null,
      mode,
    });
  return [
    { label: t("chartSources.menu.import"), onSelect: () => open("import") },
    ...(region.chart?.source?.provider === "planningCenter"
      ? [{ label: t("chartSources.menu.refresh"), onSelect: () => open("refresh") }]
      : []),
  ];
}
