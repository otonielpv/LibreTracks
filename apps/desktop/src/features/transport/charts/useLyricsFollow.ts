import { useEffect, useRef, useState, type RefObject } from "react";

import { PAGE_TURN_AT, READING_AT, type LyricsFocus } from "@libretracks/shared/charts/lyricsFollow";

export const MANUAL_SCROLL_HOLD_MS = 4000;

/**
 * Keeps the lyrics' focus in view (`lyricsFocus` decides what): the anchor
 * at 18 % of the height (or at the top for a whole section), reading only
 * downwards, paused for a few seconds after the reader scrolls by hand and
 * then back to the line playing even if no line changes. Runs only when the
 * anchor, the current line or the layout change: never per frame.
 *
 * With a focus of one line it does what the panel always did.
 */
export function useLyricsFollow(
  scrollerRef: RefObject<HTMLElement | null>,
  anchor: LyricsFocus["anchor"],
  /** The current line's key (`data-line-key`): a whole section turns pages by it. */
  lineKey: string | null,
  /** Font size, chords shown…: the same anchor lands elsewhere. */
  layout: readonly unknown[],
): { markManualScroll: () => void } {
  const manualScrollAtRef = useRef(Number.NEGATIVE_INFINITY);
  const [returnTick, setReturnTick] = useState(0);
  const returnPendingRef = useRef(false);
  const returnTimerRef = useRef<number | null>(null);
  /** What the last scroll was for: a section's lines moving inside the page
   * do not scroll again. */
  const lastRef = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (returnTimerRef.current !== null) window.clearTimeout(returnTimerRef.current);
    },
    [],
  );

  const layoutKey = layout.map(String).join("|");
  const anchorKey = anchor?.key ?? null;
  const align = anchor?.align ?? null;
  // A whole section follows the line only to turn pages; the other focuses
  // move with their anchor alone.
  const pageKey = align === "top" ? lineKey : null;

  useEffect(() => {
    const scroller = scrollerRef.current;
    const returning = returnPendingRef.current;
    returnPendingRef.current = false;
    if (!scroller || anchorKey === null) return;
    if (performance.now() - manualScrollAtRef.current < MANUAL_SCROLL_HOLD_MS) return;
    const find = (key: string) => scroller.querySelector<HTMLElement>(`[data-line-key="${key}"]`);
    const offsetOf = (element: HTMLElement) =>
      // From the on-screen positions, not offsetTop: offsetTop is measured
      // from the nearest positioned ancestor, which is not the scroller, and
      // on iOS that put the current line out of view.
      element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;

    let target = find(anchorKey);
    let at = align === "top" ? 0 : READING_AT;
    const runKey = `${anchorKey}|${layoutKey}`;
    if (align === "top" && pageKey) {
      const line = find(pageKey);
      const lineOffset = line ? offsetOf(line) : 0;
      if (line && lineOffset > scroller.clientHeight * PAGE_TURN_AT) {
        // The section does not fit: the page turns to the current line.
        target = line;
        at = 0;
      } else if (!returning && lastRef.current === runKey) {
        return;
      }
    }
    if (!target) return;
    const offset = offsetOf(target);
    const top = Math.max(0, scroller.scrollTop + offset - scroller.clientHeight * at);
    lastRef.current = runKey;
    // Reading only goes down: never back up to a line that is already on
    // screen. Up only to bring back a line above the panel (the reader had
    // scrolled away by hand).
    if (!returning && top < scroller.scrollTop && offset >= 0) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (typeof scroller.scrollTo === "function") {
      scroller.scrollTo({ top, behavior: reduceMotion ? "auto" : "smooth" });
    } else {
      scroller.scrollTop = top;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorKey, align, pageKey, layoutKey, returnTick]);

  const markManualScroll = () => {
    manualScrollAtRef.current = performance.now();
    if (returnTimerRef.current !== null) window.clearTimeout(returnTimerRef.current);
    returnTimerRef.current = window.setTimeout(() => {
      returnTimerRef.current = null;
      returnPendingRef.current = true;
      setReturnTick((tick) => tick + 1);
    }, MANUAL_SCROLL_HOLD_MS + 50);
  };

  return { markManualScroll };
}
