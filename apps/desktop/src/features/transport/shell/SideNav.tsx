import { useTranslation } from "react-i18next";
import type { SidebarTab } from "../types";

type SideNavProps = {
  activeSidebarTab: SidebarTab | null;
  isRemoteModalOpen: boolean;
  isSettingsModalOpen: boolean;
  onLibraryToggle: () => void;
  onRemoteClick: () => void;
  onSettingsClick: () => void;
};

export function SideNav({
  activeSidebarTab,
  isRemoteModalOpen,
  isSettingsModalOpen,
  onLibraryToggle,
  onRemoteClick,
  onSettingsClick,
}: SideNavProps) {
  const { t } = useTranslation();

  return (
    <aside
      className="lt-side-nav"
      aria-label={t("transport.shell.navigation")}
    >
      <button
        type="button"
        className={activeSidebarTab === "library" ? "is-active" : ""}
        aria-label={t("transport.shell.library")}
        onClick={onLibraryToggle}
      >
        <span className="material-symbols-outlined">library_music</span>
        {t("transport.shell.library")}
      </button>
      <button
        type="button"
        className={isRemoteModalOpen ? "is-active" : ""}
        aria-label={t("transport.shell.remote")}
        onClick={onRemoteClick}
      >
        <span className="material-symbols-outlined">phonelink</span>
        {t("transport.shell.remote")}
      </button>
      <button
        type="button"
        className={isSettingsModalOpen ? "is-active" : ""}
        aria-label={t("transport.shell.settings")}
        onClick={onSettingsClick}
      >
        <span className="material-symbols-outlined">settings</span>
        {t("transport.shell.settings")}
      </button>
    </aside>
  );
}
