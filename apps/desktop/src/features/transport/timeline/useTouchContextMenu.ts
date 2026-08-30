import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

type ActiveTouch = {
  pointerId: number;
  startX: number;
  startY: number;
  target: HTMLElement;
  timerId: number;
};

type TouchContextMenuOptions = {
  delayMs?: number;
  movementTolerancePx?: number;
  ignoreTarget?: (target: EventTarget | null) => boolean;
};

/**
 * Synthesizes the same bubbling `contextmenu` event as a desktop right-click.
 * Mobile WebViews do not do this consistently for a finger long-press.
 *
 * ARMAR EN CAPTURA cuando el contenedor tenga hijos interactivos. Un hijo que
 * llame a `stopPropagation()` en su `onPointerDown` — el asa del cabezal lo
 * hace, para que arrastrarla no dispare además la selección de rango — deja sin
 * armar una pulsación larga cableada en burbuja: sobre esa franja el menú
 * simplemente no salía, y en la regla es justo donde más falta hace (crear una
 * marca en la posición actual). La captura corre antes que el destino, así que
 * ningún hijo puede quitársela. Usa `ignoreTarget` para las zonas que tengan su
 * propio menú.
 */
export function useTouchContextMenu({
  delayMs = 550,
  // Un dedo apoyado sobre un movil no se esta quieto: sostener 550 ms sin
  // desviarse 10 px es dificil, y cada desvio cancelaba la pulsacion larga en
  // silencio (la marca "no se creaba"). 16 px es el umbral tipico de una
  // pulsacion larga tactil, y no cuesta precision porque el menu se ancla donde
  // el dedo TOCO, no donde acabo.
  movementTolerancePx = 16,
  ignoreTarget,
}: TouchContextMenuOptions = {}) {
  const activeRef = useRef<ActiveTouch | null>(null);
  const triggeredRef = useRef(false);

  const cancel = () => {
    const active = activeRef.current;
    if (active) {
      window.clearTimeout(active.timerId);
      activeRef.current = null;
    }
  };

  useEffect(() => cancel, []);

  const begin = (event: ReactPointerEvent<HTMLElement>) => {
    cancel();
    triggeredRef.current = false;
    if (event.pointerType !== "touch" || ignoreTarget?.(event.target)) {
      return;
    }

    const active: ActiveTouch = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      // Keep the element under the finger as the synthetic event target. This
      // lets a single capture listener cover a whole pane while normal
      // contextmenu bubbling still selects the specific track/empty area.
      target:
        event.target instanceof HTMLElement ? event.target : event.currentTarget,
      timerId: 0,
    };
    active.timerId = window.setTimeout(() => {
      if (activeRef.current !== active) {
        return;
      }
      activeRef.current = null;
      triggeredRef.current = true;
      // Se dispara en el punto en que el dedo TOCO, no en el ultimo leido. Quien
      // abre el menu para crear una marca la pone donde apunto, no donde le
      // haya llevado la deriva del dedo durante la espera: sin esto la marca
      // nacia hasta 10 px desplazada y habia que recolocarla a mano.
      active.target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: active.startX,
          clientY: active.startY,
          button: 2,
          buttons: 0,
        }),
      );
    }, delayMs);
    activeRef.current = active;
  };

  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const active = activeRef.current;
    if (!active || active.pointerId !== event.pointerId) {
      return;
    }
    if (
      Math.hypot(event.clientX - active.startX, event.clientY - active.startY) >
      movementTolerancePx
    ) {
      cancel();
    }
  };

  /** Returns true once after a long-press fired. Touch targets use this to
   * swallow the synthetic click WebKit emits when the finger is released. */
  const consumeTriggered = () => {
    const triggered = triggeredRef.current;
    triggeredRef.current = false;
    return triggered;
  };

  return { begin, move, cancel, consumeTriggered };
}
