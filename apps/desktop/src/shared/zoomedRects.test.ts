import { describe, expect, it } from "vitest";

import { detectRectScale, scaleRect } from "./zoomedRects";

describe("detectRectScale", () => {
  it("leaves standard engines alone (rect already includes the zoom)", () => {
    expect(detectRectScale(125, 1.25)).toBe(1);
    expect(detectRectScale(75, 0.75)).toBe(1);
  });

  it("scales legacy WebKit rects (reported without the zoom) back by the zoom", () => {
    expect(detectRectScale(100, 1.25)).toBe(1.25);
    expect(detectRectScale(100, 0.75)).toBe(0.75);
  });

  it("is a no-op at zoom 1 and when nothing was laid out", () => {
    expect(detectRectScale(100, 1)).toBe(1);
    expect(detectRectScale(0, 1.25)).toBe(1);
  });
});

describe("scaleRect", () => {
  it("scales position and size", () => {
    const rect = scaleRect(new DOMRect(80, 40, 400, 20), 1.25);
    expect([rect.left, rect.top, rect.width, rect.height]).toEqual([
      100, 50, 500, 25,
    ]);
  });
});

describe("syncZoomedRects", () => {
  it("brings legacy-WebKit rects inside the zoomed shell back to viewport pixels", async () => {
    // Fake a legacy WebKit: every rect comes back in the element's own zoomed
    // space, i.e. a 100px probe measures 100 regardless of the zoom.
    const legacy = () => new DOMRect(80, 40, 100, 20);
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = legacy;
    try {
      const { syncZoomedRects, getZoomedRectScale } = await import(
        "./zoomedRects"
      );
      document.body.innerHTML =
        '<main class="lt-app-shell"><div id="inside"></div></main><div id="outside"></div>';
      const shell = document.querySelector<HTMLElement>(".lt-app-shell")!;

      syncZoomedRects(shell, 1.25);

      expect(getZoomedRectScale()).toBe(1.25);
      const inside = document.getElementById("inside")!.getBoundingClientRect();
      expect([inside.left, inside.width]).toEqual([100, 125]);
      const outside = document.getElementById("outside")!.getBoundingClientRect();
      expect([outside.left, outside.width]).toEqual([80, 100]);

      syncZoomedRects(shell, 1);
      expect(getZoomedRectScale()).toBe(1);
      expect(document.getElementById("inside")!.getBoundingClientRect().left).toBe(80);
    } finally {
      Element.prototype.getBoundingClientRect = original;
      document.body.innerHTML = "";
    }
  });
});
