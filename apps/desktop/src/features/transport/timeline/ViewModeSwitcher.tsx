import { useTranslation } from "react-i18next";

import { TOUR_TARGETS } from "../../tutorial/tourTargets";
import type { ViewMode } from "../uiStore";

type ViewModeSwitcherProps = {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
};

const VIEW_MODES: Array<{ mode: ViewMode; icon: string; labelKey: string }> = [
  { mode: "daw", icon: "view_timeline", labelKey: "liveView.openDaw" },
  { mode: "compact", icon: "view_module", labelKey: "liveView.openCompact" },
  { mode: "live", icon: "stadium", labelKey: "liveView.open" },
];

export function ViewModeSwitcher({ value, onChange }: ViewModeSwitcherProps) {
  const { t } = useTranslation();

  return (
    <div
      className="lt-view-mode-switcher lt-bottom-controls"
      data-lt-tour={TOUR_TARGETS.viewModeSwitcher}
      role="group"
      aria-label={t("liveView.chooseView")}
    >
      {VIEW_MODES.map(({ mode, icon, labelKey }) => (
        <button
          type="button"
          key={mode}
          className={`lt-icon-button${value === mode ? " is-active" : ""}`}
          aria-label={t(labelKey)}
          title={t(labelKey)}
          aria-pressed={value === mode}
          onClick={() => onChange(mode)}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            {icon}
          </span>
        </button>
      ))}
    </div>
  );
}
