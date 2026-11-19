import { useRef, type PointerEvent as ReactPointerEvent } from "react";

import { buildSongTempoRegions, type SongView } from "../desktopApi";
import { LANE_REGIONS } from "../Renderer/drawBackground";
import { getElementScaleX, snapToTimelineGrid } from "../timeline/timelineMath";
import type { KeyChangeCallbacks } from "./keyChangeMenus";
import "./keyChanges.css";

/** Lo que se agarra a la izquierda de la muesca: el mástil mismo. */
const HOTSPOT_PAD_LEFT_PX = 6;
/** Y a la derecha, la pastilla de la nota (o casi toda, que es lo que se toca). */
const HOTSPOT_WIDTH_PX = 30;
/** Como el arrastre de marcas: por debajo de esto es un toque, no un arrastre. */
const DRAG_THRESHOLD_PX = 4;

type Drag = {
  regionId: string;
  changeId: string;
  pointerId: number;
  startClientX: number;
  scaleX: number;
  initialSeconds: number;
  previewSeconds: number;
  initialLeftPx: number;
  /** El `left` inline de antes del arrastre, para devolverlo tal cual. */
  initialLeftStyle: string;
  moved: boolean;
};

export type KeyChangeHotspotsProps = {
  song: SongView | null | undefined;
  pixelsPerSecond: number;
  livePixelsPerSecondRef: { current: number };
  snapEnabled: boolean | undefined;
  callbacks: KeyChangeCallbacks;
};

/**
 * Las zonas táctiles de los cambios de nota, sobre la banda de la canción del
 * ruler. El canvas las PINTA (keyChanges/drawKeyChanges); esto sólo recibe el
 * puntero: un toque (o clic derecho) abre su menú y arrastrar la mueve, con el
 * mismo ajuste a la rejilla que las marcas (Shift lo salta). Con Alt/Option al
 * soltar deja una copia y el original no se mueve.
 *
 * Viven dentro del contenedor del ruler que ya lleva `translateX(-cameraX)`,
 * así que la posición es `segundos × px/s`, como las zonas de las regiones.
 * El arrastre mueve el propio botón (con su línea lila) sin `setState`; el
 * motor sólo se toca al soltar.
 */
export function KeyChangeHotspots({
  song,
  pixelsPerSecond,
  livePixelsPerSecondRef,
  snapEnabled,
  callbacks,
}: KeyChangeHotspotsProps) {
  const dragRef = useRef<Drag | null>(null);
  const swallowClickRef = useRef(false);

  function begin(
    event: ReactPointerEvent<HTMLButtonElement>,
    regionId: string,
    changeId: string,
    startSeconds: number,
  ) {
    if (event.button !== 0) return;
    event.stopPropagation();
    swallowClickRef.current = false;
    dragRef.current = {
      regionId,
      changeId,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      scaleX: getElementScaleX(
        event.currentTarget.getBoundingClientRect(),
        event.currentTarget.offsetWidth,
      ),
      initialSeconds: startSeconds,
      previewSeconds: startSeconds,
      initialLeftPx: event.currentTarget.offsetLeft,
      initialLeftStyle: event.currentTarget.style.left,
      moved: false,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Algún motor rechaza la captura en un elemento aún sin hover.
    }
  }

  function update(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !song) return;
    const deltaPx = (event.clientX - drag.startClientX) / drag.scaleX;
    if (!drag.moved && Math.abs(event.clientX - drag.startClientX) < DRAG_THRESHOLD_PX) {
      return;
    }
    drag.moved = true;
    const pps = livePixelsPerSecondRef.current || pixelsPerSecond;
    let seconds = drag.initialSeconds + deltaPx / pps;
    if (snapEnabled && !event.shiftKey) {
      seconds = snapToTimelineGrid(
        seconds,
        song.bpm,
        song.timeSignature,
        1,
        pps,
        buildSongTempoRegions(song),
      );
    }
    drag.previewSeconds = seconds;
    const element = event.currentTarget;
    element.style.left = `${drag.initialLeftPx + (seconds - drag.initialSeconds) * pixelsPerSecond}px`;
    element.classList.add("is-dragging");
  }

  function end(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.classList.remove("is-dragging");
    if (!drag.moved) return;
    swallowClickRef.current = true;
    const changed = Math.abs(drag.previewSeconds - drag.initialSeconds) > 1e-6;
    // Alt/Option al soltar copia: el original se queda donde estaba.
    const copy = event.altKey;
    if (changed) {
      callbacks.move(drag.regionId, drag.changeId, drag.previewSeconds, copy);
    }
    if (!changed || copy) {
      event.currentTarget.style.left = drag.initialLeftStyle;
    }
  }

  return (
    <>
      {song?.regions.flatMap((region) =>
        (region.keyChanges ?? []).map((change) => (
          <button
            key={`${region.id}:${change.id}`}
            type="button"
            className="lt-key-change-hotspot"
            data-key-change-id={change.id}
            aria-label={`Cambio de nota a ${change.key}`}
            title={`Cambio de nota: ${change.key}`}
            style={{
              left: change.startSeconds * pixelsPerSecond - HOTSPOT_PAD_LEFT_PX,
              top: LANE_REGIONS.top,
              height: LANE_REGIONS.height,
              width: HOTSPOT_WIDTH_PX,
              ["--lt-key-change-stem" as string]: `${HOTSPOT_PAD_LEFT_PX}px`,
            }}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onPointerDown={(event) =>
              begin(event, region.id, change.id, change.startSeconds)
            }
            onPointerMove={update}
            onPointerUp={end}
            onPointerCancel={end}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (swallowClickRef.current) {
                swallowClickRef.current = false;
                return;
              }
              callbacks.openMenu(event.clientX, event.clientY, region.id, change.id);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              callbacks.openMenu(event.clientX, event.clientY, region.id, change.id);
            }}
          >
            <span className="lt-sr-only">{change.key}</span>
          </button>
        )),
      )}
    </>
  );
}
