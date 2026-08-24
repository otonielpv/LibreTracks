import { describe, expect, it } from "vitest";

import { buildVisibleTimelineGrid, firstIndexAtOrAfter } from "./timelineMath";

describe("firstIndexAtOrAfter", () => {
  it("encuentra el primer índice >= target", () => {
    const values = [0, 1, 2, 5, 5, 9];
    expect(firstIndexAtOrAfter(values, -1)).toBe(0);
    expect(firstIndexAtOrAfter(values, 0)).toBe(0);
    expect(firstIndexAtOrAfter(values, 3)).toBe(3);
    // Con valores repetidos devuelve el PRIMERO, no uno cualquiera.
    expect(firstIndexAtOrAfter(values, 5)).toBe(3);
    expect(firstIndexAtOrAfter(values, 9)).toBe(5);
    expect(firstIndexAtOrAfter(values, 10)).toBe(6);
    expect(firstIndexAtOrAfter([], 1)).toBe(0);
  });

  it("coincide con el barrido lineal para cualquier entrada", () => {
    const values = Array.from({ length: 200 }, (_, index) => index * 0.5);
    for (const target of [-5, 0, 0.25, 50, 99.5, 100, 1000]) {
      const linear = values.findIndex((value) => value >= target);
      expect(firstIndexAtOrAfter(values, target)).toBe(
        linear === -1 ? values.length : linear,
      );
    }
  });
});

describe("la rejilla sale ordenada", () => {
  // Premisa de la que depende la búsqueda binaria del dibujo. Si algún día
  // `buildVisibleTimelineGrid` emitiera fuera de orden, el timeline dejaría de
  // pintar parte de la rejilla en silencio.
  it("emite bars, beats y markers en orden ascendente", () => {
    const regions = [
      { startSeconds: 0, endSeconds: 60, bpm: 120, timeSignature: "4/4" },
      // A propósito desordenada en la entrada y con otro compás.
      { startSeconds: 120, endSeconds: 180, bpm: 90, timeSignature: "3/4" },
      { startSeconds: 60, endSeconds: 120, bpm: 140, timeSignature: "4/4" },
    ];
    const grid = buildVisibleTimelineGrid({
      durationSeconds: 180,
      bpm: 120,
      timeSignature: "4/4",
      regions,
      zoomLevel: 1,
      pixelsPerSecond: 18,
      viewportStartSeconds: 0,
      viewportEndSeconds: 180,
    });

    const isAscending = (values: number[]) =>
      values.every((value, index) => index === 0 || values[index - 1] <= value);

    expect(grid.bars.length).toBeGreaterThan(0);
    expect(isAscending(grid.bars)).toBe(true);
    expect(isAscending(grid.beats)).toBe(true);
    expect(isAscending(grid.markers.map((marker) => marker.seconds))).toBe(true);
  });
});
