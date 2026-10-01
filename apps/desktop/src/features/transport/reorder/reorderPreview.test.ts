import { describe, expect, it } from "vitest";

import { reflowOffsets } from "./reorderPreview";

describe("reflowOffsets", () => {
  // Filas de alturas distintas pegadas: a 0-40, b 40-100, c 100-120.
  const items = [
    { id: "a", start: 0, size: 40 },
    { id: "b", start: 40, size: 60 },
    { id: "c", start: 100, size: 20 },
  ];

  it("stacks the final order from the first slot, honouring each size", () => {
    const offsets = reflowOffsets(items, ["c", "a", "b"]);
    expect(offsets.get("c")).toBe(-100);
    expect(offsets.get("a")).toBe(20);
    expect(offsets.get("b")).toBe(20);
  });

  it("keeps the list's spacing between items", () => {
    const spaced = [
      { id: "a", start: 0, size: 100 },
      { id: "b", start: 110, size: 100 },
    ];
    const offsets = reflowOffsets(spaced, ["b", "a"]);
    expect(offsets.get("b")).toBe(-110);
    expect(offsets.get("a")).toBe(110);
  });

  it("leaves out what the final order no longer shows", () => {
    // b cae dentro de una carpeta plegada: c sube a ocupar su sitio.
    const offsets = reflowOffsets(items, ["a", "c"]);
    expect(offsets.has("b")).toBe(false);
    expect(offsets.get("c")).toBe(-60);
  });
});
