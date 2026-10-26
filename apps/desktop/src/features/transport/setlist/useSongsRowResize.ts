import { useCallback, useEffect, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

import { useSetlistStore } from "./setlistStore";

/** The song row never gets shorter than one row of cards… */
export const SONGS_MIN_HEIGHT_PX = 64;
/** …nor taller than half the view. */
export const SONGS_MAX_HEIGHT_FRACTION = 0.5;
const STORAGE_KEY = "lt.setlistView.songsHeightPx";
export const SONGS_HEIGHT_VAR = "--lt-setlist-songs-height";
export const CARD_HEIGHT_VAR = "--lt-setlist-card-h";
/** A card is never shorter than this (name + key/BPM line). */
export const CARD_MIN_HEIGHT_PX = 52;
const LIST_PADDING_PX = 14;
const CARD_GAP_PX = 6;

/**
 * How the song cards fill a row of `listHeightPx`: as many rows as fit at
 * the minimum card height, and the height each card takes so they fill it
 * exactly (no vertical scroll, no clipped card: the desktop report).
 */
export function songCardRows(listHeightPx: number) {
  const usable = Math.max(0, listHeightPx - LIST_PADDING_PX);
  const rows = Math.max(1, Math.floor((usable + CARD_GAP_PX) / (CARD_MIN_HEIGHT_PX + CARD_GAP_PX)));
  const cardHeight = Math.max(CARD_MIN_HEIGHT_PX - 8, Math.floor((usable - (rows - 1) * CARD_GAP_PX) / rows));
  return { rows, cardHeight };
}

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
  const songsHeightPx = useSetlistStore((state) => state.songsHeightPx);

  // The cards follow the list's real height (it is capped by the window, so
  // the dragged value is not enough): rows and card height, live while
  // dragging and when the window changes.
  useEffect(() => {
    const root = rootRef.current;
    const list = songsRef.current?.querySelector<HTMLElement>(".lt-setlist-songs");
    if (!root || !list || songsHeightPx === null || typeof ResizeObserver === "undefined") {
      root?.style.removeProperty(CARD_HEIGHT_VAR);
      if (root) delete root.dataset.songRows;
      return;
    }
    const apply = () => {
      const { rows, cardHeight } = songCardRows(list.clientHeight);
      root.style.setProperty(CARD_HEIGHT_VAR, `${cardHeight}px`);
      // A data attribute, not a class: React owns the root's className.
      if (rows > 1) root.dataset.songRows = "multi";
      else delete root.dataset.songRows;
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(list);
    return () => observer.disconnect();
  }, [rootRef, songsRef, songsHeightPx]);

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
