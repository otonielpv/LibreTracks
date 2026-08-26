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

export function timelineCanvasViewport(scrollTop: number, viewportHeight: number) {
  return {
    top: Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0),
    height: Math.max(1, Number.isFinite(viewportHeight) ? viewportHeight : 1),
  };
}
