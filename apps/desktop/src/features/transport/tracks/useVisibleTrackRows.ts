import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";

import { TRACK_VIRTUALIZATION_MIN_ROWS, TRACK_WINDOW_BLOCK_ROWS } from "../constants";
import { timelineVisibleTrackHeight } from "../Renderer/canvasPixelRatio";
import { visibleTrackWindow, type TrackRowLayout, type TrackRowWindow } from "./trackLayout";

/**
 * Which track rows the DOM (headers and lanes) should mount.
 *
 * Same question the canvas answers with `visibleTrackWindow`, asked of the same
 * `TrackRowLayout`, with a wider margin (a viewport above and below) so a fast
 * scroll never uncovers a gap. See `docs/plans/completed/track-virtualization` for the
 * rules this keeps:
 *
 * - At or below `TRACK_VIRTUALIZATION_MIN_ROWS`, or `enabled: false`, every row.
 * - Unknown viewport (no element, `clientHeight` 0 as in jsdom, a hidden view):
 *   every row. Mounting nothing there would hide every header from the tests.
 * - No render per scroll event: the scroll offset is read in a frame and the
 *   window is snapped outwards to blocks of `TRACK_WINDOW_BLOCK_ROWS`; only a
 *   block change re-renders.
 *
 * The last measured metrics live in a ref and the window is derived in render,
 * so a new layout (rows added, height changed, a folder folded) is windowed on
 * its very first render instead of mounting every row and then trimming.
 */

export type VisibleTrackRows = TrackRowWindow & {
  /** False when every row is mounted (small session, unknown viewport). */
  isWindowed: boolean;
  /** Pinned rows that fall outside `[startIndex, endIndex)`, ascending. */
  pinnedIndices: number[];
};

type UseVisibleTrackRowsOptions = {
  /** The vertical scroll container shared by headers, lanes and canvas. */
  viewportRef: RefObject<HTMLElement | null>;
  layout: TrackRowLayout;
  /** Sticky ruler height on top of the rows, inside the same viewport. */
  headerOffsetPx?: number;
  enabled?: boolean;
  /** Rows mounted even outside the window (dragged, focused, expanded). */
  pinnedIndices?: readonly number[];
  minRows?: number;
  blockRows?: number;
};

export type ViewportMetrics = { scrollTop: number; clientHeight: number };

const NO_PINNED: readonly number[] = [];

export function resolveVisibleTrackRows(
  layout: TrackRowLayout,
  metrics: ViewportMetrics | null,
  {
    headerOffsetPx = 0,
    enabled = true,
    minRows = TRACK_VIRTUALIZATION_MIN_ROWS,
    blockRows = TRACK_WINDOW_BLOCK_ROWS,
  }: Pick<UseVisibleTrackRowsOptions, "headerOffsetPx" | "enabled" | "minRows" | "blockRows">,
): TrackRowWindow & { isWindowed: boolean } {
  const rowCount = layout.heights.length;
  if (!enabled || rowCount <= minRows || !metrics || metrics.clientHeight <= 0) {
    return { startIndex: 0, endIndex: rowCount, isWindowed: false };
  }

  const visibleHeight = timelineVisibleTrackHeight(metrics.clientHeight, headerOffsetPx);
  const raw = visibleTrackWindow(layout, metrics.scrollTop, visibleHeight, {
    overscanPx: visibleHeight,
  });
  const block = Math.max(1, Math.floor(blockRows));
  return {
    startIndex: Math.floor(raw.startIndex / block) * block,
    endIndex: Math.min(rowCount, Math.ceil(raw.endIndex / block) * block),
    isWindowed: true,
  };
}

/** Scroll (passive, read in a frame) and resize listeners on the viewport. */
export function bindViewport(viewport: HTMLElement, sync: () => void) {
  let frameId: number | null = null;
  const measure = () => {
    frameId = null;
    sync();
  };
  const scheduleMeasure = () => {
    if (frameId === null) {
      frameId = requestAnimationFrame(measure);
    }
  };

  sync();
  viewport.addEventListener("scroll", scheduleMeasure, { passive: true });
  const resizeObserver =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
  resizeObserver?.observe(viewport);

  return () => {
    viewport.removeEventListener("scroll", scheduleMeasure);
    resizeObserver?.disconnect();
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
    }
  };
}

/** Pinned rows that fall outside the window, unique and ascending. */
export function outsidePinnedIndices(
  { startIndex, endIndex, isWindowed }: TrackRowWindow & { isWindowed: boolean },
  pinnedIndices: readonly number[],
  rowCount: number,
): number[] {
  if (!isWindowed || pinnedIndices.length === 0) {
    return [];
  }
  return [...new Set(pinnedIndices)]
    .filter(
      (index) =>
        Number.isInteger(index) &&
        index >= 0 &&
        index < rowCount &&
        (index < startIndex || index >= endIndex),
    )
    .sort((left, right) => left - right);
}

export function useVisibleTrackRows({
  viewportRef,
  layout,
  headerOffsetPx = 0,
  enabled = true,
  pinnedIndices = NO_PINNED,
  minRows = TRACK_VIRTUALIZATION_MIN_ROWS,
  blockRows = TRACK_WINDOW_BLOCK_ROWS,
}: UseVisibleTrackRowsOptions): VisibleTrackRows {
  const metricsRef = useRef<ViewportMetrics | null>(null);
  const [, setRenderTick] = useState(0);
  const options = { headerOffsetPx, enabled, minRows, blockRows };
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const window = resolveVisibleTrackRows(layout, metricsRef.current, options);
  // What the last render mounted; a frame only re-renders when it differs.
  const renderedRef = useRef(window);
  renderedRef.current = window;

  // Reads the viewport and re-renders only if the snapped window moved.
  const syncRef = useRef<(viewport: HTMLElement) => void>(() => {});
  syncRef.current = (viewport) => {
    const previous = metricsRef.current;
    const scrollTop = viewport.scrollTop;
    const clientHeight = viewport.clientHeight;
    if (previous?.scrollTop === scrollTop && previous.clientHeight === clientHeight) {
      return;
    }
    metricsRef.current = { scrollTop, clientHeight };
    const next = resolveVisibleTrackRows(layoutRef.current, metricsRef.current, optionsRef.current);
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

  // The viewport is only mounted in the DAW view, so it can appear, go and
  // be replaced while this hook lives: re-bind whenever the element changes.
  const bindingRef = useRef<{ element: HTMLElement; unbind: () => void } | null>(null);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (bindingRef.current?.element === viewport) {
      return;
    }
    bindingRef.current?.unbind();
    bindingRef.current = viewport
      ? { element: viewport, unbind: bindViewport(viewport, () => syncRef.current(viewport)) }
      : null;
  });
  useLayoutEffect(
    () => () => {
      bindingRef.current?.unbind();
      bindingRef.current = null;
    },
    [],
  );

  // A new layout can move the window without any scroll (and resize the
  // content, which clamps scrollTop). The derivation in render already uses the
  // new layout; this refreshes the metrics against it.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport) {
      syncRef.current(viewport);
    }
  }, [viewportRef, layout, headerOffsetPx, enabled, minRows, blockRows]);

  const { startIndex, endIndex, isWindowed } = window;
  const rowCount = layout.heights.length;
  const outsidePinned = useMemo(
    () => outsidePinnedIndices({ startIndex, endIndex, isWindowed }, pinnedIndices, rowCount),
    [isWindowed, pinnedIndices, rowCount, startIndex, endIndex],
  );

  return { startIndex, endIndex, isWindowed, pinnedIndices: outsidePinned };
}
