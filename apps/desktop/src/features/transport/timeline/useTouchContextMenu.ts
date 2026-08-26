import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

type ActiveTouch = {
  pointerId: number;
  startX: number;
  startY: number;
  clientX: number;
  clientY: number;
  target: HTMLElement;
  timerId: number;
};

type TouchContextMenuOptions = {
  delayMs?: number;
  movementTolerancePx?: number;
  ignoreTarget?: (target: EventTarget | null) => boolean;
};

/** Synthesizes the same bubbling `contextmenu` event as a desktop right-click.
 * Mobile WebViews do not do this consistently for a finger long-press. */
export function useTouchContextMenu({
  delayMs = 550,
  movementTolerancePx = 10,
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
      clientX: event.clientX,
      clientY: event.clientY,
      target: event.currentTarget,
      timerId: 0,
    };
    active.timerId = window.setTimeout(() => {
      if (activeRef.current !== active) {
        return;
      }
      activeRef.current = null;
      triggeredRef.current = true;
      active.target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: active.clientX,
          clientY: active.clientY,
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
    active.clientX = event.clientX;
    active.clientY = event.clientY;
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
