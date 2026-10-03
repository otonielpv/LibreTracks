import { useTranslation } from "react-i18next";

import type { SongRegionSummary } from "@libretracks/shared/models";

import { appliedArrangementName } from "./arrangementName";
import { openStructureEditor } from "./structureEditor";

/**
 * "Arrangement: Sunday" next to the song name. One click opens the editor.
 * Renders nothing when no arrangement is applied.
 */
export function ArrangementBadge({ region }: { region: SongRegionSummary }) {
  const { t } = useTranslation();
  const name = appliedArrangementName(region);
  if (!name) return null;
  return (
    <button
      type="button"
      className="lt-structure-badge"
      title={t("transport.structure.indicatorTitle")}
      // Inside clickable headers: opening the editor must not also select the
      // song or start a reorder.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        openStructureEditor(region.id);
      }}
    >
      {t("transport.structure.indicator", { name })}
    </button>
  );
}
