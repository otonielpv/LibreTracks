/**
 * Auto-scroll rule for the remote's marker grid.
 *
 * On stage the grid is often taller than its widget: on a phone you see two
 * rows and a sliver of the third. When the song advances past the last visible
 * marker the next jump target scrolls out of sight, and the musician has to
 * find it by hand mid-song. This keeps the row holding the NEXT marker on
 * screen by itself.
 *
 * Kept free of React and of the DOM (it takes plain numbers) so the "when do we
 * scroll, and to where" decision can be unit-tested without a layout engine.
 * The component in App.tsx measures the real elements and applies the result.
 */

/** Geometry of the scroller and of the card we want to keep visible. All
 * values in pixels, offsets relative to the scroller's content box (i.e. what
 * `offsetTop` gives once the scroller is the offset parent). */
export type MarkerAutoScrollInput = {
  /** Current scrollTop of the grid. */
  scrollTop: number;
  /** Visible height of the grid. */
  viewportHeight: number;
  /** Full scrollable height of the grid's content. */
  contentHeight: number;
  /** Top of the next marker's card within the content. */
  cardTop: number;
  /** Height of that card. */
  cardHeight: number;
  /** Breathing room left above the card once it's parked at the top, so the
   * row does not look glued to the widget's edge. */
  topPadding?: number;
};

/** Slack allowed before we consider a card "not visible enough". A card whose
 * bottom edge is a couple of pixels under the fold is fine — sub-pixel layout
 * and rounding should not trigger a scroll. */
export const MARKER_SCROLL_EPSILON_PX = 2;

/** Default gap kept above the parked row. */
export const MARKER_SCROLL_TOP_PADDING_PX = 6;

/**
 * The scrollTop the grid should move to so the next marker's row is visible,
 * or null when no scroll is needed (the card is already fully on screen, or
 * the grid does not scroll at all).
 *
 * The target parks the card's row at the TOP of the viewport rather than
 * merely nudging it into view: the rows after the next marker are the ones the
 * player is about to need, so the useful space is below the current row, not
 * above it. The result is clamped to the scroller's real range, so the last
 * rows of a song settle at the bottom instead of leaving blank space.
 */
export function resolveMarkerAutoScrollTop(
  input: MarkerAutoScrollInput,
): number | null {
  const {
    scrollTop,
    viewportHeight,
    contentHeight,
    cardTop,
    cardHeight,
    topPadding = MARKER_SCROLL_TOP_PADDING_PX,
  } = input;

  if (!Number.isFinite(cardTop) || viewportHeight <= 0) {
    return null;
  }

  const maxScrollTop = Math.max(0, contentHeight - viewportHeight);
  if (maxScrollTop <= 0) {
    // Everything fits: there is nothing to scroll and nothing to hide.
    return null;
  }

  const visibleTop = scrollTop;
  const visibleBottom = scrollTop + viewportHeight;
  const cardBottom = cardTop + cardHeight;
  const fullyVisible =
    cardTop >= visibleTop - MARKER_SCROLL_EPSILON_PX &&
    cardBottom <= visibleBottom + MARKER_SCROLL_EPSILON_PX;
  if (fullyVisible) {
    return null;
  }

  const target = Math.min(
    maxScrollTop,
    Math.max(0, cardTop - topPadding),
  );
  // Clamping can land us where we already are (the card is taller than the
  // viewport, or we're pinned at the bottom); don't report a no-op scroll.
  if (Math.abs(target - scrollTop) <= MARKER_SCROLL_EPSILON_PX) {
    return null;
  }
  return target;
}
