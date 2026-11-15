import { useCallback, useEffect, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

import { useSetlistStore } from "./setlistStore";

/** The mixer never gets shorter than 12 rem… */
export const MIXER_MIN_HEIGHT_PX = 192;
/** …nor taller than 60 % of the view (`wide`). */
export const MIXER_MAX_HEIGHT_FRACTION = 0.6;
/**
 * On a tablet (`medium`) the console is what gets touched, and a long fader
 * throw, like an analogue desk's, is easier to ride on stage: it may take
 * everything the waveform has above this (the song row is left alone; a
 * fraction of the view cut it on an iPad).
 */
export const MEDIUM_WAVE_MIN_PX = 80;
/** `wide`: the band row's grid minimum, without and with the lyrics beside it
 * (`.is-wide` / `.is-wide.has-lyrics` in setlist.css). Keep them in step. */
export const WIDE_BAND_MIN_REM = 8;
export const WIDE_LYRICS_BAND_MIN_REM = 11;
const STORAGE_KEY = "lt.setlistView.mixerHeightPx";
export const MIXER_HEIGHT_VAR = "--lt-setlist-mixer-height";

/**
 * The console's grid track for a dragged or remembered height: up to that
 * height, never below the minimum, and only what the song row (kept at its
 * content, setlist.css) and the band's minimum leave. A height remembered on
 * a taller window therefore shrinks the console, not the songs.
 */
export function mixerTrack(heightPx: number) {
  return `minmax(${MIXER_MIN_HEIGHT_PX}px, ${Math.round(heightPx)}px)`;
}

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
 * Dragging the top edge of the `wide` or `medium` mixer. During the drag the height is
 * written straight to a CSS variable on the view root (no React state per
 * pointermove); on release it is committed once to setlistStore and
 * remembered in localStorage.
 */
export function useMixerResize(
  rootRef: RefObject<HTMLElement | null>,
  mixerRef: RefObject<HTMLElement | null>,
  layout: string,
  collapsed: boolean,
) {
  // The tablet layout too: there the fader's length is what the musician
  // rides, so the console can grow like an analogue desk's long throw.
  const resizable = layout === "wide" || (layout === "medium" && !collapsed);
  const medium = layout === "medium";
  const setMixerHeightPx = useSetlistStore((state) => state.setMixerHeightPx);

  useEffect(() => {
    if (useSetlistStore.getState().mixerHeightPx !== null) return;
    const stored = readStoredHeight();
    if (stored !== null) setMixerHeightPx(stored);
  }, [setMixerHeightPx]);

  const begin = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const root = rootRef.current;
      const mixer = mixerRef.current;
      if (!root || !mixer || event.button !== 0) return;
      event.preventDefault();
      const pointerId = event.pointerId;
      const startY = event.clientY;
      const startHeight = mixer.getBoundingClientRect().height;
      const viewHeight = root.getBoundingClientRect().height;
      // Measured once: the waveform shrinks while the console grows, never
      // the song row above (the user's call: only those two trade height).
      // The floor is the band's own grid minimum (setlist.css).
      const wave = root.querySelector<HTMLElement>("[data-setlist-zone='overview'], [data-setlist-zone='lyrics']");
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const waveMin = medium
        ? MEDIUM_WAVE_MIN_PX
        : (root.classList.contains("has-lyrics") ? WIDE_LYRICS_BAND_MIN_REM : WIDE_BAND_MIN_REM) * rem;
      const spare = Math.max(0, (wave?.getBoundingClientRect().height ?? 0) - waveMin);
      const bandMax = Math.max(MIXER_MIN_HEIGHT_PX, startHeight + spare);
      const clamp = (height: number) =>
        medium
          ? Math.round(Math.max(MIXER_MIN_HEIGHT_PX, Math.min(bandMax, height)))
          : Math.min(clampMixerHeight(height, viewHeight), Math.round(bandMax));
      let current = clamp(startHeight);
      const onMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        current = clamp(startHeight - (moveEvent.clientY - startY));
        root.style.setProperty(MIXER_HEIGHT_VAR, mixerTrack(current));
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
    [medium, mixerRef, rootRef, setMixerHeightPx],
  );
  return { begin, resizable };
}
