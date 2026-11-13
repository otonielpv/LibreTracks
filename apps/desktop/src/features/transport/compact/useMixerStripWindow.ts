import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";

import { buildUniformRowLayout, type TrackRowLayout } from "../tracks/trackLayout";
import { useTrackRowWindowStore } from "../tracks/useTrackRowWindow";
import {
  bindViewport,
  outsidePinnedIndices,
  resolveVisibleTrackRows,
  type VisibleTrackRows,
} from "../tracks/useVisibleTrackRows";

/**
 * The strips the compact mixer mounts (`docs/plans/completed/track-virtualization`,
 * step 06). With the active-song filter off, a 138-track session mounted 138
 * strips — fader, pan, buttons, routing select and meter each — and the whole
 * view slowed down.
 *
 * Same rules as the DAW rows, on the X axis: at or below the threshold, or
 * with an unknown geometry (jsdom, first ever mount), every strip; no render
 * per scroll event; the window snaps to blocks; the row window function and
 * the spacer arithmetic are the DAW's own, over a uniform layout.
 *
 * Strips have a fixed CSS width plus the flex `gap`, so a strip's slot (its
 * "pitch") is read once from CSS, never per scroll. A spacer standing in for
 * `k` strips is `k · pitch − gap` wide: the flex gap is applied around it too.
 */

export type StripGeometry = {
  /** Strip width plus the gap after it, in CSS px. */
  pitch: number;
  /** Strip width alone. */
  width: number;
  gap: number;
};

/** What the reorder preview needs to place strips that are not mounted. */
export type CompactStripLayout = StripGeometry & { ids: readonly string[] };

// The mixer is remounted on every switch to the compact view: keep what was
// measured, so the next mount is windowed on its very first render.
let lastGeometry: StripGeometry | null = null;
let lastClientWidth = 0;
let publishedLayout: CompactStripLayout | null = null;

/** Layout of the strips the mixer is showing right now, if it is windowed. */
export function getCompactStripLayout(): CompactStripLayout | null {
  return publishedLayout;
}

/** For tests: forget what earlier mounts measured. */
export function resetMixerStripWindowForTest() {
  lastGeometry = null;
  lastClientWidth = 0;
  publishedLayout = null;
}

function measureGeometry(scroller: HTMLElement): StripGeometry | null {
  const strip = scroller.querySelector<HTMLElement>(".lt-compact-mixer-strip");
  if (!strip) {
    return null;
  }
  // Computed widths, not offsetWidth: a strip is 6.5rem, which is fractional
  // at some UI zooms, and a rounded pitch drifts by a pixel every few strips.
  const width = Number.parseFloat(getComputedStyle(strip).width);
  const scrollerStyle = getComputedStyle(scroller);
  const gap = Number.parseFloat(scrollerStyle.columnGap || scrollerStyle.gap) || 0;
  return width > 0 ? { pitch: width + gap, width, gap } : null;
}

function rowTrackId(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) {
    return null;
  }
  return target.closest<HTMLElement>("[data-track-id]")?.dataset.trackId ?? null;
}

