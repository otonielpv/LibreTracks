import { afterEach, describe, expect, it } from "vitest";

import {
  UI_ZOOM_STATUS_EVENT,
  dispatchUiZoomStatus,
  resetUiZoom,
  setUiZoom,
  shouldCompensateUiZoomViewport,
} from "./uiZoom";

describe("uiZoom", () => {
  afterEach(() => {
    resetUiZoom();
    document.body.innerHTML = "";
    document.documentElement.style.removeProperty("--lt-ui-zoom");
    document.documentElement.classList.remove(
      "lt-ui-zoom-compensate-viewport",
    );
  });

  it("applies zoom and exposes the factor for platform viewport compensation", () => {
    document.body.innerHTML = '<main class="lt-app-shell"></main>';

    setUiZoom(0.7);

    const shell = document.querySelector<HTMLElement>(".lt-app-shell");
    expect(shell?.style.zoom).toBe("0.7");
    expect(document.documentElement.style.getPropertyValue("--lt-ui-zoom")).toBe(
      "0.7",
    );
  });

  it("uses viewport compensation on Blink WebViews (Windows + Android), not WebKit", () => {
    expect(
      shouldCompensateUiZoomViewport(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Win32",
      ),
    ).toBe(true);
    expect(
      shouldCompensateUiZoomViewport(
        "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36",
        "Linux armv8l",
      ),
    ).toBe(true);
    expect(
      shouldCompensateUiZoomViewport(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        "MacIntel",
      ),
    ).toBe(false);
  });

  it("dispatches the current zoom for status overlays", () => {
    let observedZoom: number | null = null;
    const listener = (event: Event) => {
      observedZoom =
        (event as CustomEvent<{ zoom: number }>).detail.zoom;
    };

    window.addEventListener(UI_ZOOM_STATUS_EVENT, listener);
    dispatchUiZoomStatus(0.8);
    window.removeEventListener(UI_ZOOM_STATUS_EVENT, listener);

    expect(observedZoom).toBe(0.8);
  });
});
