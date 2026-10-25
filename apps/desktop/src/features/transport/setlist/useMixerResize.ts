import { useCallback, useEffect, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

import { useSetlistStore } from "./setlistStore";

/** The mixer never gets shorter than 12 rem… */
export const MIXER_MIN_HEIGHT_PX = 192;
/** …nor taller than 60 % of the view. */
export const MIXER_MAX_HEIGHT_FRACTION = 0.6;
const STORAGE_KEY = "lt.setlistView.mixerHeightPx";
export const MIXER_HEIGHT_VAR = "--lt-setlist-mixer-height";

export function clampMixerHeight(heightPx: number, viewHeightPx: number) {
  const max = Math.max(MIXER_MIN_HEIGHT_PX, viewHeightPx * MIXER_MAX_HEIGHT_FRACTION);
  return Math.round(Math.max(MIXER_MIN_HEIGHT_PX, Math.min(max, heightPx)));
}

function readStoredHeight(): number | null {
  try {
    const value = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function storeHeight(heightPx: number) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(heightPx));
  } catch {
    // Blocked storage: the height lasts for this session only.
  }
}

/**
 * Dragging the top edge of the `wide` mixer. During the drag the height is
 * written straight to a CSS variable on the view root (no React state per
 * pointermove); on release it is committed once to setlistStore and
 * remembered in localStorage.
 */
export function useMixerResize(
  rootRef: RefObject<HTMLElement | null>,
  mixerRef: RefObject<HTMLElement | null>,
) {
  const setMixerHeightPx = useSetlistStore((state) => state.setMixerHeightPx);

  useEffect(() => {
    if (useSetlistStore.getState().mixerHeightPx !== null) return;
    const stored = readStoredHeight();
    if (stored !== null) setMixerHeightPx(stored);
  }, [setMixerHeightPx]);

  return useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const root = rootRef.current;
      const mixer = mixerRef.current;
      if (!root || !mixer || event.button !== 0) return;
      event.preventDefault();
      const pointerId = event.pointerId;
      const startY = event.clientY;
      const startHeight = mixer.getBoundingClientRect().height;
      const viewHeight = root.getBoundingClientRect().height;
      let current = clampMixerHeight(startHeight, viewHeight);
      const onMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        current = clampMixerHeight(startHeight - (moveEvent.clientY - startY), viewHeight);
        root.style.setProperty(MIXER_HEIGHT_VAR, `${current}px`);
      };
      const onUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        setMixerHeightPx(current);
        storeHeight(current);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [mixerRef, rootRef, setMixerHeightPx],
  );
}
