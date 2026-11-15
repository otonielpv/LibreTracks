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
