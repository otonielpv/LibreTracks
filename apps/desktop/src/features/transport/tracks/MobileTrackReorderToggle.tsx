import { useTranslation } from "react-i18next";

import { useTimelineUIStore } from "../uiStore";
import { TOUR_TARGETS } from "../../tutorial/tourTargets";

/** Mobile-only affordance: scrolling remains the default header gesture. */
export function MobileTrackReorderToggle() {
  const { t } = useTranslation();
  const enabled = useTimelineUIStore((state) => state.trackReorderMode);
  const toggle = useTimelineUIStore((state) => state.toggleTrackReorderMode);
  const label = t(
    enabled
      ? "timelineToolbar.disableTrackReorder"
      : "timelineToolbar.enableTrackReorder",
  );

  return (
    <button
      type="button"
      className={`lt-icon-button ${enabled ? "is-active" : ""}`}
      aria-label={label}
      title={label}
      aria-pressed={enabled}
      data-lt-tour={TOUR_TARGETS.mobileTrackReorder}
      onClick={toggle}
    >
      <span className="material-symbols-outlined">swap_vert</span>
    </button>
  );
}
