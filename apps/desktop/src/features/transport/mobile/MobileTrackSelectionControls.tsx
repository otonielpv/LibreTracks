import { useTranslation } from "react-i18next";

import { useTimelineUIStore } from "../uiStore";
import { MobileTrackReorderToggle } from "../tracks/MobileTrackReorderToggle";

type MobileTrackSelectionControlsProps = {
  placement?: "toolbar" | "setlist-rail";
  showRailLabels?: boolean;
};

export function MobileTrackSelectionControls({
  placement = "toolbar",
  showRailLabels = false,
}: MobileTrackSelectionControlsProps) {
  const { t } = useTranslation();
  const areaSelectMode = useTimelineUIStore((state) => state.areaSelectMode);
  const selectedTrackCount = useTimelineUIStore(
    (state) => state.selectedTrackIds.length,
  );

  const toggleSelectionMode = () => {
    const store = useTimelineUIStore.getState();
    store.setAreaSelectMode(!store.areaSelectMode);
    if (!store.areaSelectMode) {
      store.setExpandedTrackId(null);
      store.setSelectionMixOpen(false);
    }
  };

  const buttonClass =
    placement === "setlist-rail"
      ? "lt-setlist-mixer-action lt-mobile-track-selection-control"
      : "lt-icon-button";
  const railLabel = (label: string) =>
    placement === "setlist-rail" && showRailLabels ? (
      <span className="lt-setlist-rail-label">{t(label)}</span>
    ) : null;
  const controls = (
    <>
      <button
        type="button"
        className={`${buttonClass} ${areaSelectMode ? "is-active" : ""}`}
        aria-label={t(
          areaSelectMode
            ? "mobileTrackActions.finishSelecting"
            : "mobileTrackActions.selectMultiple",
        )}
        title={t(
          areaSelectMode
            ? "mobileTrackActions.finishSelecting"
            : "mobileTrackActions.selectMultiple",
        )}
        aria-pressed={areaSelectMode}
        onClick={toggleSelectionMode}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          checklist
        </span>
        <span className="lt-setlist-mixer-action-label">
          {t(
            areaSelectMode
              ? "mobileTrackActions.finishSelecting"
              : "mobileTrackActions.selectMultiple",
          )}
        </span>
        {railLabel(
          areaSelectMode
            ? "mobileTrackActions.finishSelecting"
            : "mobileTrackActions.selectMultiple",
        )}
      </button>
      {selectedTrackCount > 0 ? (
        <button
          type="button"
          className={buttonClass}
          aria-label={t("mobileTrackActions.clearSelection")}
          title={t("mobileTrackActions.clearSelection")}
          onClick={() => useTimelineUIStore.getState().clearSelection()}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            close
          </span>
          <span className="lt-setlist-mixer-action-label">
            {t("mobileTrackActions.clearSelection")}
          </span>
          {railLabel("mobileTrackActions.clearSelection")}
        </button>
      ) : null}
      <MobileTrackReorderToggle
        className={buttonClass}
        showLabel={placement === "setlist-rail" && showRailLabels}
      />
    </>
  );

  if (placement === "setlist-rail") {
    return controls;
  }

  return (
    <div
      className="lt-mobile-track-tools"
      role="toolbar"
      aria-label={t("mobileTrackActions.toolbar")}
    >
      {controls}
    </div>
  );
}
