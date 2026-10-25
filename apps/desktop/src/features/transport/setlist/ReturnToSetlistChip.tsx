import { useTranslation } from "react-i18next";

import { useTimelineUIStore } from "../uiStore";

/**
 * «‹ Back to Setlist» in the DAW, only after «Open in the DAW» from Setlist
 * (`returnViewMode`). Going back keeps the project selection, so Setlist
 * shows the same song; any other change of view clears the chip.
 */
export function ReturnToSetlistChip() {
  const { t } = useTranslation();
  const viewMode = useTimelineUIStore((state) => state.viewMode);
  const returnViewMode = useTimelineUIStore((state) => state.returnViewMode);
  if (viewMode !== "daw" || returnViewMode !== "setlist") return null;
  return (
    <button
      type="button"
      className="lt-return-to-setlist"
      title={t("setlistView.daw.backTitle")}
      onClick={() => useTimelineUIStore.getState().setViewMode("setlist")}
    >
      <span className="material-symbols-outlined" aria-hidden="true">chevron_left</span>
      {t("setlistView.daw.back")}
    </button>
  );
}
