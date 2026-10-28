import { useCallback, useEffect, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

import { useSetlistStore } from "./setlistStore";

/** The song row never gets shorter than one row of cards… */
export const SONGS_MIN_HEIGHT_PX = 128;
/** …nor taller than half the view. */
export const SONGS_MAX_HEIGHT_FRACTION = 0.5;
const STORAGE_KEY = "lt.setlistView.songsHeightPx";
export const SONGS_HEIGHT_VAR = "--lt-setlist-songs-height";
export const CARD_HEIGHT_VAR = "--lt-setlist-card-h";
/** Minimum space for the artwork and its caption. */
export const CARD_MIN_HEIGHT_PX = 112;
/** …nor taller than this: past it a row only wastes space. */
export const CARD_MAX_HEIGHT_PX = 176;
const LIST_PADDING_PX = 14;
const CARD_GAP_PX = 6;

/**
 * The height of each card when the cards sit in `rows` rows and the user
 * dragged the row to `preferredHeightPx`: they share it, within the minimum
 * and maximum, so a row never ends up taller than its cards need (the desktop
 * report: three songs in a tall row left most of it empty).
 */
export function songCardHeight(preferredHeightPx: number, rows: number) {
  const share = (preferredHeightPx - LIST_PADDING_PX - (rows - 1) * CARD_GAP_PX) / Math.max(1, rows);
  return Math.round(Math.max(CARD_MIN_HEIGHT_PX, Math.min(CARD_MAX_HEIGHT_PX, share)));
}

/** How many rows the cards flow into (distinct tops of the song cards). */
function countCardRows(list: HTMLElement) {
  const tops = new Set<number>();
  for (const card of list.querySelectorAll<HTMLElement>(".lt-setlist-song-item")) {
    tops.add(Math.round(card.offsetTop / 4));
  }
  return Math.max(1, tops.size);
}

/** Sizes the cards of `list` for a row dragged to `preferredHeightPx`. */
function fitSongCards(root: HTMLElement, list: HTMLElement, preferredHeightPx: number) {
  // Rows depend on the cards' widths only, never on their height: measure,
  // then size, and it settles in one pass.
  const rows = countCardRows(list);
  root.style.setProperty(CARD_HEIGHT_VAR, `${songCardHeight(preferredHeightPx, rows)}px`);
  // A data attribute, not a class: React owns the root's className.
  if (rows > 1) root.dataset.songRows = "multi";
  else delete root.dataset.songRows;
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

  // The cards follow the list: when the window or the songs change how they
  // wrap, they are sized again (and while dragging, see `begin`).
  useEffect(() => {
    const root = rootRef.current;
    const list = songsRef.current?.querySelector<HTMLElement>(".lt-setlist-songs");
    if (!root || !list || songsHeightPx === null || typeof ResizeObserver === "undefined") {
      root?.style.removeProperty(CARD_HEIGHT_VAR);
      if (root) delete root.dataset.songRows;
      return;
    }
    const apply = () => fitSongCards(root, list, songsHeightPx);
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
        const list = songs.querySelector<HTMLElement>(".lt-setlist-songs");
        if (list) fitSongCards(root, list, current);
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
