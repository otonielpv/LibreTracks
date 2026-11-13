import { useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { create } from "zustand";

import { TIMELINE_RULER_HEIGHT } from "../constants";
import { useTimelineUIStore } from "../uiStore";
import type { TrackRowLayout } from "./trackLayout";
import {
  bindViewport,
  outsidePinnedIndices,
  resolveVisibleTrackRows,
  type ViewportMetrics,
  type VisibleTrackRows,
} from "./useVisibleTrackRows";

/**
 * The window of track rows the DAW mounts (`docs/plans/completed/track-virtualization`,
 * step 05), shared by the headers and the lanes.
 *
 * ONE controller (`useTrackRowWindowController`, in the transport panel)
 * measures the scroll viewport and publishes the metrics to this store only
 * when they move the snapped window. Each pane derives its rows from that
 * snapshot and its `layout` prop with the same pure function
 * (`resolveVisibleTrackRows`), so headers and lanes cannot disagree: same
 * inputs, same answer, in the same commit. Keeping the window out of React
 * state in the panel is the point: crossing a block re-renders the two panes,
 * not the whole transport panel.
 *
 * Pinned rows — mounted even outside the window:
 *
 * - the row under a pressed pointer: the header being dragged to reorder, the
 *   one being resized by its edge, a clip being dragged in its lane. Removing
 *   a pointer's target mid-gesture loses its touch events;
 * - the row holding keyboard focus (a fader moved with the arrows);
 * - on mobile, the expanded track, whose mixer panel would close otherwise.
 */

type TrackRowWindowState = {
  /** Last viewport metrics that changed the window; null = unknown. */
  metrics: ViewportMetrics | null;
  /** Rows a gesture or the focus holds on to. */
  pressedTrackId: string | null;
  focusedTrackId: string | null;
  /** Bumped after the panes commit a new window: a reorder drag adopts the
   * rows that just mounted. Set by the controller. */
  onRowsMounted: (() => void) | null;
};

export const useTrackRowWindowStore = create<TrackRowWindowState>()(() => ({
  metrics: null,
  pressedTrackId: null,
  focusedTrackId: null,
  onRowsMounted: null,
}));

type RowTrack = { id: string };

function rowTrackId(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) {
    return null;
  }
  return target.closest<HTMLElement>("[data-track-id]")?.dataset.trackId ?? null;
}

function windowKey(rows: VisibleTrackRows) {
  return `${rows.isWindowed ? 1 : 0}:${rows.startIndex}:${rows.endIndex}:${rows.pinnedIndices.join(",")}`;
}

function parseWindowKey(key: string): VisibleTrackRows {
  const [windowed, start, end, pinned] = key.split(":");
  return {
    isWindowed: windowed === "1",
    startIndex: Number(start),
    endIndex: Number(end),
    pinnedIndices: pinned ? pinned.split(",").map(Number) : [],
  };
}

/** The window for `layout`, from a store snapshot. Pure. */
export function trackRowWindowFor(
  state: Pick<TrackRowWindowState, "metrics" | "pressedTrackId" | "focusedTrackId">,
  layout: TrackRowLayout,
  tracks: readonly RowTrack[],
  expandedTrackId: string | null,
): VisibleTrackRows {
  const window = resolveVisibleTrackRows(layout, state.metrics, {
    headerOffsetPx: TIMELINE_RULER_HEIGHT,
  });
  if (!window.isWindowed) {
    return { ...window, pinnedIndices: [] };
  }
  const pinned: number[] = [];
  for (const id of [state.pressedTrackId, state.focusedTrackId, expandedTrackId]) {
    if (id === null) continue;
    const index = tracks.findIndex((track) => track.id === id);
    if (index >= 0) pinned.push(index);
  }
  return {
    ...window,
    pinnedIndices: outsidePinnedIndices(window, pinned, layout.heights.length),
  };
}

/**
 * The rows a pane mounts. Re-renders the pane only when the result changes:
 * the selector returns a string key, compared by value.
 */
