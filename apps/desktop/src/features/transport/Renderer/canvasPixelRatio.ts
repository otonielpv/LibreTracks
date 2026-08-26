/**
 * Timeline canvases are redrawn continuously while panning. Mobile WebViews
 * commonly report DPR 3 or 4, where painting at the native ratio multiplies
 * the backing-store work by 9-16 without a useful gain at DAW scale.
 */
export function timelineCanvasPixelRatio(
  devicePixelRatio =
    typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
  mobile =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("lt-mobile"),
) {
  const safeRatio = Number.isFinite(devicePixelRatio)
    ? Math.max(1, devicePixelRatio)
    : 1;
  return mobile ? Math.min(2, safeRatio) : safeRatio;
}

/**
 * Vertical slice of the track scene that the canvases must hold, in track-area
 * coordinates.
 *
 * The canvases are absolutely positioned inside the track layer, so their box
 * takes part in the scroll container's scrollable overflow: a slice whose
 * bottom edge lands past the scene grows `scrollHeight`, which raises the max
 * `scrollTop`, which pushes the slice further down on the next frame — an
 * endless vertical scroll trailing empty black space. Clamping the slice to the
 * scene is what keeps that loop closed, so the slice never adds scroll of its
 * own. Values are floored (never rounded up) for the same reason.
 */
export function timelineCanvasViewport(
  scrollTop: number,
  viewportHeight: number,
  sceneHeight = Number.POSITIVE_INFINITY,
) {
  const safeScene =
    typeof sceneHeight === "number" && !Number.isNaN(sceneHeight)
      ? Math.max(1, sceneHeight)
      : Number.POSITIVE_INFINITY;
  const requestedHeight = Number.isFinite(viewportHeight) ? viewportHeight : 1;
  const height = Math.max(1, Math.floor(Math.min(requestedHeight, safeScene)));
  const requestedTop = Number.isFinite(scrollTop) ? scrollTop : 0;
  const maxTop = Number.isFinite(safeScene)
    ? Math.max(0, safeScene - height)
    : Number.POSITIVE_INFINITY;

  return {
    top: Math.max(0, Math.floor(Math.min(requestedTop, maxTop))),
    height,
  };
}

/**
 * Band of track lanes the user can actually see, in pixels.
 *
 * The ruler row is sticky at the top of the same scroll viewport as the lanes,
 * so it permanently covers `rulerHeight` of it. Feeding the raw viewport height
 * to the slice makes every canvas a ruler taller than it needs to be — the
 * backing store this slice exists to shrink.
 */
export function timelineVisibleTrackHeight(
  scrollViewportHeight: number,
  rulerHeight: number,
) {
  const safeViewport = Number.isFinite(scrollViewportHeight)
    ? scrollViewportHeight
    : 0;
  const safeRuler = Number.isFinite(rulerHeight) ? Math.max(0, rulerHeight) : 0;
  return Math.max(1, Math.floor(safeViewport - safeRuler));
}
