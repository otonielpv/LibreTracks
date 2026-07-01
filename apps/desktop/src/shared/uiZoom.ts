import { useSyncExternalStore } from "react";

// Interface zoom (UI scale). A per-install preference — independent of the
// timeline's own zoom and of the backend AppSettings — so small screens (e.g. a
// 13" MacBook where the default layout is wider than the display) can shrink the
// whole UI to fit. Persisted in localStorage, applied via the CSS `zoom`
// property on the app shell.
//
// Why `zoom` and not `transform: scale()`: `zoom` reflows layout (the content
// genuinely occupies less space and the rest reflows, and position:fixed /
// popovers keep working), whereas `transform: scale()` only paints smaller while
// the element still reserves its original box, producing gaps and broken
// overlays. `zoom` is a WebKit/Blink feature — and the Tauri WebView is WebKit,
// so it works on our macOS 10.15 (Safari 13) floor too.

const STORAGE_KEY = "lt.ui.zoom";
const VIEWPORT_COMPENSATION_CLASS = "lt-ui-zoom-compensate-viewport";

export const UI_ZOOM_STATUS_EVENT = "lt:ui-zoom-status";

export const UI_ZOOM_MIN = 0.7;
export const UI_ZOOM_MAX = 1.3;
export const UI_ZOOM_DEFAULT = 1;
// Discrete steps the keyboard shortcuts and the picker move between.
export const UI_ZOOM_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25] as const;

const clamp = (value: number): number =>
  Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, value));

const readStored = (): number => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return UI_ZOOM_DEFAULT;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? clamp(parsed) : UI_ZOOM_DEFAULT;
  } catch {
    return UI_ZOOM_DEFAULT;
  }
};

let current = typeof window === "undefined" ? UI_ZOOM_DEFAULT : readStored();
const listeners = new Set<() => void>();

const applyToDom = (zoom: number): void => {
  if (typeof document === "undefined") return;
  const shell = document.querySelector<HTMLElement>(".lt-app-shell");
  document.documentElement.style.setProperty("--lt-ui-zoom", String(zoom));
  document.documentElement.classList.toggle(
    VIEWPORT_COMPENSATION_CLASS,
    shouldCompensateUiZoomViewport(),
  );
  // Fall back to documentElement so the scale still applies before the shell
  // mounts or in non-standard hosts.
  const target = shell ?? document.documentElement;
  // `zoom` accepts a unitless multiplier in WebKit/Blink.
  target.style.zoom = String(zoom);
};

const persist = (zoom: number): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(zoom));
  } catch {
    // Private mode / storage disabled — keep the in-memory value anyway.
  }
};

export function getUiZoom(): number {
  return current;
}

// Convert viewport coordinates (event.clientX/Y — always in real, unscaled CSS
// pixels) into the coordinate space of an element that lives inside the
// `zoom`-scaled app shell. A `position: fixed` popover placed with `left/top`
// inside a zoomed ancestor has those offsets multiplied by the zoom when
// painted, so a raw clientX lands off by the zoom factor (left of the cursor
// when zoom < 1, right of it when zoom > 1). Dividing by the zoom cancels that
// out so the popover pins to the actual pointer position.
export function clientToZoomedCoords(
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const zoom = current || 1;
  return { x: clientX / zoom, y: clientY / zoom };
}

export function shouldCompensateUiZoomViewport(
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  return /Windows|Win32|Win64|WOW64/i.test(`${userAgent} ${platform}`);
}

export function dispatchUiZoomStatus(zoom = current): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<{ zoom: number }>(UI_ZOOM_STATUS_EVENT, {
      detail: { zoom },
    }),
  );
}

export function setUiZoom(next: number | ((current: number) => number)): void {
  const resolved = typeof next === "function" ? next(current) : next;
  const clamped = clamp(Number.isFinite(resolved) ? resolved : UI_ZOOM_DEFAULT);
  if (clamped === current) {
    // Still re-apply to the DOM (the shell may have just mounted) but skip
    // notifying subscribers since the value is unchanged.
    applyToDom(clamped);
    return;
  }
  current = clamped;
  applyToDom(clamped);
  persist(clamped);
  for (const listener of listeners) listener();
}

/** Step to the next/previous discrete zoom level. */
export function stepUiZoom(direction: 1 | -1): void {
  const steps = UI_ZOOM_STEPS;
  // Find the nearest current step, then move one in `direction`.
  let index = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < steps.length; i += 1) {
    const delta = Math.abs(steps[i] - current);
    if (delta < bestDelta) {
      bestDelta = delta;
      index = i;
    }
  }
  const nextIndex = Math.min(steps.length - 1, Math.max(0, index + direction));
  setUiZoom(steps[nextIndex]);
}

export function resetUiZoom(): void {
  setUiZoom(UI_ZOOM_DEFAULT);
}

/** Apply the persisted zoom to the DOM. Call once on app start. */
export function initUiZoom(): void {
  applyToDom(current);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React hook returning the live zoom value. */
export function useUiZoom(): number {
  return useSyncExternalStore(subscribe, getUiZoom, () => UI_ZOOM_DEFAULT);
}
