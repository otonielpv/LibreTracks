import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

/** Travel that decides between a horizontal swipe and a vertical scroll. */
const DIRECTION_PX = 10;
/** A swipe further left than this removes the row. */
export const SWIPE_REMOVE_PX = 80;
/** Press held this long without moving opens the row menu. */
export const LONG_PRESS_MS = 500;

/**
 * A row you can swipe left to remove and long-press for its menu. Vertical
 * travel is left to the browser (`touch-action: pan-y` in the CSS), so the list
 * still scrolls under the finger.
 *
 * Ownership is decided by where the press STARTED, not by `targetTouches`
 * (which only means "fingers that began on the same element"): a press on the
 * drag handle never reaches here because the handle stops propagation. Once a
 * gesture starts, its samples are read from `window`, so a re-render under the
 * finger cannot cut it off.
 */
export function SwipeableRow({
  children,
  onRemove,
  onLongPress,
}: {
  children: ReactNode;
  onRemove: () => void;
  onLongPress: () => void;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    cleanupRef.current?.();
    const pointerId = event.pointerId;
    const start = { x: event.clientX, y: event.clientY };
    let mode: "pending" | "swipe" | "scroll" | "done" = "pending";
    let dx = 0;
    const row = rowRef.current;
    const timer = window.setTimeout(() => {
      if (mode === "pending") {
        mode = "done";
        onLongPress();
      }
    }, LONG_PRESS_MS);

    const setOffset = (offset: number) => {
      if (row) row.style.transform = offset === 0 ? "" : `translate3d(${offset}px, 0, 0)`;
    };
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      dx = next.clientX - start.x;
      const dy = next.clientY - start.y;
      if (mode === "pending") {
        if (Math.abs(dx) > DIRECTION_PX && Math.abs(dx) > Math.abs(dy)) {
          mode = "swipe";
          window.clearTimeout(timer);
        } else if (Math.abs(dy) > DIRECTION_PX) {
          mode = "scroll";
          window.clearTimeout(timer);
        }
      }
      if (mode === "swipe") setOffset(Math.min(0, dx));
    };
    const finish = (removed: boolean) => {
      window.clearTimeout(timer);
      cleanup();
      setOffset(0);
      if (removed) onRemove();
    };
    const up = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      finish(mode === "swipe" && dx <= -SWIPE_REMOVE_PX);
    };
    // The browser took the gesture over (a vertical scroll): nothing to do.
    const cancel = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      finish(false);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      cleanupRef.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    cleanupRef.current = () => {
      window.clearTimeout(timer);
      cleanup();
    };
  };

  return (
    <div
      ref={rowRef}
      className="lt-structure-swipe"
      onPointerDown={onPointerDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {children}
    </div>
  );
}
