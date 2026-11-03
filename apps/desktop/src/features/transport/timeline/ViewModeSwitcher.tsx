import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { TOUR_TARGETS } from "../../tutorial/tourTargets";
import { PopoverShell } from "../panels/PopoverShell";
import type { ViewMode } from "../uiStore";
import "./ViewModeSwitcher.css";

type ViewModeSwitcherProps = {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
};

const VIEW_MODES: Array<{
  mode: ViewMode;
  icon: string;
  labelKey: string;
  nameKey: string;
}> = [
  { mode: "daw", icon: "view_timeline", labelKey: "liveView.openDaw", nameKey: "liveView.daw" },
  { mode: "setlist", icon: "queue_music", labelKey: "liveView.openSetlist", nameKey: "liveView.setlistView" },
  { mode: "compact", icon: "view_module", labelKey: "liveView.openCompact", nameKey: "liveView.compact" },
  { mode: "live", icon: "stadium", labelKey: "liveView.open", nameKey: "liveView.live" },
];

// One button shows the current view and opens the four views in a menu. It
// started on the phone, where four view buttons were a lot of toolbar, and the
// desktop followed so both look the same.
export function ViewModeSwitcher({ value, onChange }: ViewModeSwitcherProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const current = VIEW_MODES.find((view) => view.mode === value) ?? VIEW_MODES[0];

  return (
    <div
      className="lt-view-mode-switcher lt-view-mode-menu lt-bottom-controls"
      data-lt-tour={TOUR_TARGETS.viewModeSwitcher}
    >
      <button
        ref={anchorRef}
        type="button"
        className="lt-icon-button lt-view-mode-menu-button is-active"
        aria-label={t("liveView.chooseView")}
        title={t("liveView.chooseView")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((isOpen) => !isOpen)}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          {current.icon}
        </span>
        <span className="lt-view-mode-menu-name">{t(current.nameKey)}</span>
        <span className="material-symbols-outlined lt-view-mode-menu-caret" aria-hidden="true">
          {open ? "expand_less" : "expand_more"}
        </span>
      </button>
      <PopoverShell
        open={open}
        anchorRef={anchorRef}
        ariaLabel={t("liveView.chooseView")}
        onClose={() => setOpen(false)}
        className="lt-pads-popover lt-view-mode-menu-panel"
        role="menu"
      >
        {VIEW_MODES.map(({ mode, icon, labelKey, nameKey }) => (
          <button
            type="button"
            key={mode}
            role="menuitemradio"
            aria-checked={value === mode}
            aria-label={t(labelKey)}
            title={t(labelKey)}
            className={`lt-view-mode-menu-item${value === mode ? " is-active" : ""}`}
            onClick={() => {
              setOpen(false);
              if (mode !== value) onChange(mode);
            }}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              {icon}
            </span>
            <span>{t(nameKey)}</span>
          </button>
        ))}
      </PopoverShell>
    </div>
  );
}
