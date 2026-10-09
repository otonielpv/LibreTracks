const SPLASH_ID = "lt-boot-splash";
/** Matches the opacity transition in index.html. */
const FADE_MS = 180;

/**
 * Retire the static loading screen that index.html paints before React loads.
 * Fades it out, then removes it from the DOM. Safe to call more than once and
 * when there is no splash (tests, the remote's build).
 */
export function dismissBootSplash(doc: Document = document): void {
  const splash = doc.getElementById(SPLASH_ID);
  if (!splash || splash.classList.contains("is-leaving")) {
    return;
  }
  splash.classList.add("is-leaving");
  window.setTimeout(() => splash.remove(), FADE_MS);
}