export function useMixerStripWindow(
  scrollerRef: RefObject<HTMLElement | null>,
  stripIds: readonly string[],
): { rowWindow: VisibleTrackRows; layout: TrackRowLayout | null; geometry: StripGeometry | null } {
  const [, setRenderTick] = useState(0);
  const metricsRef = useRef({ scrollLeft: 0, clientWidth: lastClientWidth });
  const geometryRef = useRef<StripGeometry | null>(lastGeometry);
  const pressedRef = useRef<string | null>(null);
  const focusedRef = useRef<string | null>(null);

  const geometry = geometryRef.current;
  const layout = useMemo(
    () => (geometry ? buildUniformRowLayout(stripIds, geometry.pitch) : null),
    [geometry, stripIds],
  );

  const resolve = (forLayout: TrackRowLayout | null) => {
    if (!forLayout) {
      return { startIndex: 0, endIndex: stripIds.length, isWindowed: false };
    }
    return resolveVisibleTrackRows(
      forLayout,
      { scrollTop: metricsRef.current.scrollLeft, clientHeight: metricsRef.current.clientWidth },
      {},
    );
  };
  const base = resolve(layout);
  const pinned: number[] = [];
  for (const id of [pressedRef.current, focusedRef.current]) {
    const index = id === null ? -1 : stripIds.indexOf(id);
    if (index >= 0) pinned.push(index);
  }
  const pinnedIndices = outsidePinnedIndices(base, pinned, stripIds.length);
  const key = `${base.isWindowed}:${base.startIndex}:${base.endIndex}:${pinnedIndices.join(",")}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rowWindow = useMemo(() => ({ ...base, pinnedIndices }), [key]);

  const renderedRef = useRef(base);
  renderedRef.current = base;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // Reads the scroller; re-renders only when the snapped window moves (or
  // the geometry is learnt for the first time).
  const syncRef = useRef<(scroller: HTMLElement, remeasure: boolean) => void>(() => {});
  syncRef.current = (scroller, remeasure) => {
    let geometryChanged = false;
    if (remeasure || !geometryRef.current) {
      const measured = measureGeometry(scroller);
      if (
        measured &&
        (measured.pitch !== geometryRef.current?.pitch || measured.width !== geometryRef.current?.width)
      ) {
        geometryRef.current = measured;
        lastGeometry = measured;
        geometryChanged = true;
      }
    }
    metricsRef.current = { scrollLeft: scroller.scrollLeft, clientWidth: scroller.clientWidth };
    lastClientWidth = metricsRef.current.clientWidth;
    if (geometryChanged) {
      setRenderTick((tick) => tick + 1);
      return;
    }
    const next = resolve(layoutRef.current);
    const rendered = renderedRef.current;
    if (
      next.startIndex !== rendered.startIndex ||
      next.endIndex !== rendered.endIndex ||
      next.isWindowed !== rendered.isWindowed
    ) {
      renderedRef.current = next;
      setRenderTick((tick) => tick + 1);
    }
  };

  const boundRef = useRef<{ element: HTMLElement; unbind: () => void } | null>(null);
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (boundRef.current?.element === scroller) {
      return;
    }
    boundRef.current?.unbind();
    if (!scroller) {
      boundRef.current = null;
      return;
    }
    const unbindScroll = bindViewport(scroller, () => syncRef.current(scroller, false));
    syncRef.current(scroller, true);
    const press = (event: Event) => {
      pressedRef.current = rowTrackId(event.target);
    };
    const release = () => {
      if (pressedRef.current === null) return;
      pressedRef.current = null;
      setRenderTick((tick) => tick + 1);
    };
    const focusIn = (event: Event) => {
      focusedRef.current = rowTrackId(event.target);
    };
    const focusOut = (event: FocusEvent) => {
      if (rowTrackId(event.relatedTarget) === null) focusedRef.current = null;
    };
    scroller.addEventListener("pointerdown", press, true);
    scroller.addEventListener("focusin", focusIn);
    scroller.addEventListener("focusout", focusOut);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    boundRef.current = {
      element: scroller,
      unbind: () => {
        unbindScroll();
        scroller.removeEventListener("pointerdown", press, true);
        scroller.removeEventListener("focusin", focusIn);
        scroller.removeEventListener("focusout", focusOut);
        window.removeEventListener("pointerup", release, true);
        window.removeEventListener("pointercancel", release, true);
      },
    };
  });

  // New strips (filter toggled, folder folded): the strip size is the same,
  // but a first mount without geometry can learn it now.
  useLayoutEffect(() => {
    const scroller = boundRef.current?.element;
    if (scroller) syncRef.current(scroller, !geometryRef.current);
  }, [stripIds]);

  useLayoutEffect(() => {
    publishedLayout =
      rowWindow.isWindowed && geometry ? { ...geometry, ids: stripIds } : null;
    if (rowWindow.isWindowed) {
      // A reorder drag in the mixer adopts the strips that just mounted.
      useTrackRowWindowStore.getState().onRowsMounted?.();
    }
  }, [rowWindow, geometry, stripIds]);

  useLayoutEffect(
    () => () => {
      boundRef.current?.unbind();
      boundRef.current = null;
      publishedLayout = null;
    },
    [],
  );

  return { rowWindow, layout, geometry };
}
