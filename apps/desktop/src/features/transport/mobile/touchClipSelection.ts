import { useMemo, useRef, type MutableRefObject } from "react";
import type { ClipSummary } from "../desktopApi";
import { lanePointerToClip } from "../helpers";
import { useTimelineUIStore } from "../uiStore";

type TouchClipSelectionDeps = {
  /** Clips por pista, tal y como se estan pintando ahora mismo. */
  getClipsByTrack: () => Record<string, ClipSummary[]>;
  getSelectedClipIds: () => string[];
  getCameraX: () => number;
  getPixelsPerSecond: () => number;
  selectClips: (clipIds: string[]) => void;
  /** Sumando: cada toque anade o quita el clip, en vez de reemplazar. */
  isMultiSelect: () => boolean;
  toggleClip: (clipId: string) => void;
  /**
   * Soltar la region seleccionada.
   *
   * `selectClips([])` limpia clips, pistas y marcas —el store las limpia entre
   * si—, pero la region vive en un `useState` aparte que nadie tocaba: tras
   * tocar una region, el toque en el fondo dejaba la barra de acciones
   * mostrando sus acciones como si siguiera seleccionada.
   */
  clearRegionSelection: () => void;
};

/**
 * Reglas de toque de la linea de tiempo en movil y tablet.
 *
 * Sustituye al boton de modo navegar/editar, que obligaba a recordar en cual
 * estabas y a cambiarlo antes de cada accion:
 *
 * - Un dedo desplaza el lienzo. Siempre.
 * - Tocar sin arrastrar selecciona el clip que hay debajo (o limpia).
 * - Arrastrar algo YA seleccionado lo mueve, con los handlers de siempre.
 *
 * Lo segundo y lo tercero juntos hacen que editar sea deliberado: hace falta
 * seleccionar primero, asi que ningun arrastre suelto mueve audio por accidente.
 *
 * Todo entra por getters a proposito: la factory se instancia una vez y no
 * puede recrearse por render, porque de ella cuelga el gesto (ver
 * `docs/REDESIGN_transport_refs_to_stores.md`).
 */
export function createTouchClipSelection(deps: TouchClipSelectionDeps) {
  /**
   * Los clips se pintan en canvas, pero encima hay filas HTML con
   * `data-track-id` que son las que reciben los eventos. Desde el destino del
   * toque subimos a su fila y reusamos el mismo hit-test que el raton, para que
   * dedo y raton no puedan discrepar sobre que clip hay bajo un punto.
   */
  function clipAt(clientX: number, target: EventTarget | null) {
    const row =
      target instanceof Element
        ? (target.closest("[data-track-id]") as HTMLElement | null)
        : null;
    const trackId = row?.dataset.trackId;
    if (!row || !trackId) return null;
    return lanePointerToClip(
      deps.getClipsByTrack()[trackId] ?? [],
      row,
      clientX,
      deps.getCameraX(),
      deps.getPixelsPerSecond(),
    );
  }

  return {
    /** Cede el gesto a la edicion solo sobre un clip ya seleccionado. */
    shouldEdit(clientX: number, _clientY: number, target: EventTarget | null) {
      const clip = clipAt(clientX, target);
      return Boolean(clip && deps.getSelectedClipIds().includes(clip.id));
    },
    /** Toque limpio: selecciona lo que haya debajo, o limpia la seleccion. */
    onTap(clientX: number, _clientY: number, target: EventTarget | null) {
      const clip = clipAt(clientX, target);
      // Sumando, el toque sobre un clip lo anade o lo quita. Es la unica forma
      // de juntar varios con un dedo: no hay Ctrl que mantener. Fuera de un
      // clip se sale igual, soltandolo todo: si no, no habria manera de salir
      // del modo sin borrar algo.
      if (clip && deps.isMultiSelect()) {
        deps.toggleClip(clip.id);
        return;
      }
      deps.selectClips(clip ? [clip.id] : []);
      if (!clip) {
        deps.clearRegionSelection();
      }
    },
  };
}

/**
 * Cablea las reglas de arriba a los stores y refs vivos del timeline.
 *
 * La factory se memoiza con dependencias estables (solo refs) y los datos que
 * cambian cada render entran por un ref espejo, para que el gesto no se
 * reconstruya mientras el dedo esta apoyado.
 */
export function useTouchClipSelection(
  clipsByTrack: Record<string, ClipSummary[]>,
  cameraXRef: MutableRefObject<number>,
  pixelsPerSecondRef: MutableRefObject<number>,
  clearRegionSelection: () => void,
) {
  const clipsRef = useRef(clipsByTrack);
  clipsRef.current = clipsByTrack;
  // Espejo: llega como flecha nueva en cada render y el gesto no puede
  // reconstruirse con el dedo apoyado.
  const clearRegionRef = useRef(clearRegionSelection);
  clearRegionRef.current = clearRegionSelection;
  return useMemo(
    () =>
      createTouchClipSelection({
        getClipsByTrack: () => clipsRef.current,
        getSelectedClipIds: () => useTimelineUIStore.getState().selectedClipIds,
        getCameraX: () => cameraXRef.current,
        getPixelsPerSecond: () => pixelsPerSecondRef.current,
        selectClips: (clipIds) =>
          useTimelineUIStore.getState().setSelectedClipIds(clipIds),
        isMultiSelect: () => useTimelineUIStore.getState().clipMultiSelect,
        toggleClip: (clipId) =>
          useTimelineUIStore.getState().toggleClipSelection(clipId),
        clearRegionSelection: () => clearRegionRef.current(),
      }),
    [cameraXRef, pixelsPerSecondRef],
  );
}
