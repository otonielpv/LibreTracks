import { useTranslation } from "react-i18next";
import { isAndroidApp } from "../desktopApi";
import type { SidebarTab } from "../types";

type SideNavProps = {
  activeSidebarTab: SidebarTab | null;
  isRemoteModalOpen: boolean;
  isSettingsModalOpen: boolean;
  onLibraryToggle: () => void;
  onRemoteClick: () => void;
  onSettingsClick: () => void;
  /** Android: the FILE menu's two mobile entries live here instead of the
   * topbar, freeing the transport strip on narrow phone screens. */
  onSessionsClick?: () => void;
  onSaveClick?: () => void;
  canSave?: boolean;
  /** Android: toggles the file-actions submenu (import song / export session). */
  onFileActionsClick?: () => void;
  isFileActionsOpen?: boolean;
};

export function SideNav({
  activeSidebarTab,
  isRemoteModalOpen,
  isSettingsModalOpen,
  onLibraryToggle,
  onRemoteClick,
  onSettingsClick,
  onSessionsClick,
  onSaveClick,
  canSave = false,
  onFileActionsClick,
  isFileActionsOpen = false,
}: SideNavProps) {
  const { t } = useTranslation();

  return (
    <aside
      className="lt-side-nav"
      aria-label={t("transport.shell.navigation")}
    >
      {isAndroidApp && onSessionsClick ? (
        <button
          type="button"
          aria-label={t("timelineTopbar.mobileSessions", {
            defaultValue: "Sesiones…",
          })}
          onClick={onSessionsClick}
        >
          <span className="material-symbols-outlined">folder_open</span>
          {t("timelineTopbar.mobileSessionsShort", {
            defaultValue: "Sesiones",
          })}
        </button>
      ) : null}
      {isAndroidApp && onSaveClick ? (
        <button
          type="button"
          aria-label={t("timelineTopbar.save")}
          disabled={!canSave}
          onClick={onSaveClick}
        >
          <span className="material-symbols-outlined">save</span>
          {t("timelineTopbar.saveShort", { defaultValue: "Guardar" })}
        </button>
      ) : null}
      {isAndroidApp && onFileActionsClick ? (
        <button
          type="button"
          className={isFileActionsOpen ? "is-active" : ""}
          aria-label={t("transport.shell.fileActions", {
            defaultValue: "Importar / Exportar",
          })}
          aria-expanded={isFileActionsOpen}
          onClick={onFileActionsClick}
        >
          <span className="material-symbols-outlined">import_export</span>
          {t("transport.shell.fileActionsShort", { defaultValue: "Archivo" })}
        </button>
      ) : null}
      <button
        type="button"
        className={activeSidebarTab === "library" ? "is-active" : ""}
        aria-label={t("transport.shell.library")}
        onClick={onLibraryToggle}
      >
        <span className="material-symbols-outlined">library_music</span>
        {t("transport.shell.library")}
      </button>
      {!isAndroidApp && (
        <button
          type="button"
          className={isRemoteModalOpen ? "is-active" : ""}
          aria-label={t("transport.shell.remote")}
          onClick={onRemoteClick}
        >
          <span className="material-symbols-outlined">phonelink</span>
          {t("transport.shell.remote")}
        </button>
      )}
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
