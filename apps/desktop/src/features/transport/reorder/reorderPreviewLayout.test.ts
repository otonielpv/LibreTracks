// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { buildTrackRowLayout } from "../tracks/trackLayout";
import { createReorderPreview, type ReorderPreviewItem } from "./reorderPreview";

/**
 * Paso 04 de `docs/plans/completed/track-virtualization`: la vista previa del reordenado
 * acepta items con su posicion del layout y sin elemento (fila no montada), y
 * adjunta el elemento cuando aparece.
 */

const ids = ["a", "b", "c", "d", "e", "f"];
const layout = buildTrackRowLayout(
  ids.map((id, index) => ({ id, heightOffset: [0, 24, -8, 0, 60, 0][index] })),
  40,
);

/** Filas con el rect del navegador: origen en `originTop`, zoom `scale`. */
function mountRows(originTop: number, scale: number) {
  const elements = new Map<string, HTMLElement>();
  ids.forEach((id, index) => {
    const row = document.createElement("div");
    row.dataset.trackId = id;
    const top = originTop + layout.tops[index] * scale;
    const height = layout.heights[index] * scale;
    Object.defineProperty(row, "offsetHeight", { value: layout.heights[index] });
    Object.defineProperty(row, "offsetWidth", { value: 200 });
    row.getBoundingClientRect = () =>
      ({ top, bottom: top + height, height, left: 0, right: 200, width: 200 }) as DOMRect;
    document.body.append(row);
    elements.set(id, row);
  });
  return elements;
}

function previews(scale: number, missing: Set<string>) {
  const elements = mountRows(100, scale);
  const anchorId = "c";
  const measuredItems: ReorderPreviewItem[] = ids.map((id) => ({ id, element: elements.get(id)! }));
  const layoutItems: ReorderPreviewItem[] = ids.map((id, index) => ({
    id,
    // Los que "no estan montados" llegan sin elemento.
    element: missing.has(id) ? null : elements.get(id)!,
    offset: layout.tops[index],
    size: layout.heights[index],
  }));
  const pointer = { x: 10, y: 100 + layout.tops[2] * scale + 5 };
  // Dos juegos de elementos: cada vista previa escribe en los suyos.
  const twins = mountRows(100, scale);
  const measured = createReorderPreview({
    items: measuredItems.map((item) => ({ ...item, element: twins.get(item.id)! })),
    axis: "y",
    liftSource: null,
    pointer,
  });
  const fromLayout = createReorderPreview({
    items: layoutItems,
    axis: "y",
    liftSource: null,
    pointer,
    layoutAnchor: { element: elements.get(anchorId)!, offset: layout.topOf(anchorId)! },
  });
  return { measured, fromLayout, elements, twins };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("reorder preview from the layout", () => {
  for (const scale of [1, 1.25]) {
    it(`finds the same drop target with rows missing from the DOM (scale ${scale})`, () => {
      const { measured, fromLayout } = previews(scale, new Set(["a", "f"]));
      for (let y = 60; y < 100 + layout.totalHeight * scale + 40; y += 7) {
        expect(fromLayout.hitTest(0, y), `y=${y}`).toEqual(measured.hitTest(0, y));
        expect(fromLayout.gapAt(0, y), `y=${y}`).toBe(measured.gapAt(0, y));
      }
    });

    it(`shifts the mounted rows exactly as when every row was measured (scale ${scale})`, () => {
      const { measured, fromLayout, elements, twins } = previews(scale, new Set(["a", "f"]));
      const finalOrder = ["b", "c", "a", "d", "f", "e"];
      measured.render(finalOrder, new Set(["a"]));
      fromLayout.render(finalOrder, new Set(["a"]));
      for (const id of ["b", "c", "d", "e"]) {
        expect(elements.get(id)!.style.transform, id).toBe(twins.get(id)!.style.transform);
        expect(elements.get(id)!.className, id).toBe(twins.get(id)!.className);
      }
      // Los no montados no se han tocado.
      expect(elements.get("a")!.style.transform).toBe("");
      expect(elements.get("f")!.style.transform).toBe("");
    });
  }

  it("applies the current shift to a row attached mid-drag", () => {
    const { measured, fromLayout, elements, twins } = previews(1.25, new Set(["f"]));
    const finalOrder = ["f", "a", "b", "c", "d", "e"];
    measured.render(finalOrder, new Set(["f"]));
    fromLayout.render(finalOrder, new Set(["f"]));
    const companion = document.createElement("div");

    fromLayout.attach("f", elements.get("f")!, [companion]);

    expect(elements.get("f")!.style.transform).not.toBe("");
    expect(elements.get("f")!.style.transform).toBe(twins.get("f")!.style.transform);
    expect(elements.get("f")!.className).toBe(twins.get("f")!.className);
    expect(companion.style.transform).toBe(twins.get("f")!.style.transform);

    // Y se limpia con el resto al terminar.
    fromLayout.destroy({ animate: false });
    expect(elements.get("f")!.style.transform).toBe("");
    expect(companion.style.transform).toBe("");
  });
});
