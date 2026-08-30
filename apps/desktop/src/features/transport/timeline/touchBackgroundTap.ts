/**
 * Toque sobre el fondo del timeline, en un móvil.
 *
 * En escritorio, pulsar el fondo salta ahí y arrastrar desplaza la cámara. Con
 * el dedo eso no puede ser, y era lo que estropeaba el gesto de dos dedos:
 *
 * - el WebView emite eventos de ratón de compatibilidad para el PRIMER dedo, así
 *   que apoyarlo ya movía el cabezal y empezaba un desplazamiento de cámara por
 *   `mousemove` — antes incluso de que el segundo dedo llegara;
 * - ese camino no son eventos de puntero, así que el `pointercancel` con el que
 *   el gesto de dos dedos aparta los arrastres en vuelo no lo alcanzaba: la
 *   pinza y el desplazamiento del fondo movían la cámara a la vez, desde
 *   orígenes distintos;
 * - y al aterrizar el segundo dedo el WebView deja de emitir eventos de ratón,
 *   de modo que ese desplazamiento se quedaba congelado a media pinza.
 *
 * El reparto en táctil es: el recorrido vertical es del navegador
 * (`touch-action: pan-y`), el horizontal y el zoom son del gesto de dos dedos, y
 * el fondo sólo conserva el TOQUE limpio para saltar. Limpio quiere decir: sin
 * desplazamiento y sin un segundo dedo. Y al soltar, no al pulsar — si salta al
 * pulsar, el cabezal se mueve justo cuando el usuario estaba empezando una
 * pinza.
 */

export type TouchBackgroundTapArgs = {
  startClientX: number;
  startClientY: number;
  /** Desplazamiento a partir del cual deja de ser un toque. */
  thresholdPx: number;
  /** Se invoca al soltar, sólo si el toque siguió siendo limpio. */
  onTap: () => void;
};

/**
 * Arma el toque y devuelve la función que lo desarma (por si quien llama tiene
 * que abortarlo desde fuera). Se limpia solo al soltar o al abortarse.
 */
export function armTouchBackgroundTap({
  startClientX,
  startClientY,
  thresholdPx,
  onTap,
}: TouchBackgroundTapArgs): () => void {
  let live = true;

  function disarm() {
    if (!live) {
      return;
    }
    live = false;
    window.removeEventListener("mousemove", handleMove);
    window.removeEventListener("mouseup", handleUp);
    window.removeEventListener("touchstart", handleTouchStart, true);
    window.removeEventListener("touchcancel", disarm);
  }

  function handleMove(event: MouseEvent) {
    if (
      Math.hypot(event.clientX - startClientX, event.clientY - startClientY) >
      thresholdPx
    ) {
      disarm();
    }
  }

  /** Un segundo dedo convierte esto en un gesto de cámara: el toque se cae.
   * En captura porque el WebView puede dejar de entregar eventos de ratón en
   * cuanto empieza el multitáctil, y entonces `mouseup` no llegaría nunca. */
  function handleTouchStart(event: TouchEvent) {
    if (event.touches.length >= 2) {
      disarm();
    }
  }

  function handleUp(event: MouseEvent) {
    if (event.button !== 0) {
      return;
    }
    const wasClean = live;
    disarm();
    if (wasClean) {
      onTap();
    }
  }

  window.addEventListener("mousemove", handleMove);
  window.addEventListener("mouseup", handleUp);
  window.addEventListener("touchstart", handleTouchStart, true);
  window.addEventListener("touchcancel", disarm);

  return disarm;
}
