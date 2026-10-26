import { useTranslation } from "react-i18next";

import { useTimelineUIStore } from "../uiStore";
import { MobileTrackReorderToggle } from "../tracks/MobileTrackReorderToggle";

export function MobileTrackSelectionControls() {
  const { t } = useTranslation();
  const areaSelectMode = useTimelineUIStore((state) => state.areaSelectMode);
  const selectedTrackCount = useTimelineUIStore(
    (state) => state.selectedTrackIds.length,
  );
  const trackReorderMode = useTimelineUIStore(
    (state) => state.trackReorderMode,
  );

  const toggleSelectionMode = () => {
    const store = useTimelineUIStore.getState();
    store.setAreaSelectMode(!store.areaSelectMode);
    if (!store.areaSelectMode) {
      store.setExpandedTrackId(null);
      store.setSelectionMixOpen(false);
    }
  };

  return (
    <div
      className="lt-mobile-track-tools"
      role="toolbar"
      aria-label={t("mobileTrackActions.toolbar")}
    >
      <button
        type="button"
        className={`lt-icon-button ${areaSelectMode ? "is-active" : ""}`}
        aria-pressed={areaSelectMode}
        onClick={toggleSelectionMode}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          select
        </span>
        {t(
          areaSelectMode
            ? "mobileTrackActions.finishSelecting"
            : "mobileTrackActions.selectMultiple",
        )}
      </button>
      {selectedTrackCount > 0 ? (
        <>
          <span className="lt-mobile-track-tools-count">
            {t("mobileTrackActions.selectedTracks", {
              count: selectedTrackCount,
            })}
          </span>
          <button
            type="button"
            className="lt-icon-button"
            aria-label={t("mobileTrackActions.clearSelection")}
            title={t("mobileTrackActions.clearSelection")}
            onClick={() => useTimelineUIStore.getState().clearSelection()}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              close
            </span>
          </button>
        </>
      ) : null}
      <MobileTrackReorderToggle showLabel />
      {areaSelectMode ? (
        <span className="lt-mobile-track-tools-hint" role="status">
          {t("mobileTrackActions.selectionHint")}
        </span>
      ) : null}
      {trackReorderMode ? (
        <span className="lt-mobile-track-tools-hint" role="status">
          {t("mobileTrackActions.reorderHint")}
        </span>
      ) : null}
    </div>
  );
}
