import {
  useMemo,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { isMobileApp, type RulerMarkerRef, type SongView } from "../desktopApi";
import { markerCategory } from "../markerKinds";
import {
  LANE_CUES,
  LANE_SECTIONS,
  TEMPO_FLAG_BAND,
  TIME_SIGNATURE_FLAG_BAND,
} from "../Renderer/drawBackground";
import {
  MARKER_FLAG_GAP_PX,
  markerFlagLabel,
  measureMarkerFlagWidth,
} from "../Renderer/markerFlagMetrics";
import type { useTouchContextMenu } from "../timeline/useTouchContextMenu";
import type { MarkerMoveKind } from "../timeline/useMarkerMoveDrag";
import type { MarkerCategory } from "@libretracks/shared/models";
import { selectedRulerMarkers, useTimelineUIStore } from "../uiStore";
import {
  groupContaining,
  handleRulerMarkerClick,
  includesRulerMarker,
} from "./rulerMarkerSelection";
import { MidiLearnBadge } from "../midi/MidiMappable";

/** Margen de agarre a la IZQUIERDA del mastil de una marca. La bandera se
 * dibuja a la derecha, asi que sin este margen el mastil en si mismo -que es lo
 * que el usuario apunta cuando quiere mover la marca- quedaria fuera de la zona
 * tactil. Un dedo no necesita mas: lo ancho del boton lo da la bandera. */
const MARKER_HOTSPOT_PAD_LEFT_PX = 6;

type ButtonPointer = ReactPointerEvent<HTMLButtonElement>;
type ButtonMouse = ReactMouseEvent<HTMLButtonElement>;

export type RulerMarkerHotspotsProps = {
  song: SongView | null | undefined;
  pixelsPerSecond: number;
  markerMovePreviewLane: { markerId: string; category: MarkerCategory } | null;
  markerTouchContextMenu: ReturnType<typeof useTouchContextMenu>;
  beginMarkerMove: (
    event: ButtonPointer,
    markerId: string,
    startSeconds: number,
    kind?: MarkerMoveKind,
    group?: RulerMarkerRef[] | null,
  ) => void;
  updateMarkerMove: (event: ButtonPointer) => void;
  endMarkerMove: (event: ButtonPointer) => void;
  markerDidDragRef: MutableRefObject<boolean>;
  midiLearnMode: string | null;
  onMidiLearnTarget: (controlKey: string) => boolean;
  onMarkerPrimaryAction: (sectionId: string) => void;
  onMarkerContextMenu: (event: ButtonMouse, sectionId: string) => void;
  onTempoMarkerContextMenu: (event: ButtonMouse, markerId: string) => void;
  onTimeSignatureMarkerContextMenu: (event: ButtonMouse, markerId: string) => void;
  /** Clic derecho sobre una marca de una seleccion MULTIPLE: el menu del grupo. */
  onRulerMarkersContextMenu?: (event: ButtonMouse, markers: RulerMarkerRef[]) => void;
};

/**
 * Las zonas tactiles de las marcas de la regla (secciones/avisos, tempo y
 * compas). El canvas las PINTA; esto solo recibe el puntero.
 *
 * Seleccion multiple, en escritorio y movil:
 * - Ctrl/Cmd+clic (o un toque con el modo area en movil) pone o quita una
 *   marca SIN programar el salto.
 * - Shift+clic coge todas las marcas entre la ultima elegida y esta.
 * - Arrastrar una marca de la seleccion mueve el grupo entero.
 * - Clic derecho sobre una de ellas abre el menu del grupo.
 *
 * Tempo y compas solo se arrastran si estan seleccionados: moverlos cambia el
 * tempo de lo que sigue, y no puede pasar por rozarlos sin querer.
 */
export function RulerMarkerHotspots({
  song,
  pixelsPerSecond,
  markerMovePreviewLane,
  markerTouchContextMenu,
  beginMarkerMove,
  updateMarkerMove,
  endMarkerMove,
  markerDidDragRef,
  midiLearnMode,
  onMidiLearnTarget,
  onMarkerPrimaryAction,
  onMarkerContextMenu,
  onTempoMarkerContextMenu,
  onTimeSignatureMarkerContextMenu,
  onRulerMarkersContextMenu,
}: RulerMarkerHotspotsProps) {
  // Campos sueltos y no `selectedRulerMarkers(state)` en el selector: esa
  // funcion construye un array nuevo con una sola marca, y un selector que no
  // devuelve lo mismo dos veces seguidas re-renderiza sin fin.
  const selectedMarkers = useTimelineUIStore((state) => state.selectedMarkers);
  const selectedSectionId = useTimelineUIStore((state) => state.selectedSectionId);
  const selectedTempoMarkerId = useTimelineUIStore(
    (state) => state.selectedTempoMarkerId,
  );
  const selectedTimeSignatureMarkerId = useTimelineUIStore(
    (state) => state.selectedTimeSignatureMarkerId,
  );
  const selected = useMemo(
    () =>
      selectedRulerMarkers({
        selectedMarkers,
        selectedSectionId,
        selectedTempoMarkerId,
        selectedTimeSignatureMarkerId,
      }),
    [selectedMarkers, selectedSectionId, selectedTempoMarkerId, selectedTimeSignatureMarkerId],
  );
  const areaSelectMode = useTimelineUIStore((state) => state.areaSelectMode);

  const clickModifiers = (event: ButtonMouse) => ({
    additive: event.ctrlKey || event.metaKey || (isMobileApp && areaSelectMode),
    range: event.shiftKey,
  });

  /** El menu del grupo si la marca es parte de una seleccion multiple. */
  const openGroupMenu = (event: ButtonMouse, marker: RulerMarkerRef) => {
    const group = groupContaining(marker);
    if (!group || !onRulerMarkersContextMenu) return false;
    event.preventDefault();
    onRulerMarkersContextMenu(event, group);
    return true;
  };

  /** Comun a tempo y compas: la seleccion decide si se arrastra. */
  const lowerLaneHandlers = (
    marker: RulerMarkerRef,
    startSeconds: number,
    select: () => void,
    openMenu: (event: ButtonMouse) => void,
  ) => ({
    onMouseDown: (event: ButtonMouse) => {
      event.preventDefault();
      event.stopPropagation();
    },
    onPointerDown: (event: ButtonPointer) => {
      markerTouchContextMenu.begin(event);
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        !includesRulerMarker(selected, marker)
      ) {
        return;
      }
      event.stopPropagation();
      beginMarkerMove(event, marker.id, startSeconds, "marker", groupContaining(marker) ?? [marker]);
    },
    onPointerMove: (event: ButtonPointer) => {
      markerTouchContextMenu.move(event);
      updateMarkerMove(event);
    },
    onPointerUp: (event: ButtonPointer) => {
      markerTouchContextMenu.cancel();
      endMarkerMove(event);
    },
    onPointerCancel: (event: ButtonPointer) => {
      markerTouchContextMenu.cancel();
      endMarkerMove(event);
    },
    onClick: (event: ButtonMouse) => {
      event.stopPropagation();
      if (markerTouchContextMenu.consumeTriggered()) {
        return;
      }
      if (markerDidDragRef.current) {
        markerDidDragRef.current = false;
        return;
      }
      if (handleRulerMarkerClick(song, marker, clickModifiers(event))) {
        return;
      }
      // Tocarla la selecciona: en movil la barra ensena sus acciones, y en
      // escritorio es el ancla de Shift+clic y lo que luego se arrastra.
      select();
    },
    onContextMenu: (event: ButtonMouse) => {
      event.stopPropagation();
      if (openGroupMenu(event, marker)) return;
      openMenu(event);
    },
  });

  // jump_marker_N counts section markers only, in time order (as dispatch).
  const sectionJumpIndex = new Map(
    [...(song?.sectionMarkers ?? [])]
      .filter((candidate) => markerCategory(candidate) === "section")
      .sort((left, right) => left.startSeconds - right.startSeconds)
      .map((candidate, index) => [candidate.id, index + 1]),
  );

  return (
    <>
      {song?.sectionMarkers.map((section) => {
        const ref: RulerMarkerRef = { kind: "section", id: section.id };
        // La zona tactil se mide contra la bandera QUE SE DIBUJA, con las
        // mismas funciones que usa el canvas (ver Renderer/
        // markerFlagMetrics). El ancho fijo anterior -68px en escritorio,
        // una estimacion por caracteres en movil- sobraba por la derecha
        // y se tragaba los toques dirigidos a la marca siguiente.
        const flagWidth = measureMarkerFlagWidth(markerFlagLabel(section));
        const hotspotWidth =
          MARKER_HOTSPOT_PAD_LEFT_PX + MARKER_FLAG_GAP_PX + flagWidth;
        // El carril previsualizado SÍ pasa por React: cambia una o dos
        // veces por gesto, no por píxel. La posición no: la escribe el
        // bucle de hotspots leyendo el ref.
        const isDraggingMarker = markerMovePreviewLane?.markerId === section.id;
        // Cue markers live in their own lane above the section lane so a
        // cue and a section sharing a position don't stack on one pixel.
        // Mid-drag the hotspot follows the pointer across lanes, so the
        // flag previews the category the drop would apply.
        const renderCategory = isDraggingMarker
          ? markerMovePreviewLane.category
          : markerCategory(section);
        const lane = renderCategory === "cue" ? LANE_CUES : LANE_SECTIONS;
        const isSelected = includesRulerMarker(selected, ref);
        return (
          <button
            key={section.id}
            type="button"
            className={`lt-marker-hotspot ${isSelected ? "is-selected" : ""}${isDraggingMarker ? " is-dragging" : ""}`}
            aria-label={`${section.name} - carril central`}
            aria-pressed={isSelected}
            title={`Carril central: ${section.name}`}
            style={{
              left: section.startSeconds * pixelsPerSecond,
              top: lane.top,
              height: lane.height,
              width: hotspotWidth,
              // El desplazamiento va por variable, no por `margin-left`: el
              // envoltorio del ruler escala en X durante el zoom y la regla
              // de .lt-marker-hotspot lo contra-escala junto con el ancho.
              ["--lt-hotspot-offset-x" as string]: `${-MARKER_HOTSPOT_PAD_LEFT_PX}px`,
            }}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
              if (event.altKey || event.ctrlKey || event.metaKey) return;
              markerTouchContextMenu.begin(event);
              beginMarkerMove(
                event,
                section.id,
                section.startSeconds,
                "marker",
                groupContaining(ref),
              );
            }}
            onPointerMove={(event) => {
              markerTouchContextMenu.move(event);
              updateMarkerMove(event);
            }}
            onPointerUp={(event) => {
              markerTouchContextMenu.cancel();
              endMarkerMove(event);
            }}
            onPointerCancel={(event) => {
              markerTouchContextMenu.cancel();
              endMarkerMove(event);
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (markerTouchContextMenu.consumeTriggered()) {
                return;
              }
              // A drag just finished — swallow the synthetic click so the
              // marker isn't also triggered/seeked. (The drag ref is
              // already nulled by pointer-up, hence the separate flag.)
              if (markerDidDragRef.current) {
                markerDidDragRef.current = false;
                return;
              }
              if (midiLearnMode !== null) {
                // jump_marker_N indexes only section markers (cues are not
                // jump targets), so the index must match the section-only,
                // time-sorted order the jump dispatch uses.
                const chronologicalMarkers = [...(song?.sectionMarkers ?? [])]
                  .filter((candidate) => markerCategory(candidate) === "section")
                  .sort((left, right) => left.startSeconds - right.startSeconds);
                const markerIndex = chronologicalMarkers.findIndex(
                  (candidate) => candidate.id === section.id,
                );
                if (markerIndex >= 0) {
                  onMidiLearnTarget(`action:jump_marker_${markerIndex + 1}`);
                }
                return;
              }
              // Ctrl/Shift (o el modo area) eligen marcas: no programan el salto.
              if (handleRulerMarkerClick(song, ref, clickModifiers(event))) {
                return;
              }
              onMarkerPrimaryAction(section.id);
            }}
            onContextMenu={(event) => {
              event.stopPropagation();
              if (openGroupMenu(event, ref)) return;
              onMarkerContextMenu(event, section.id);
            }}
          >
            <span className="lt-sr-only">{section.name}</span>
            <MidiLearnBadge
              target={
                sectionJumpIndex.has(section.id)
                  ? `action:jump_marker_${sectionJumpIndex.get(section.id)}`
                  : null
              }
            />
          </button>
        );
      })}

      {song?.tempoMarkers.map((marker) => {
        const ref: RulerMarkerRef = { kind: "tempo", id: marker.id };
        return (
          <button
            key={marker.id}
            type="button"
            className={`lt-tempo-hotspot ${includesRulerMarker(selected, ref) ? "is-selected" : ""}`}
            aria-label={`Carril inferior: tempo ${marker.bpm.toFixed(2)} BPM`}
            aria-pressed={includesRulerMarker(selected, ref)}
            title={`Carril inferior: tempo ${marker.bpm.toFixed(2)} BPM`}
            // Su banda, no el carril entero: con un tempo y un compas en el
            // mismo punto, la zona del compas -que se pinta despues- se
            // comia todos los clics.
            style={{
              left: marker.startSeconds * pixelsPerSecond,
              top: TEMPO_FLAG_BAND.top,
              height: TEMPO_FLAG_BAND.height,
            }}
            {...lowerLaneHandlers(
              ref,
              marker.startSeconds,
              () => useTimelineUIStore.getState().selectTempoMarker(marker.id),
              (event) => onTempoMarkerContextMenu(event, marker.id),
            )}
          >
            <span className="lt-sr-only">{marker.bpm.toFixed(2)} BPM</span>
          </button>
        );
      })}

      {song?.timeSignatureMarkers.map((marker) => {
        const ref: RulerMarkerRef = { kind: "timeSignature", id: marker.id };
        return (
          <button
            key={marker.id}
            type="button"
            className={`lt-tempo-hotspot lt-time-signature-hotspot ${includesRulerMarker(selected, ref) ? "is-selected" : ""}`}
            aria-label={`Carril inferior: compás ${marker.signature}`}
            aria-pressed={includesRulerMarker(selected, ref)}
            title={`Carril inferior: compás ${marker.signature}`}
            style={{
              left: marker.startSeconds * pixelsPerSecond,
              top: TIME_SIGNATURE_FLAG_BAND.top,
              height: TIME_SIGNATURE_FLAG_BAND.height,
            }}
            {...lowerLaneHandlers(
              ref,
              marker.startSeconds,
              () => useTimelineUIStore.getState().selectTimeSignatureMarker(marker.id),
              (event) => onTimeSignatureMarkerContextMenu(event, marker.id),
            )}
          >
            <span className="lt-sr-only">{marker.signature}</span>
          </button>
        );
      })}
    </>
  );
}
