import { FEATURE_FLAGS } from "@libretracks/shared/featureFlags";

import { ChartImportDialog } from "./ChartImportDialog";
import { useChartImportStore } from "./chartImportStore";

/** The one place the Planning Center import mounts (from `LyricsRoot`). */
export function ChartImportHost() {
  const session = useChartImportStore((state) => state.session);
  const close = useChartImportStore((state) => state.close);
  if (!FEATURE_FLAGS.chartSources || !session) return null;
  return <ChartImportDialog key={session.region.id} session={session} onClose={close} />;
}
