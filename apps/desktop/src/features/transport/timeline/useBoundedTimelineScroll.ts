import { useEffect, type RefObject } from "react";

/** Logical maximum, independent of WebKit's transient scrollable-overflow. */
export function boundedTimelineScrollTop(
  scrollTop: number,
  viewportHeight: number,
  contentHeight: number,
) {
  const safeViewportHeight = Number.isFinite(viewportHeight)
    ? Math.max(0, viewportHeight)
    : 0;
  const safeContentHeight = Number.isFinite(contentHeight)
    ? Math.max(0, contentHeight)
    : 0;
  const maxScrollTop = Math.max(0, safeContentHeight - safeViewportHeight);
  const safeScrollTop = Number.isFinite(scrollTop) ? scrollTop : 0;
  return Math.min(maxScrollTop, Math.max(0, safeScrollTop));
}

/**
 * Keeps the timeline scroller inside the height of its real rows.
 *
 * In WKWebView, absolutely-positioned canvas slices can temporarily leak into
 * scrollable overflow even when their parent clips. Using scrollHeight as the
 * bound would preserve that feedback loop, so this hook uses the known ruler +
 * track-scene height instead.
 */
export function useBoundedTimelineScroll(
  viewportRef: RefObject<HTMLDivElement | null>,
  contentHeight: number,
) {
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const clampScroll = () => {
      const nextScrollTop = boundedTimelineScrollTop(
        viewport.scrollTop,
        viewport.clientHeight,
        contentHeight,
      );
      if (viewport.scrollTop !== nextScrollTop) {
        viewport.scrollTop = nextScrollTop;
      }
    };

    clampScroll();
    viewport.addEventListener("scroll", clampScroll, { passive: true });
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(clampScroll)
        : null;
    observer?.observe(viewport);

    return () => {
      viewport.removeEventListener("scroll", clampScroll);
      observer?.disconnect();
    };
  }, [contentHeight, viewportRef]);
}
