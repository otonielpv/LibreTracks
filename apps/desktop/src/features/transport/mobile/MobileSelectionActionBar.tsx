import { useState } from "react";
import { useTranslation } from "react-i18next";
import { isMobileApp, type SongView } from "../desktopApi";
import {
  MultiTrackMixControls,
  type MultiTrackMixActions,
} from "../tracks/MultiTrackMixControls";
import { TrackEqButton } from "../eq/TrackEqButton";
import { trackTakesEq } from "../tracks/trackEqHandlers";
import { useRhythmStore } from "../rhythm/rhythmStore";
import { useTimelineUIStore } from "../uiStore";
import { TOUR_TARGETS } from "../../tutorial/tourTargets";
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
} from "./selectionBarVisibility";

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
  /** Volumen, paneo, salida y transposicion de las pistas seleccionadas. */
  mix: MultiTrackMixActions;
  audioRoutingOptions: Array<{ value: string; label: string }>;
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
  mix,
  audioRoutingOptions,
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
  // En el store, no aqui: es EXCLUYENTE con la fila desplegada de una cabecera
  // (son el mismo panel), y con una sola pista seleccionada salian los dos.
  const mixOpen = useTimelineUIStore((state) => state.selectionMixOpen);
  const areaSelectMode = useTimelineUIStore((state) => state.areaSelectMode);
  const selectedMarkers = useTimelineUIStore((state) => state.selectedMarkers);
  // El panel Ritmo se acopla abajo, justo donde flota esta barra: con los dos
  // a la vez la barra tapaba las filas del loop.
  const rhythmOpen = useRhythmStore((state) => state.openByView.daw);

  if (!isMobileApp || !menus || rhythmOpen) {
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
        // El anclaje va en LAS DOS ramas: recogida, el tutorial senalaria al
        // vacio, y su paso es justamente el que explica que la barra existe.
        data-lt-tour={TOUR_TARGETS.mobileSelectionBar}
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
    selectedMarkers,
  });
  const model = mobileSelectionBarModel({ target, menus, creation, t });
  if (model.actions.length === 0) {
    return null;
  }

  const hasSelection = target.kind !== "none";
  // Un modo sin rastro en pantalla es un modo que nadie encuentra: activarlo
  // tiene que cambiar algo visible y decir que toca hacer despues.
  const areaHint = t("mobileSelectionActions.areaSelectHint", {
    defaultValue: "Dibuja un recuadro o toca para sumar",
  });
  const mixTracks =
    target.kind === "tracks"
      ? target.tracks
      : target.kind === "track"
        ? [target.track]
        : [];
  const showMix = mixOpen && mixTracks.length > 0;
  const eqTracks = mixTracks.filter(trackTakesEq);
  // Seleccion por area: un recuadro con el dedo coge varias pistas o clips de
  // una vez, y los toques sueltos suman o quitan. Se ofrece SIEMPRE, tambien
  // sin nada seleccionado: es justo por donde se empieza a juntar un grupo.
  const toggleAreaSelect = () => {
    const store = useTimelineUIStore.getState();
    store.setAreaSelectMode(!areaSelectMode);
    // El panel de faders de una cabecera estorba justo cuando vas a dibujar
    // sobre ellas, y su desaparicion es la senal de que el modo ha entrado.
    if (!areaSelectMode) store.setExpandedTrackId(null);
  };
  const inline = model.actions.slice(0, MAX_INLINE_ACTIONS);
  const hasMore = model.actions.length > inline.length;

  return (
    <>
    {showMix ? (
      // El MISMO panel que despliega una cabecera al tocarla, aplicado a la
      // seleccion entera. Comparte la clase para heredar su aspecto y, sobre
      // todo, el tamano de agarre de sus faders.
      <div className="lt-mobile-track-row-panel lt-mobile-selection-mix">
        <MultiTrackMixControls
          tracks={mixTracks}
          routingOptions={audioRoutingOptions}
          mix={mix}
        />
      </div>
    ) : null}
    <div
      className="lt-mobile-selection-actions"
      data-lt-tour={TOUR_TARGETS.mobileSelectionBar}
      role="toolbar"
      aria-label={t("mobileClipActions.title", {
        defaultValue: "Acciones de la selección",
      })}
    >
      <span className="lt-mobile-selection-actions-title">
        {/* Un modo sin rastro en pantalla es un modo que nadie encuentra:
            activarlo no cambiaba NADA visible, asi que no habia forma de saber
            que tocaba hacer despues. */}
        {/* Con algo ya cogido manda la cuenta ("3 pistas"): es lo que
            confirma, recuadro a recuadro, que se esta sumando. */}
        {areaSelectMode && !hasSelection ? areaHint : model.title}
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
      {mixTracks.length > 0 ? (
        <button
          type="button"
          className={`lt-icon-button ${showMix ? "is-active" : ""}`}
          aria-label={t("mobileSelectionActions.mix", {
            defaultValue: "Mezcla",
          })}
          title={t("mobileSelectionActions.mix", { defaultValue: "Mezcla" })}
          aria-pressed={showMix}
          onClick={() =>
            useTimelineUIStore.getState().setSelectionMixOpen(!mixOpen)
          }
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            tune
          </span>
        </button>
      ) : null}
      {eqTracks.length > 0 ? (
        // Con varias pistas abre el editor de la primera y cada cambio va a
        // todas (plan track-eq-2, paso 02).
        <TrackEqButton
          trackId={eqTracks[0].id}
          className="lt-mobile-selection-action"
          targetTrackIds={eqTracks.map((track) => track.id)}
        />
      ) : null}
      <button
        type="button"
        className={`lt-icon-button ${areaSelectMode ? "is-active" : ""}`}
        aria-label={t("mobileSelectionActions.areaSelect", {
          defaultValue: "Seleccionar por área",
        })}
        title={t("mobileSelectionActions.areaSelect", {
          defaultValue: "Seleccionar por área",
        })}
        aria-pressed={areaSelectMode}
        onClick={toggleAreaSelect}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          select
        </span>
      </button>
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
    </>
  );
}
