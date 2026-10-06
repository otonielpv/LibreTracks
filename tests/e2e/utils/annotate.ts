import { browser } from "@wdio/globals";
import { drawMarks, OVERLAY_ID, type AnnotateOptions, type Box, type Mark } from "./annotateOverlay.js";

/**
 * Callouts drawn over the REAL interface for the user guide screenshots.
 *
 * The marks are injected into the DOM at the live position of each control
 * (getBoundingClientRect), so an image can be re-shot on the next release over
 * the same filename without anyone redrawing arrows by hand: if a button moves,
 * its mark moves with it, and if it disappears the capture fails loudly.
 *
 * Styles:
 * - "callouts": numbered boxes, for an overview of a whole area. The page
 *   that shows the image carries a legend with the same numbers.
 * - "spotlight": everything outside the targets is dimmed, for "this is where
 *   X lives". Targets may also carry a short caption.
 */
export type { AnnotateOptions, Box, Mark } from "./annotateOverlay.js";


/**
 * browser.execute with a `__name` shim. esbuild wraps every named function
 * (including `const f = () => ...`) in a `__name(...)` helper that does not
 * exist in the page, so a non-trivial script cannot be passed as-is.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runInPage<T>(fn: (...args: any[]) => T, ...args: unknown[]): Promise<T> {
  const script = `var __name = function (f) { return f; };\nreturn (${fn.toString()}).apply(null, arguments);`;
  return browser.execute(script, ...args) as Promise<T>;
}

/** Live rect of the first visible match (or nth), or null. */
export async function rectOf(selector: string, nth = 0): Promise<Box | null> {
  return runInPage(
    (sel: string, index: number) => {
      const el = Array.from(document.querySelectorAll(sel)).filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })[index];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    },
    selector,
    nth,
  );
}

/**
 * Draws the marks and returns the boxes it drew (badges and captions
 * included), so the caller can crop the capture around them. Throws listing
 * any selector that matched nothing visible.
 */
export async function annotate(marks: Mark[], options: AnnotateOptions = {}): Promise<Box[]> {
  const result = await runInPage(
    drawMarks,
    marks,
    options.style ?? "callouts",
    OVERLAY_ID,
  );
  if (result.notFound.length > 0) {
    await clearAnnotations();
    throw new Error(`annotate: no visible element for ${result.notFound.join(", ")}`);
  }
  return result.drawn;
}

export async function clearAnnotations() {
  await browser.execute((overlayId: string) => {
    document.getElementById(overlayId)?.remove();
  }, OVERLAY_ID);
}

/** Union of boxes grown by `margin`, clamped to the viewport. */
export function unionBox(boxes: Box[], margin: number, viewport: { w: number; h: number }): Box {
  const x0 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - margin);
  const y0 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - margin);
  const x1 = Math.min(viewport.w, Math.max(...boxes.map((b) => b.x + b.w)) + margin);
  const y1 = Math.min(viewport.h, Math.max(...boxes.map((b) => b.y + b.h)) + margin);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
