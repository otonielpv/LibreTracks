import { useCallback, useEffect, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

import { useSetlistStore } from "./setlistStore";

/** The song row never gets shorter than one row of cards… */
export const SONGS_MIN_HEIGHT_PX = 64;
/** …nor taller than half the view. */
export const SONGS_MAX_HEIGHT_FRACTION = 0.5;
const STORAGE_KEY = "lt.setlistView.songsHeightPx";
export const SONGS_HEIGHT_VAR = "--lt-setlist-songs-height";

export function clampSongsHeight(heightPx: number, viewHeightPx: number) {
  const max = Math.max(SONGS_MIN_HEIGHT_PX, viewHeightPx * SONGS_MAX_HEIGHT_FRACTION);
  return Math.round(Math.max(SONGS_MIN_HEIGHT_PX, Math.min(max, heightPx)));
}

function readStored(): number | null {
  try {
    const value = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function store(heightPx: number | null) {
  try {
    if (heightPx === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, String(heightPx));
  } catch {
    // Blocked storage: the height lasts for this session only.
  }
}

/**
 * Dragging the bottom edge of the `wide` song row (the desktop report: the
 * mixer resized, the songs did not). Taller, the cards wrap into more rows.
 * Same mechanics as useMixerResize: a CSS variable on the view root during
 * the drag, one commit to setlistStore and localStorage on release. A
 * double click goes back to the automatic height.
 */
export function useSongsRowResize(
  rootRef: RefObject<HTMLElement | null>,
  songsRef: RefObject<HTMLElement | null>,
) {
  const setSongsHeightPx = useSetlistStore((state) => state.setSongsHeightPx);

  useEffect(() => {
    if (useSetlistStore.getState().songsHeightPx !== null) return;
    const stored = readStored();
    if (stored !== null) setSongsHeightPx(stored);
  }, [setSongsHeightPx]);

  const begin = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const root = rootRef.current;
      const songs = songsRef.current;
      if (!root || !songs || event.button !== 0) return;
      event.preventDefault();
      const pointerId = event.pointerId;
      const startY = event.clientY;
      const startHeight = songs.getBoundingClientRect().height;
      const viewHeight = root.getBoundingClientRect().height;
      let current = clampSongsHeight(startHeight, viewHeight);
      root.classList.add("has-songs-height");
      const onMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        current = clampSongsHeight(startHeight + (moveEvent.clientY - startY), viewHeight);
        root.style.setProperty(SONGS_HEIGHT_VAR, `${current}px`);
      };
      const onUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        setSongsHeightPx(current);
        store(current);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [rootRef, setSongsHeightPx, songsRef],
  );

  const reset = useCallback(() => {
    rootRef.current?.style.removeProperty(SONGS_HEIGHT_VAR);
    setSongsHeightPx(null);
    store(null);
  }, [rootRef, setSongsHeightPx]);

  return { begin, reset };
}
