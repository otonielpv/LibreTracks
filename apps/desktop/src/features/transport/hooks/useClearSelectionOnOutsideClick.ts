import { useEffect } from "react";

import { useTimelineUIStore } from "../uiStore";

/**
 * Deseleccionar pulsando FUERA, en cualquier sitio.
 *
 * Antes la selección sólo se limpiaba con Escape, así que en móvil -sin
 * teclado- una pista se quedaba marcada para siempre. Limitarlo a los huecos
 * vacíos tampoco valía: con muchas pistas hay que bajar hasta el final de la
 * columna para encontrar uno.
 *
 * La regla es "cualquier pulsación que no sea de la selección la deshace", con
 * tres salvedades:
 *
 * 1. ARRASTRAR NO ES PULSAR. Mover la cámara o un fader emite igualmente un
 *    `click` al soltar, y perder la selección por mover la vista sería peor que
 *    el problema que esto arregla.
 * 2. Hay superficies con semántica propia -abajo- que se manejan solas o que
 *    LEEN la selección al pulsarlas. Ahí no tocamos nada.
 * 3. Red de seguridad para lo que no esté en esa lista: si durante la misma
 *    pulsación alguien ha seleccionado algo (una marca de sección, un clip),
 *    la selección se respeta. Así una superficie nueva que seleccione no se
 *    rompe en silencio por no estar apuntada aquí.
 */

const SELECTION_OWNED_SURFACES = [
  // La selección en persona: pulsarlas ya la decide.
  ".lt-track-header-row",
  ".lt-compact-mixer-strip",
  // El carril distingue clip de fondo por su cuenta (ver
  // ../timeline/timelineBackgroundSeek): sin esto, volver a pulsar un clip ya
  // seleccionado lo deseleccionaría, porque el store no cambia.
  ".lt-track-lane-row",
  // Menús, diálogos y popovers: sus acciones operan sobre la selección.
  ".lt-context-menu",
  ".lt-color-popover",
  ".lt-top-menu",
  ".lt-mobile-file-menu",
  ".lt-dialog-layer",
  ".lt-modal-backdrop",
].join(", ");

/** Mismo umbral que el resto de arrastres del timeline. */
const DRAG_TOLERANCE_PX = 4;

type SelectionSignature = readonly [string[], string[], string | null, string | null];

function selectionSignature(): SelectionSignature {
  const state = useTimelineUIStore.getState();
  return [
    state.selectedTrackIds,
    state.selectedClipIds,
    state.selectedClipId,
    state.selectedSectionId,
  ];
}

function sameSelection(before: SelectionSignature, after: SelectionSignature) {
  return before.every((value, index) => value === after[index]);
}

export function useClearSelectionOnOutsideClick(): void {
  useEffect(() => {
    // `mousedown` y no `pointerdown`: los WebViews móviles emiten los eventos
    // de ratón de compatibilidad del toque, y alguno no trae PointerEvent.
    // En captura para que ningún hijo pueda quitárnoslo con stopPropagation.
    let gesture: { x: number; y: number; selection: SelectionSignature } | null =
      null;

    const onMouseDown = (event: MouseEvent) => {
      gesture = {
        x: event.clientX,
        y: event.clientY,
        selection: selectionSignature(),
      };
    };

    // En burbuja: así llega después de que React haya resuelto la pulsación, y
    // lo que se detenga por el camino (una pulsación larga que abre menú) no
    // nos llega, que es justo lo que queremos.
    const onClick = (event: MouseEvent) => {
      const started = gesture;
      gesture = null;
      if (!started) {
        return;
      }
      if (
        Math.hypot(event.clientX - started.x, event.clientY - started.y) >
        DRAG_TOLERANCE_PX
      ) {
        return;
      }
      if (!sameSelection(started.selection, selectionSignature())) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest(SELECTION_OWNED_SURFACES)) {
        return;
      }
      useTimelineUIStore.getState().clearSelectionIfAny();
    };

    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("click", onClick);
    };
  }, []);
}
