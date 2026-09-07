import { useTranslation } from "react-i18next";
import { isMobileApp } from "../desktopApi";
import { useTimelineUIStore } from "../uiStore";
import type { ShortcutActionId } from "../keyboard/actions";

type MobileClipActionBarProps = {
  /** Dispara la MISMA accion que el atajo de teclado, por id. */
  runShortcutAction: (action: ShortcutActionId) => void;
};

const ACTIONS: Array<{
  action: ShortcutActionId;
  icon: string;
  labelKey: string;
  fallback: string;
}> = [
  {
    action: "edit.duplicate",
    icon: "content_copy",
    labelKey: "mobileClipActions.duplicate",
    fallback: "Duplicar",
  },
  {
    action: "edit.splitClip",
    icon: "content_cut",
    labelKey: "mobileClipActions.split",
    fallback: "Cortar en el cabezal",
  },
  {
    action: "edit.delete",
    icon: "delete",
    labelKey: "mobileClipActions.delete",
    fallback: "Eliminar",
  },
];

/**
 * Acciones de la seleccion, al alcance del pulgar.
 *
 * Aparece SOBRE la linea de tiempo y solo mientras hay clips seleccionados: no
 * la tapa ni sustituye la vista, que es lo que hacia inutil el intento
 * anterior ("cortar en el cabezal" con el cabezal escondido). Sale del mismo
 * patron que ya usa el escritorio —seleccionar y luego actuar—, pero sin menu
 * contextual, que en un movil obliga a acertar en un punto diminuto.
 *
 * No implementa nada: dispara por id las acciones del registro de atajos, asi
 * que dedo y teclado no pueden divergir.
 */
export function MobileClipActionBar({
  runShortcutAction,
}: MobileClipActionBarProps) {
  const { t } = useTranslation();
  const selectedClipIds = useTimelineUIStore((state) => state.selectedClipIds);
  if (!isMobileApp || selectedClipIds.length === 0) {
    return null;
  }

  return (
    <div
      className="lt-mobile-clip-actions"
      role="toolbar"
      aria-label={t("mobileClipActions.title", {
        defaultValue: "Acciones de la selección",
      })}
    >
      <span className="lt-mobile-clip-actions-count">
        {t("mobileClipActions.selected", {
          count: selectedClipIds.length,
          defaultValue: "{{count}} sel.",
        })}
      </span>
      {ACTIONS.map(({ action, icon, labelKey, fallback }) => (
        <button
          key={action}
          type="button"
          className="lt-icon-button"
          aria-label={t(labelKey, { defaultValue: fallback })}
          title={t(labelKey, { defaultValue: fallback })}
          onClick={() => runShortcutAction(action)}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            {icon}
          </span>
        </button>
      ))}
      <button
        type="button"
        className="lt-icon-button"
        aria-label={t("mobileClipActions.clear", {
          defaultValue: "Quitar selección",
        })}
        title={t("mobileClipActions.clear", { defaultValue: "Quitar selección" })}
        onClick={() => useTimelineUIStore.getState().setSelectedClipIds([])}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          close
        </span>
      </button>
    </div>
  );
}
