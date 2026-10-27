import { useTranslation } from "react-i18next";

import { useTimelineUIStore } from "../uiStore";
import { TOUR_TARGETS } from "../../tutorial/tourTargets";

/** Mobile-only affordance: scrolling remains the default header gesture. */
export function MobileTrackReorderToggle({
  className = "lt-icon-button",
  showLabel = false,
}: {
  className?: string;
  showLabel?: boolean;
} = {}) {
  const { t } = useTranslation();
  const enabled = useTimelineUIStore((state) => state.trackReorderMode);
  const toggle = useTimelineUIStore((state) => state.toggleTrackReorderMode);
  const label = t(
    enabled
      ? "timelineToolbar.disableTrackReorder"
      : "timelineToolbar.enableTrackReorder",
  );
  const visibleLabel = t(
    enabled ? "mobileTrackActions.finishMoving" : "mobileTrackActions.moveTracks",
  );

  return (
    <button
      type="button"
      className={`${className} ${enabled ? "is-active" : ""}`}
      aria-label={label}
      title={label}
      aria-pressed={enabled}
      data-lt-tour={TOUR_TARGETS.mobileTrackReorder}
      onClick={toggle}
    >
      <span className="material-symbols-outlined">swap_vert</span>
      {showLabel
        ? <span className="lt-setlist-rail-label">{visibleLabel}</span>
        : null}
    </button>
  );
}
