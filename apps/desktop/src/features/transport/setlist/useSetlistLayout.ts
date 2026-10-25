import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * Size class of the Setlist view (docs/plans/setlist-view/00-DISENO.md §4).
 * It depends on the view's own area, not on the device: the library and the
 * side panel take width away. Touch behaviour is a separate axis
 * (`isMobileApp`); resizing a desktop window changes the layout, never the
 * input model.
 */
export type SetlistLayoutClass = "wide" | "medium" | "short";

/** `wide` needs at least this width… */
export const SETLIST_WIDE_MIN_WIDTH_PX = 1200;
/** …and strictly more than this height. Follows the 620px the transport
 * panel already treats as a "full" desktop height. */
export const SETLIST_WIDE_MIN_HEIGHT_EXCLUSIVE_PX = 620;
/** At or below this height the view is `short` (phone in landscape). Same
 * `max-height: 500px` as LivePerformanceView.css and structure.css. */
export const SETLIST_SHORT_MAX_HEIGHT_PX = 500;

export function classifySetlistLayout(
  width: number,
  height: number,
): SetlistLayoutClass {
  // No measurement yet (jsdom, first frame): the default layout.
  if (!(width > 0) || !(height > 0)) return "wide";
  if (height <= SETLIST_SHORT_MAX_HEIGHT_PX) return "short";
  if (
    width >= SETLIST_WIDE_MIN_WIDTH_PX &&
    height > SETLIST_WIDE_MIN_HEIGHT_EXCLUSIVE_PX
  ) {
    return "wide";
  }
  return "medium";
}

/**
 * Measures `containerRef` with a ResizeObserver and returns its size class.
 * Only sets state when the CLASS changes: a window drag that stays inside
 * one class never re-renders the view. `forced` always wins (tests).
 */
export function useSetlistLayout(
  containerRef: RefObject<HTMLElement | null>,
  forced?: SetlistLayoutClass,
): SetlistLayoutClass {
  const [measured, setMeasured] = useState<SetlistLayoutClass>("wide");
  const measuredRef = useRef<SetlistLayoutClass>("wide");

  useLayoutEffect(() => {
    if (forced) return;
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const apply = (width: number, height: number) => {
      const next = classifySetlistLayout(width, height);
      if (next === measuredRef.current) return;
      measuredRef.current = next;
      setMeasured(next);
    };
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (rect) apply(rect.width, rect.height);
    });
    observer.observe(element);
    apply(element.clientWidth, element.clientHeight);
    return () => observer.disconnect();
  }, [containerRef, forced]);

  return forced ?? measured;
}
