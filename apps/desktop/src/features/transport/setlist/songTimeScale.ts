/**
 * The ONE seconds ↔ px conversion of the Setlist view (00-DISENO §5).
 *
 * Everything that places something in time inside a song — the overview
 * waveform, the map overlaid on it, section editing and every lane of step
 * 11+ — goes through this, so two parts of the view can never disagree on
 * where a second sits (the DAW's ruler vs lane mix-up, memory
 * project_ruler_vs_lane_coordinate_spaces).
 *
 * `zoom = 1` fits the song in `widthPx`; `zoom > 1` widens the content and
 * `scrollPx` (clamped) says which part is visible. Coordinates are relative to
 * the visible area's left edge. Passing `widthPx: 100` yields percentages.
 */
export type SongTimeScale = {
  startSeconds: number;
  endSeconds: number;
  widthPx: number;
  zoom: number;
  /** The clamped scroll actually applied. */
  scrollPx: number;
  contentWidthPx: number;
  pxPerSecond: number;
  secondsToPx: (seconds: number) => number;
  pxToSeconds: (px: number) => number;
  clampSeconds: (seconds: number) => number;
};

export function createSongTimeScale({
  startSeconds,
  endSeconds,
  widthPx,
  zoom = 1,
  scrollPx = 0,
}: {
  startSeconds: number;
  endSeconds: number;
  widthPx: number;
  zoom?: number;
  scrollPx?: number;
}): SongTimeScale {
  const duration = Math.max(0, endSeconds - startSeconds);
  const width = Math.max(0, widthPx);
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? Math.max(1, zoom) : 1;
  const contentWidthPx = width * safeZoom;
  const maxScroll = Math.max(0, contentWidthPx - width);
  const scroll = Math.max(0, Math.min(maxScroll, Number.isFinite(scrollPx) ? scrollPx : 0));
  const pxPerSecond = duration > 0 ? contentWidthPx / duration : 0;
  const clampSeconds = (seconds: number) =>
    Math.max(startSeconds, Math.min(endSeconds, seconds));
  return {
    startSeconds,
    endSeconds,
    widthPx: width,
    zoom: safeZoom,
    scrollPx: scroll,
    contentWidthPx,
    pxPerSecond,
    secondsToPx: (seconds) => (seconds - startSeconds) * pxPerSecond - scroll,
    pxToSeconds: (px) =>
      pxPerSecond > 0 ? startSeconds + (px + scroll) / pxPerSecond : startSeconds,
    clampSeconds,
  };
}
