import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { useSongStore } from "../songStore";

/** Shown alone when no session is loaded, and as the suffix otherwise. */
const APP_NAME = "LibreTracks";

/**
 * Keeps the OS window title in sync with the loaded project:
 * `"LibreTracks — <session name>"`, falling back to just `"LibreTracks"` when
 * no session is open (landing screen, fresh start).
 *
 * The native window title must be set through the Tauri window API: the webview
 * owns `document.title`, but the surrounding native window takes its title from
 * `tauri.conf.json` and never reads the document, so setting `document.title`
 * alone leaves the title bar showing the configured "LibreTracks".
 *
 * Self-contained by design: it subscribes to the one `songStore` slice it
 * needs, so a project rename re-runs this effect and nothing else. Failures are
 * swallowed — a title is cosmetic, and this also keeps the hook harmless in the
 * test environment, where there is no Tauri runtime behind the API.
 */
export function useWindowTitle(): void {
  const sessionName = useSongStore((state) => state.song?.sessionName ?? null);

  useEffect(() => {
    const trimmed = sessionName?.trim();
    const title = trimmed ? `${APP_NAME} — ${trimmed}` : APP_NAME;
    document.title = title;
    void (async () => {
      try {
        await getCurrentWindow().setTitle(title);
      } catch (error) {
        // No Tauri runtime (browser/dev/test) — the document title is enough.
        // Anything else (a missing `core:window:allow-set-title` capability,
        // most likely) leaves the title bar silently stale, so say so instead
        // of swallowing it.
        console.warn("Could not set the native window title", error);
      }
    })();
  }, [sessionName]);
}
