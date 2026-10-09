import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";

import type { ChartDocument } from "./pdfLoader";
import {
  chartPointAt,
  layoutChartPages,
  visibleChartPages,
  type ChartPageLayout,
} from "./chartModel";

const PAGE_GAP_PX = 12;
/** Ceiling on one page's bitmap. A landscape phone at DPR 3 would otherwise
 * allocate ~40 MB per A4 page; three of them alive is enough to get the
 * WebView killed on a low-end Android. */
const MAX_CANVAS_PIXELS = 4_000_000;

export type ChartPageMarker = {
  markerId: string;
  page: number;
  y: number;
  label: string;
  color: string;
};

type ChartPagesProps = {
  document: ChartDocument;
  aspects: readonly number[];
  /** Anchors drawn over the pages (all of them while editing). */
  markers: readonly ChartPageMarker[];
  /** The anchor being followed, drawn as a line across the page. */
  currentMarkerId: string | null;
  /** Where to scroll, recomputed by the parent from the layout; `key` changes
   * each time the chart should move even if the target is the same. */
  scrollRequest: { key: string; top: (layout: ChartPageLayout, viewportHeight: number) => number } | null;
  editing: boolean;
  onPick: (page: number, y: number) => void;
};

function ChartPageCanvas({
  document,
  pageIndex,
  width,
  height,
}: {
  document: ChartDocument;
  pageIndex: number;
  width: number;
  height: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<void> } | null = null;

    void document.getPage(pageIndex + 1).then((page) => {
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      let scale = (width * dpr) / base.width;
      const pixels = base.width * scale * base.height * scale;
      if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
      const viewport = page.getViewport({ scale });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) return;
      task = page.render({ canvasContext: context, viewport });
      task.promise.catch(() => {
        // Cancelled by a resize or by scrolling away: nothing to report.
      });
    });

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [document, pageIndex, width]);

  // Releasing the bitmap explicitly: WebKit keeps a detached canvas's backing
  // store until GC, which on iOS is long enough to hit the memory limit.
  useEffect(
    () => () => {
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    },
    [],
  );

  return (
    <canvas
      ref={canvasRef}
      className="lt-chart-page-canvas"
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}

export const ChartPages = memo(function ChartPages({
  document,
  aspects,
  markers,
  currentMarkerId,
  scrollRequest,
  editing,
  onPick,
}: ChartPagesProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [visible, setVisible] = useState<number[]>([]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const measure = () =>
      setSize((current) =>
        current.width === scroller.clientWidth && current.height === scroller.clientHeight
          ? current
          : { width: scroller.clientWidth, height: scroller.clientHeight },
      );
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(
    () => layoutChartPages(aspects, size.width, PAGE_GAP_PX),
    [aspects, size.width],
  );
  const contentHeight =
    layout.tops.length > 0
      ? layout.tops[layout.tops.length - 1] + layout.heights[layout.heights.length - 1]
      : 0;

  // Which pages to draw, re-derived at most once a frame while scrolling and
  // published only when the set changes.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const next = visibleChartPages(layout, scroller.scrollTop, scroller.clientHeight);
      setVisible((current) =>
        current.length === next.length && current.every((page, index) => page === next[index])
          ? current
          : next,
      );
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [layout]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !scrollRequest || size.width <= 0) return;
    const top = scrollRequest.top(layout, scroller.clientHeight);
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (typeof scroller.scrollTo === "function") {
      scroller.scrollTo({ top, behavior: reduceMotion ? "auto" : "smooth" });
    } else {
      scroller.scrollTop = top;
    }
    // `layout` is left out on purpose: a resize must not yank the chart back
    // to the anchor the user may have scrolled away from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRequest?.key, size.width > 0]);

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!editing) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = chartPointAt(layout, event.clientY - rect.top);
    if (point) onPick(point.page, point.y);
  };

  return (
    <div ref={scrollerRef} className="lt-chart-scroller" data-editing={editing || undefined}>
      <div
        className="lt-chart-content"
        style={{ height: contentHeight }}
        onClick={handleClick}
        data-testid="chart-content"
      >
        {layout.tops.map((top, page) => (
          <div
            key={page}
            className="lt-chart-page"
            style={{ top, height: layout.heights[page] }}
            data-page={page}
          >
            {visible.includes(page) ? (
              <ChartPageCanvas
                document={document}
                pageIndex={page}
                width={size.width}
                height={layout.heights[page]}
              />
            ) : null}
          </div>
        ))}
        {markers.map((marker) => {
          if (marker.page >= layout.tops.length) return null;
          const top = layout.tops[marker.page] + marker.y * layout.heights[marker.page];
          const current = marker.markerId === currentMarkerId;
          if (!editing && !current) return null;
          return (
            <div
              key={marker.markerId}
              className={`lt-chart-anchor${current ? " is-current" : ""}`}
              style={{ top, ["--lt-chart-anchor-color" as string]: marker.color }}
            >
              <span>{marker.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
});