export function useTrackRowWindow(
  layout: TrackRowLayout,
  tracks: readonly RowTrack[],
): VisibleTrackRows {
  const expandedTrackId = useTimelineUIStore((state) => state.expandedTrackId);
  const key = useTrackRowWindowStore((state) =>
    windowKey(trackRowWindowFor(state, layout, tracks, expandedTrackId)),
  );
  const rowWindow = useMemo(() => parseWindowKey(key), [key]);
  useLayoutEffect(() => {
    if (rowWindow.isWindowed) {
      useTrackRowWindowStore.getState().onRowsMounted?.();
    }
  }, [rowWindow]);
  return rowWindow;
}

/**
 * Measures the viewport and feeds the store. Call it once, in the component
 * that owns the scroll viewport. Renders nothing and holds no React state.
 */
export function useTrackRowWindowController({
  viewportRef,
  layout,
  tracks,
  onRowsMounted,
}: {
  viewportRef: RefObject<HTMLElement | null>;
  layout: TrackRowLayout;
  tracks: readonly RowTrack[];
  onRowsMounted?: () => void;
}) {
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;

  const syncRef = useRef<(viewport: HTMLElement) => void>(() => {});
  syncRef.current = (viewport) => {
    const store = useTrackRowWindowStore.getState();
    const metrics = { scrollTop: viewport.scrollTop, clientHeight: viewport.clientHeight };
    if (
      store.metrics?.scrollTop === metrics.scrollTop &&
      store.metrics.clientHeight === metrics.clientHeight
    ) {
      return;
    }
    const options = { headerOffsetPx: TIMELINE_RULER_HEIGHT };
    const current = resolveVisibleTrackRows(layoutRef.current, store.metrics, options);
    const next = resolveVisibleTrackRows(layoutRef.current, metrics, options);
    // Publishing only on a window change is what keeps scrolling render-free.
    if (
      store.metrics === null ||
      current.startIndex !== next.startIndex ||
      current.endIndex !== next.endIndex ||
      current.isWindowed !== next.isWindowed
    ) {
      useTrackRowWindowStore.setState({ metrics });
    }
  };

  const onRowsMountedRef = useRef(onRowsMounted);
  onRowsMountedRef.current = onRowsMounted;

  // The viewport only exists in the DAW view: re-bind when it changes.
  const boundRef = useRef<{ element: HTMLElement; unbind: () => void } | null>(null);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (boundRef.current?.element === viewport) {
      return;
    }
    boundRef.current?.unbind();
    boundRef.current = viewport ? { element: viewport, unbind: bindController(viewport) } : null;
  });
  useLayoutEffect(() => {
    useTrackRowWindowStore.setState({ onRowsMounted: () => onRowsMountedRef.current?.() });
    return () => {
      boundRef.current?.unbind();
      boundRef.current = null;
      useTrackRowWindowStore.setState({
        metrics: null,
        pressedTrackId: null,
        focusedTrackId: null,
        onRowsMounted: null,
      });
    };
  }, []);

  // A new layout can move the window (and clamp scrollTop) without a scroll.
  useLayoutEffect(() => {
    const viewport = boundRef.current?.element;
    if (viewport) {
      syncRef.current(viewport);
    }
  }, [layout]);

  function bindController(viewport: HTMLElement) {
    const unbindScroll = bindViewport(viewport, () => syncRef.current(viewport));
    // Press and focus land in the store without re-rendering anything: the
    // pressed row is under the pointer, so inside the window; the pin only
    // shows once the window moves away from it.
    const press = (event: Event) => {
      useTrackRowWindowStore.setState({ pressedTrackId: rowTrackId(event.target) });
    };
    const release = () => {
      if (useTrackRowWindowStore.getState().pressedTrackId !== null) {
        useTrackRowWindowStore.setState({ pressedTrackId: null });
      }
    };
    const focusIn = (event: Event) => {
      useTrackRowWindowStore.setState({ focusedTrackId: rowTrackId(event.target) });
    };
    const focusOut = (event: FocusEvent) => {
      if (rowTrackId(event.relatedTarget) === null) {
        useTrackRowWindowStore.setState({ focusedTrackId: null });
      }
    };
    viewport.addEventListener("pointerdown", press, true);
    viewport.addEventListener("focusin", focusIn);
    viewport.addEventListener("focusout", focusOut);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    return () => {
      unbindScroll();
      viewport.removeEventListener("pointerdown", press, true);
      viewport.removeEventListener("focusin", focusIn);
      viewport.removeEventListener("focusout", focusOut);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
    };
  }
}
