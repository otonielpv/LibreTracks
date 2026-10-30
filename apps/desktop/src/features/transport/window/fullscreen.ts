import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Flips the main window between fullscreen and windowed.
 *
 * Goes through the Tauri window API, not `document.requestFullscreen()`: the
 * DOM call only fills the webview's client area and leaves the native title
 * bar and taskbar in place on Windows, which is not what F11 means to anyone.
 * Needs `core:window:allow-is-fullscreen` and `core:window:allow-set-fullscreen`
 * in the capability file.
 *
 * Failures are logged, not thrown: there is no Tauri runtime in tests or the
 * plain-browser dev server, and a key press is no place to surface an error.
 */
export async function toggleFullscreen(): Promise<void> {
  try {
    const window = getCurrentWindow();
    await window.setFullscreen(!(await window.isFullscreen()));
  } catch (error) {
    console.warn("Could not toggle fullscreen", error);
  }
}
