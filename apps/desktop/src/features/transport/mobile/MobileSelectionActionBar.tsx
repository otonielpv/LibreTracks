import { useState } from "react";
import { useTranslation } from "react-i18next";
import { isMobileApp, type SongView } from "../desktopApi";
import { useTimelineUIStore } from "../uiStore";
import type { ContextMenuAction } from "../types";
import {
  mobileSelectionBarModel,
  resolveMobileSelection,
  type MobileCreationHandlers,
  type MobileSelectionMenus,
} from "./selectionActions";
import {
  persistSelectionBarOpen,
  readSelectionBarOpen,
} from "./liveSettingsGroup";

/**
 * Cuantas acciones se pintan en la barra antes de mandar el resto a la hoja.
 * Tres cabe de sobra en un movil en horizontal con la cuenta y el aspa; la
 * cuarta ya empieza a empujar las etiquetas a una sola letra.
 */
const MAX_INLINE_ACTIONS = 3;

type MobileSelectionActionBarProps = {
  song: SongView | null;
  selectedRegionId: string | null;
  /**
   * Las factories del menu contextual del escritorio. `null` hasta que el
   * panel ha commiteado su primer render: las factories leen sus dependencias
   * de un ref que se sincroniza en un efecto, y llamarlas antes revienta.
   */
  menus: MobileSelectionMenus | null;
  creation: MobileCreationHandlers;
  /** Abre la lista COMPLETA como hoja inferior (el menu contextual de siempre). */
  onOpenSheet: (title: string, actions: ContextMenuAction[]) => void;
  onClearSelection: () => void;
};

/**
 * Acciones de LO SELECCIONADO, al alcance del pulgar.
 *
 * Antes solo entendia de clips; ahora resuelve marca, clip, region o pista, y
 * sin seleccion ofrece las acciones de creacion, que es lo que necesita ver
 * alguien que abre la app por primera vez.
 *
 * No reimplementa ninguna accion: las saca de las mismas factories que
 * alimentan el clic derecho del escritorio, asi que dedo y raton no pueden
 * divergir. Lo que no cabe en la barra no se pierde —el boton de puntos abre
 * la lista entera como hoja inferior—, que es justo lo que hacia impracticable
 * la version anterior en un telefono.
 *
 * Flota SOBRE el timeline: el cabezal y la regla siguen visibles, que es la
 * regla que incumplio el panel "Preparar cancion" que se revirtio.
 */
export function MobileSelectionActionBar({
  song,
  selectedRegionId,
  menus,
  creation,
  onOpenSheet,
  onClearSelection,
}: MobileSelectionActionBarProps) {
  const { t } = useTranslation();
  const selectedClipIds = useTimelineUIStore((state) => state.selectedClipIds);
  const selectedSectionId = useTimelineUIStore(
    (state) => state.selectedSectionId,
  );
  const selectedTrackIds = useTimelineUIStore(
    (state) => state.selectedTrackIds,
  );
  const selectedTempoMarkerId = useTimelineUIStore(
    (state) => state.selectedTempoMarkerId,
  );
  const selectedTimeSignatureMarkerId = useTimelineUIStore(
    (state) => state.selectedTimeSignatureMarkerId,
  );
  const [open, setOpen] = useState(readSelectionBarOpen);
  const trackMultiSelect = useTimelineUIStore(
    (state) => state.trackMultiSelect,
  );

  if (!isMobileApp || !menus) {
    return null;
  }

  const setBarOpen = (next: boolean) => {
    setOpen(next);
    persistSelectionBarOpen(next);
  };

  // Recogida queda una pestana, no nada: esconderla del todo devolveria el
  // problema que la barra vino a resolver —que no hay nada en pantalla que
  // diga por donde se empieza—. Su estado sobrevive a cerrar la app, asi que
  // quien ya se sabe la app la recoge una vez.
  if (!open) {
    return (
      <button
        type="button"
        className="lt-mobile-selection-actions-tab"
        aria-label={t("mobileSelectionActions.show", {
          defaultValue: "Mostrar acciones",
        })}
        aria-expanded={false}
        onClick={() => setBarOpen(true)}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          expand_less
        </span>
      </button>
    );
  }

  const target = resolveMobileSelection({
    song,
    selectedClipIds,
    selectedSectionId,
    selectedRegionId,
    selectedTrackIds,
    selectedTempoMarkerId,
    selectedTimeSignatureMarkerId,
  });
  const model = mobileSelectionBarModel({ target, menus, creation, t });
  if (model.actions.length === 0) {
    return null;
  }

  const hasSelection = target.kind !== "none";
  const isTrackTarget = target.kind === "track" || target.kind === "tracks";
  const inline = model.actions.slice(0, MAX_INLINE_ACTIONS);
  const hasMore = model.actions.length > inline.length;

  return (
    <div
      className="lt-mobile-selection-actions"
      role="toolbar"
      aria-label={t("mobileClipActions.title", {
        defaultValue: "Acciones de la selección",
      })}
    >
      <span className="lt-mobile-selection-actions-title">
        {/* Un modo sin rastro en pantalla es un modo que nadie encuentra:
            activarlo no cambiaba NADA visible, asi que no habia forma de saber
            que tocaba hacer despues. */}
        {trackMultiSelect && target.kind === "track"
          ? t("mobileSelectionActions.multiSelectHint", {
              defaultValue: "Toca más pistas",
            })
          : model.title}
      </span>
      {inline.map((action) => (
        <button
          key={action.label}
          type="button"
          className="lt-mobile-selection-action"
          disabled={action.disabled}
          onClick={() => {
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
          {action.label}
        </button>
      ))}
      {hasMore ? (
        <button
          type="button"
          className="lt-icon-button"
          aria-label={t("mobileSelectionActions.more", {
            defaultValue: "Más acciones",
          })}
          title={t("mobileSelectionActions.more", {
            defaultValue: "Más acciones",
          })}
          // Abre la lista ENTERA, no solo el sobrante: asi el usuario que busca
          // algo siempre lo encuentra en el mismo sitio, tenga o no un atajo
          // en la barra.
          onClick={() => onOpenSheet(model.title, model.actions)}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            more_horiz
          </span>
        </button>
      ) : null}
      {isTrackTarget ? (
        <button
          type="button"
          className={`lt-icon-button ${trackMultiSelect ? "is-active" : ""}`}
          aria-label={t("mobileSelectionActions.multiSelect", {
            defaultValue: "Seleccionar varias pistas",
          })}
          aria-pressed={trackMultiSelect}
          // Con un dedo no hay Ctrl que mantener. Activado, cada toque en una
          // cabecera suma o quita esa pista, y las acciones pasan a ser las de
          // la seleccion entera —incluido borrarlas de un tiron—.
          onClick={() =>
            useTimelineUIStore.getState().setTrackMultiSelect(!trackMultiSelect)
          }
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            checklist
          </span>
        </button>
      ) : null}
      {hasSelection ? (
        <button
          type="button"
          className="lt-icon-button"
          aria-label={t("mobileClipActions.clear", {
            defaultValue: "Quitar selección",
          })}
          title={t("mobileClipActions.clear", {
            defaultValue: "Quitar selección",
          })}
          onClick={onClearSelection}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            close
          </span>
        </button>
      ) : null}
      <button
        type="button"
        className="lt-icon-button lt-mobile-selection-actions-hide"
        aria-label={t("mobileSelectionActions.hide", {
          defaultValue: "Ocultar acciones",
        })}
        aria-expanded
        onClick={() => setBarOpen(false)}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          expand_more
        </span>
      </button>
    </div>
  );
}
