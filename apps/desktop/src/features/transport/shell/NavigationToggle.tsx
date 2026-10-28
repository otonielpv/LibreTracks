import { useTranslation } from "react-i18next";
import { useTimelineUIStore } from "../uiStore";

export function NavigationToggle() {
  const { t } = useTranslation();
  const collapsed = useTimelineUIStore((state) => state.navigationCollapsed);
  const toggle = useTimelineUIStore((state) => state.toggleNavigation);
  const label = t(collapsed ? "transport.shell.showNavigation" : "transport.shell.hideNavigation");
  return <button type="button" className="lt-navigation-toggle" aria-label={label} title={label}
    aria-expanded={!collapsed} onClick={toggle}>
    <span className="material-symbols-outlined" aria-hidden="true">{collapsed ? "menu" : "menu_open"}</span>
  </button>;
}