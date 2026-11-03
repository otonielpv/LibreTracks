import { useCallback, useEffect, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

import { OVERVIEW_MAX_ZOOM } from "./OverviewZoom";
import { useSetlistStore } from "./setlistStore";

/** The lyrics never get narrower than this… */
export const LYRICS_MIN_WIDTH_PX = 256;
/** …nor take more than this share of the band row: the waveform stays usable. */
export const LYRICS_MAX_WIDTH_FRACTION = 0.7;
const STORAGE_KEY = "lt.setlistView.lyricsWidthPx";
export const LYRICS_WIDTH_VAR = "--lt-setlist-lyrics-width";

export function clampLyricsWidth(widthPx: number, rowWidthPx: number) {
  const max = Math.max(LYRICS_MIN_WIDTH_PX, rowWidthPx * LYRICS_MAX_WIDTH_FRACTION);
  return Math.round(Math.max(LYRICS_MIN_WIDTH_PX, Math.min(max, widthPx)));
}

function readStored(): number | null {
  try {
    const value = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function store(widthPx: number | null) {
  try {
    if (widthPx === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, String(widthPx));
  } catch {
    // Blocked storage: the width lasts for this session only.
  }
}

/**
 * Dragging the seam between the waveform and the lyrics in `wide` (the user
 * wanted wider lyrics). The width lives only in a CSS variable on the view
 * root, so the drag never re-renders the view; localStorage keeps it, and a
 * double click goes back to the automatic width. The variable sits on the
 * root, not the band row, because the row remounts when the lyrics toggle.
 */
export function useLyricsWidthResize(rootRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const stored = readStored();
    if (stored !== null) rootRef.current?.style.setProperty(LYRICS_WIDTH_VAR, `${stored}px`);
  }, [rootRef]);

  const begin = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const root = rootRef.current;
      const row = event.currentTarget.parentElement;
      const lyrics = row?.querySelector<HTMLElement>(".lt-setlist-zone.is-lyrics");
      if (!root || !row || !lyrics || event.button !== 0) return;
      event.preventDefault();
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startWidth = lyrics.getBoundingClientRect().width;
      const rowWidth = row.getBoundingClientRect().width;
      let current = clampLyricsWidth(startWidth, rowWidth);
      // Zoomed in, the waveform keeps its pixels per second, as in a DAW: the
      // layer is frozen at its pixel width for the drag (nothing re-renders or
      // re-lays out under the pointer) and the zoom is worked out once on
      // release. Unzoomed it stays a percentage: the whole song keeps fitting.
      const layer = row.querySelector<HTMLElement>(".lt-setlist-zoom-layer");
      const frozenWidth = layer && useSetlistStore.getState().overviewZoom > 1 ? layer.offsetWidth : null;
      if (layer && frozenWidth !== null) layer.style.setProperty("width", `${frozenWidth}px`);
      const onMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        // The seam is the lyrics' left edge: dragging left widens them.
        current = clampLyricsWidth(startWidth - (moveEvent.clientX - startX), rowWidth);
        root.style.setProperty(LYRICS_WIDTH_VAR, `${current}px`);
      };
      const onUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        store(current);
        const viewportWidth = layer?.parentElement?.clientWidth ?? 0;
        if (layer && frozenWidth !== null && viewportWidth > 0) {
          const zoom = Math.max(1, Math.min(OVERVIEW_MAX_ZOOM, frozenWidth / viewportWidth));
          layer.style.setProperty("width", `${zoom * 100}%`);
          useSetlistStore.getState().setOverviewZoom(zoom);
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [rootRef],
  );

  const reset = useCallback(() => {
    rootRef.current?.style.removeProperty(LYRICS_WIDTH_VAR);
    store(null);
  }, [rootRef]);

  return { begin, reset };
}
