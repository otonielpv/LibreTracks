import { afterEach, describe, expect, it } from "vitest";

import {
  UI_ZOOM_STATUS_EVENT,
  dispatchUiZoomStatus,
  resetUiZoom,
  setUiZoom,
} from "./uiZoom";

describe("uiZoom", () => {
  afterEach(() => {
    resetUiZoom();
    document.body.innerHTML = "";
    document.documentElement.style.removeProperty("--lt-ui-zoom");
  });

  it("applies zoom and exposes the factor for shell viewport compensation", () => {
    document.body.innerHTML = '<main class="lt-app-shell"></main>';

    setUiZoom(0.7);

    const shell = document.querySelector<HTMLElement>(".lt-app-shell");
    expect(shell?.style.zoom).toBe("0.7");
    expect(document.documentElement.style.getPropertyValue("--lt-ui-zoom")).toBe(
      "0.7",
    );
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
