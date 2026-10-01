// getBoundingClientRect() under the interface zoom, made to mean the same thing
// in every WebView.
//
// The UI zoom is a CSS `zoom` on the app shell. Engines that implement the
// standardized `zoom` (Chromium/WebView2/Android) report getBoundingClientRect()
// in VIEWPORT pixels — the same space as event.clientX/Y — and all the pointer
// math in the app (clientXToLocalX, getElementScaleX, popover placement) is
// written for that. The legacy WebKit `zoom` (the iOS WKWebView, and the system
// WebKit on older macOS) instead divides the rect by the element's zoom, so it
// comes back in the element's own zoomed space while clientX stays in viewport
// pixels. Mixing the two puts every click off by clientX * (1 - 1/zoom): at 75 %
// a tap on the timeline seeked to the left of the finger, at 125 % to the right.
//
// Rather than teaching dozens of call sites about both models, we detect the
// legacy behavior once per zoom change with a 100px probe inside the zoomed
// element and, only there, scale rects of zoomed elements back to viewport
// pixels. On standard engines (and at zoom 1) this is a no-op.

const PROBE_CSS_WIDTH = 100;
const TOLERANCE = 0.05;

let installed = false;
let rectScale = 1;
let zoomTarget: HTMLElement | null = null;
let originalGetBoundingClientRect: (() => DOMRect) | null = null;

/**
 * Factor that turns a raw getBoundingClientRect() of an element inside the
 * zoomed target into viewport pixels: `zoom` on legacy WebKit, 1 elsewhere.
 * Returns 1 when the measurement is inconclusive (zoom 1, no layout, jsdom).
 */
export function detectRectScale(
  probeRectWidth: number,
  zoom: number,
  probeCssWidth = PROBE_CSS_WIDTH,
): number {
  if (!(probeRectWidth > 0) || !(zoom > 0) || Math.abs(zoom - 1) < TOLERANCE) {
    return 1;
  }
  const ratio = probeRectWidth / (probeCssWidth * zoom);
  // Standard: the rect already includes the zoom.
  if (Math.abs(ratio - 1) < TOLERANCE) return 1;
  // Legacy WebKit: the rect came back divided by the zoom.
  if (Math.abs(ratio * zoom - 1) < TOLERANCE) return zoom;
  return 1;
}

export function scaleRect(rect: DOMRect, scale: number): DOMRect {
  return new DOMRect(
    rect.x * scale,
    rect.y * scale,
    rect.width * scale,
    rect.height * scale,
  );
}

function install(): void {
  if (installed || typeof Element === "undefined") return;
  installed = true;
  const original = Element.prototype.getBoundingClientRect;
  originalGetBoundingClientRect = original;
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(
    this: Element,
  ): DOMRect {
    const rect = original.call(this);
    if (rectScale === 1 || !zoomTarget || !zoomTarget.contains(this)) {
      return rect;
    }
    return scaleRect(rect, rectScale);
  };
}

/**
 * Re-measure after the zoom changed on `target`. Call with the element that
 * carries the CSS `zoom`.
 */
export function syncZoomedRects(target: HTMLElement, zoom: number): void {
  if (typeof document === "undefined") return;
  const probe = document.createElement("div");
  probe.style.cssText =
    `position:absolute;left:0;top:0;width:${PROBE_CSS_WIDTH}px;height:1px;` +
    "visibility:hidden;pointer-events:none;";
  target.appendChild(probe);
  const measure = originalGetBoundingClientRect ?? probe.getBoundingClientRect;
  const width = measure.call(probe).width;
  probe.remove();

  const scale = detectRectScale(width, zoom);
  zoomTarget = target;
  rectScale = scale;
  if (scale !== 1) install();
}

/** Current rect correction factor (for diagnostics). */
export function getZoomedRectScale(): number {
  return rectScale;
}
