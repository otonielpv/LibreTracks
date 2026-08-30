import { describe, expect, it } from "vitest";

import { intersectVisibleBounds } from "./gestureBounds";

function element(rect: {
  left: number;
  top: number;
  right: number;
  bottom: number;
}) {
  const node = document.createElement("div");
  node.getBoundingClientRect = () =>
    ({
      ...rect,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
    }) as DOMRect;
  return node;
}

describe("intersectVisibleBounds", () => {
  it("recorta el área de pistas a lo que cabe en el visor", () => {
    // Veinte pistas: el elemento se sale de la pantalla por arriba y por abajo.
    const lanes = element({ left: 200, top: -400, right: 800, bottom: 1600 });
    const viewport = element({ left: 200, top: 0, right: 800, bottom: 390 });

    const bounds = intersectVisibleBounds(lanes, viewport);

    expect(bounds).not.toBeNull();
    expect(bounds!.top).toBe(0);
    expect(bounds!.bottom).toBe(390);
  });

  it("sin visor, el área es la del propio elemento", () => {
    const ruler = element({ left: 200, top: 0, right: 800, bottom: 94 });

    expect(intersectVisibleBounds(ruler, null)!.bottom).toBe(94);
  });

  it("devuelve nulo si no se ve nada del elemento", () => {
    const lanes = element({ left: 200, top: 600, right: 800, bottom: 1600 });
    const viewport = element({ left: 200, top: 0, right: 800, bottom: 390 });

    expect(intersectVisibleBounds(lanes, viewport)).toBeNull();
  });

  it("devuelve nulo si no hay elemento", () => {
    expect(intersectVisibleBounds(null, null)).toBeNull();
  });
});
