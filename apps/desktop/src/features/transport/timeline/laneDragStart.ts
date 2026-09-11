import type { MutableRefObject, PointerEvent as ReactPointerEvent } from "react";

/**
 * Cual de los dos eventos arma el arrastre de un clip.
 *
 * Con raton, el `mousedown` de siempre. Con el dedo no sirve: iOS emite el
 * `mousedown` de COMPATIBILIDAD al soltar, no al tocar, asi que un arrastre
 * jamas lo ve —el clip se seleccionaba y despues no habia forma de moverlo—.
 * Ahi arma el `pointerdown`, que ademas trae el identificador con el que
 * useDragListeners empareja los movimientos del dedo.
 *
 * Al carril solo llegan los toques que la navegacion tactil ha CEDIDO (un clip
 * que ya estaba seleccionado); el resto los para ella en captura, asi que aqui
 * no hace falta volver a decidir si el gesto era para navegar.
 */

/**
 * Cuanto dura el eco. Ese `mousedown` tardio armaria un SEGUNDO arrastre, ya
 * muerto, encima del que acaba de terminar.
 */
export const COMPAT_MOUSE_GRACE_MS = 1000;

/** Toque sobre un carril: anota el instante y dice si arma el arrastre. */
export function armLaneTouchDrag(
  event: ReactPointerEvent<HTMLDivElement>,
  lastTouchAtRef: MutableRefObject<number>,
  now = Date.now(),
): boolean {
  if (event.pointerType !== "touch") {
    return false;
  }
  lastTouchAtRef.current = now;
  return true;
}

/** ¿Este `mousedown` es de un raton, o el eco tardio de un dedo? */
export function laneMouseDragAllowed(
  lastTouchAtRef: MutableRefObject<number>,
  now = Date.now(),
): boolean {
  return now - lastTouchAtRef.current >= COMPAT_MOUSE_GRACE_MS;
}
