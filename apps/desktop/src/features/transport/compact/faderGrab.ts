import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from "react";

/**
 * Faders in the Compacta and Setlist mixers move only when their cap is taken
 * (the user's call: a tap on the track by mistake must not change a level on
 * stage). A finger gets a finger's width around the cap; a mouse, the cap
 * itself and a little margin.
 */

/** Touch target around the cap: a finger's width, whatever the cap's size. */
export const TOUCH_GRAB_REACH_PX = 44;
/** A mouse needs to be on the cap; this much slack around it. */
const MOUSE_GRAB_MARGIN_PX = 3;

/** Half the grab zone along the fader's travel, for a cap of `capSizePx`. */
export function grabHalfReach(capSizePx: number, pointerType: string): number {
  const half = capSizePx / 2;
  return pointerType === "touch" ? Math.max(half, TOUCH_GRAB_REACH_PX / 2) : half + MOUSE_GRAB_MARGIN_PX;
}

/** A CSS length as px (px, rem or em; anything else falls back). */
function cssLengthPx(value: string, element: Element, fallback: number): number {
  const text = value.trim();
  const number = Number.parseFloat(text);
  if (!Number.isFinite(number)) return fallback;
  if (text.endsWith("rem")) {
    return number * (Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
  }
  if (text.endsWith("em")) return number * (Number.parseFloat(getComputedStyle(element).fontSize) || 16);
  return number;
}

/**
 * Whether a pointer at `clientX` takes the thumb of a horizontal native range
 * (the pan). The thumb's width is the shared fader cap (`--lt-fader-cap-w`,
 * shared/faders.css); its centre runs from half a thumb in from each end.
 */
export function isOnRangeThumb(input: HTMLInputElement, clientX: number, pointerType: string): boolean {
  const rect = input.getBoundingClientRect();
  if (rect.width <= 0) return true;
  const thumb = cssLengthPx(getComputedStyle(input).getPropertyValue("--lt-fader-cap-w"), input, 16);
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const fraction = max > min ? (Number(input.value) - min) / (max - min) : 0;
  const centre = rect.left + thumb / 2 + fraction * (rect.width - thumb);
  return Math.abs(clientX - centre) <= grabHalfReach(thumb, pointerType);
}

function rangeThumbWidth(input: HTMLInputElement): number {
  return cssLengthPx(getComputedStyle(input).getPropertyValue("--lt-fader-cap-w"), input, 16);
}

type CapOnlyRangeOptions = {
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  onCommit: () => void;
  /** The thumb was taken (true) or let go (false): drag tooltips. */
  onGrab?: (grabbing: boolean) => void;
};

/** With Shift held a drag crawls at this fraction of the pointer's speed. */
const FINE_RANGE_FACTOR = 0.25;

/**
 * A horizontal range (pan, master gain) in the Compacta and Setlist mixers
 * that only moves by its thumb, and lets the rest of it scroll the mixer
 * sideways with a finger (the user's call: the strips only scrolled from the
 * track names, which was awkward).
 *
 * A native range keeps a finger's horizontal drag to itself wherever it lands
 * (Chromium), so the pointer never reaches it: a transparent layer on top
 * (`lt-cap-only-layer`, `touch-action: pan-x pan-y`) takes it instead.
 * - On the thumb (a finger's reach on touch): `touchstart` is cancelled, no
 *   scroll, and the drag runs here from where the thumb was taken (no jump;
 *   Shift crawls).
 * - Anywhere else: nothing; a finger scrolls the mixer.
 * The input underneath still draws the control and takes the keyboard.
 *
 * Wire `inputRef` on the input and `layerRef` + `onPointerDown` on the layer.
 */
export function useCapOnlyRange(options: CapOnlyRangeOptions) {
  const latest = useRef(options);
  latest.current = options;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const detachRef = useRef<(() => void) | null>(null);

  const layerRef = useCallback((layer: HTMLElement | null) => {
    detachRef.current?.();
    detachRef.current = null;
    if (!layer) return;
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      const input = inputRef.current;
      if (touch && input && isOnRangeThumb(input, touch.clientX, "touch") && event.cancelable) {
        event.preventDefault();
      }
    };
    layer.addEventListener("touchstart", onTouchStart, { passive: false });
    detachRef.current = () => layer.removeEventListener("touchstart", onTouchStart);
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const input = inputRef.current;
    if ((event.button ?? 0) !== 0 || !input || input.disabled) return;
    if (!isOnRangeThumb(input, event.clientX, event.pointerType)) return;
    event.preventDefault();
    input.focus({ preventScroll: true });
    const layer = event.currentTarget;
    const pointerId = event.pointerId;
    const travel = Math.max(1, input.getBoundingClientRect().width - rangeThumbWidth(input));
    let anchor = { x: event.clientX, value: Number(input.value), fine: event.shiftKey };
    latest.current.onGrab?.(true);
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (moveEvent.cancelable) moveEvent.preventDefault();
      const { min, max, step, onChange } = latest.current;
      // Shift toggled mid-drag: re-anchor so the thumb stays put.
      if (moveEvent.shiftKey !== anchor.fine) {
        anchor = { x: moveEvent.clientX, value: Number(input.value), fine: moveEvent.shiftKey };
      }
      const scale = anchor.fine ? FINE_RANGE_FACTOR : 1;
      const raw = anchor.value + ((moveEvent.clientX - anchor.x) / travel) * (max - min) * scale;
      const snapped = step > 0 ? min + Math.round((raw - min) / step) * step : raw;
      onChange(Math.min(max, Math.max(min, Number(snapped.toFixed(6)))));
    };
    const end = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      try {
        if (layer.hasPointerCapture?.(pointerId)) layer.releasePointerCapture(pointerId);
      } catch {
        // The pointer is gone: nothing to release.
      }
      latest.current.onGrab?.(false);
      latest.current.onCommit();
    };
    try {
      layer.setPointerCapture?.(pointerId);
    } catch {
      // Without capture the window listeners still follow the pointer.
    }
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }, []);

  return { inputRef, layerRef, onPointerDown };
}
