import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { isMobileApp } from "../desktopApi";
import { useViewportClampedMenu } from "../hooks/useViewportClampedMenu";
import { useDismissOnBack } from "../mobile/backNavigation";
import type { ContextMenuState } from "../types";
import { useNetworkPermissions } from "../../network/useNetworkPermissions";

type OpenContextMenu = NonNullable<ContextMenuState>;

type TimelineContextMenusProps = {
  contextMenu: ContextMenuState;
  onDismiss: () => void;
  /** Vuelve a mostrar un menu anterior (el "atras" de los submenus). */
  onNavigate: (menu: OpenContextMenu) => void;
};

/**
 * Un paso del "atras" del sistema en Android. Va en un componente propio y con
 * `key` = profundidad porque `useDismissOnBack` registra al montar y el guardian
 * DESREGISTRA la entrada al consumirla: volver de un nivel 2 al 1 deja el menu
 * abierto y, sin remontar, el siguiente atras ya no retrocederia.
 */
function BackStep({ onBack }: { onBack: () => void }) {
  useDismissOnBack(onBack);
  return null;
}

export function TimelineContextMenus({
  contextMenu,
  onDismiss,
  onNavigate,
}: TimelineContextMenusProps) {
  const { canEdit } = useNetworkPermissions();
  // En Android, atras cierra este overlay en vez de salir de la aplicacion.
  useDismissOnBack(onDismiss, contextMenu !== null);
  const { t } = useTranslation();

  // Pila de menus padre. Un submenu no es un menu anidado: la opcion cierra el
  // menu actual y abre otro en su sitio (`setContextMenu`), asi que el unico
  // que sabe de donde se vino es este componente. Al pulsar una opcion se
  // apunta el menu actual; si lo siguiente que llega es OTRO menu, era un
  // submenu y el anterior pasa a la pila. Si llega `null` era una accion y
  // la pila se vacia. Un menu abierto desde fuera (clic derecho en otro
  // sitio) tambien la vacia.
  const [history, setHistory] = useState<OpenContextMenu[]>([]);
  const pendingParentRef = useRef<OpenContextMenu | null>(null);
  const navigatingBackRef = useRef(false);
  const previousMenuRef = useRef<ContextMenuState>(null);

  useLayoutEffect(() => {
    if (previousMenuRef.current === contextMenu) {
      return;
    }
    previousMenuRef.current = contextMenu;
    const parent = pendingParentRef.current;
    pendingParentRef.current = null;
    if (navigatingBackRef.current) {
      navigatingBackRef.current = false;
      return;
    }
    if (contextMenu && parent) {
      setHistory((current) => [...current, parent]);
    } else {
      setHistory([]);
    }
  }, [contextMenu]);

  const goBack = () => {
    const parent = history[history.length - 1];
    if (!parent) {
      return;
    }
    navigatingBackRef.current = true;
    setHistory(history.slice(0, -1));
    onNavigate(parent);
  };

  const backButton =
    history.length > 0 ? (
      <button
        type="button"
        className="lt-icon-button lt-context-menu-back"
        aria-label={t("common.back", { defaultValue: "Atrás" })}
        title={t("common.back", { defaultValue: "Atrás" })}
        onClick={goBack}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          arrow_back
        </span>
      </button>
    ) : null;
  const menuRef = useRef<HTMLDivElement | null>(null);
  const anchorX = contextMenu?.x ?? 0;
  const anchorY = contextMenu?.y ?? 0;
  const position = useViewportClampedMenu(menuRef, contextMenu, anchorX, anchorY);

  if (!contextMenu) {
    return null;
  }

  return (
    <div
      ref={menuRef}
      // En movil NO se ancla al dedo. Anclado, un menu largo -y el de tipos de
      // marca tiene 35 entradas- se sale de pantalla, y sus filas quedan del
      // tamano de un puntero. Como hoja inferior siempre cae dentro y los
      // destinos crecen a tamano de dedo. Mismo tratamiento que ya usaba la
      // biblioteca (`LibrarySidebarPanel`).
      className={`lt-context-menu${isMobileApp ? " is-mobile-sheet" : ""}`}
      style={
        isMobileApp
          ? undefined
          : {
              left: position.left,
              top: position.top,
              maxHeight: position.maxHeight,
            }
      }
      onClick={(event) => event.stopPropagation()}
    >
      {history.length > 0 ? (
        <BackStep key={history.length} onBack={goBack} />
      ) : null}
      {isMobileApp ? (
        // Como hoja inferior no hay "fuera del menu" evidente: media pantalla
        // es el propio menu y la otra media es timeline, donde tocar tiene sus
        // propias consecuencias. Un aspa evita tener que adivinar donde pulsar.
        <div className="lt-context-menu-sheet-header">
          {backButton}
          <strong>{contextMenu.title}</strong>
          <button
            type="button"
            className="lt-icon-button"
            aria-label={t("common.close", { defaultValue: "Cerrar" })}
            onClick={onDismiss}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              close
            </span>
          </button>
        </div>
      ) : backButton ? (
        <div className="lt-context-menu-header">
          {backButton}
          <strong>{contextMenu.title}</strong>
        </div>
      ) : (
        <strong>{contextMenu.title}</strong>
      )}
      {contextMenu.actions.map((action) => (
        <button
          key={action.label}
          type="button"
          disabled={action.disabled || !canEdit}
          onClick={() => {
            pendingParentRef.current = contextMenu;
            onDismiss();
            void action.onSelect();
          }}
        >
          {action.swatch ? (
            <span
              className="lt-context-menu-swatch"
              style={{ background: action.swatch }}
              aria-hidden="true"
            />
          ) : null}
          <span className="lt-context-menu-label">{action.label}</span>
          {action.shortcut ? (
            <kbd className="lt-context-menu-shortcut">{action.shortcut}</kbd>
          ) : null}
        </button>
      ))}
    </div>
  );
}
