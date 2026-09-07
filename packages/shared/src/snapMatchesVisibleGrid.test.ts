import { describe, expect, it } from "vitest";
import {
  BASE_PIXELS_PER_SECOND,
  buildVisibleTimelineGrid,
  snapToTimelineGrid,
  timelineGridResolution,
} from "./timelineMath";

/**
 * El sintoma que motiva estas pruebas: "dejas pulsado en un sitio y la marca
 * aparece en otro". No era deriva del dedo — era que el snap ajustaba SIEMPRE
 * al beat mas cercano mientras la rejilla, alejada, solo dibujaba compases. La
 * marca caia en una linea invisible. Aqui se fija la invariante: el snap nunca
 * puede usar una unidad que no se este dibujando.
 */
const BPM = 120;
const SIG = "4/4";
const BEAT = 60 / BPM; // 0.5 s
const BAR = BEAT * 4; // 2 s

function gridAt(pixelsPerSecond: number) {
  return buildVisibleTimelineGrid({
    durationSeconds: 240,
    bpm: BPM,
    timeSignature: SIG,
    pixelsPerSecond,
    zoomLevel: pixelsPerSecond / BASE_PIXELS_PER_SECOND,
    viewportStartSeconds: 0,
    viewportEndSeconds: 240,
    regions: [],
  });
}

describe("el snap respeta la rejilla visible", () => {
  it("ajusta al beat cuando las lineas de beat se dibujan", () => {
    const pixelsPerSecond = 126; // zoom por defecto: un beat mide 63 px
    expect(gridAt(pixelsPerSecond).showBeatGridLines).toBe(true);
    // 1.4 s cae entre beats; el mas cercano es 1.5 s.
    expect(
      snapToTimelineGrid(1.4, BPM, SIG, 7, pixelsPerSecond),
    ).toBeCloseTo(1.5, 6);
  });

  it("ajusta al compas cuando el beat es demasiado estrecho para dibujarse", () => {
    // Caso real en movil: la cancion entera cabe en pantalla. Un beat mide
    // 2,5 px, muy por debajo del minimo, asi que solo hay compases visibles.
    const pixelsPerSecond = 5;
    expect(gridAt(pixelsPerSecond).showBeatGridLines).toBe(false);
    // Antes esto devolvia 1.5 (un beat que NO estaba pintado).
    expect(snapToTimelineGrid(1.4, BPM, SIG, 0.28, pixelsPerSecond)).toBeCloseTo(
      2,
      6,
    );
  });

  it("nunca ajusta a una unidad que no se esta dibujando", () => {
    for (const pixelsPerSecond of [3, 5, 12, 31, 32, 60, 126, 400]) {
      const grid = gridAt(pixelsPerSecond);
      const unit = grid.showBeatGridLines ? BEAT : BAR;
      expect(timelineGridResolution(BEAT, pixelsPerSecond)).toBe(
        grid.showBeatGridLines ? "beat" : "bar",
      );
      for (const seconds of [0.3, 1.4, 7.9, 33.2]) {
        const snapped = snapToTimelineGrid(
          seconds,
          BPM,
          SIG,
          pixelsPerSecond / BASE_PIXELS_PER_SECOND,
          pixelsPerSecond,
        );
        // Cae exactamente sobre una linea de la unidad visible...
        expect(Math.abs(snapped / unit - Math.round(snapped / unit))).toBeLessThan(1e-6);
        // ...y nunca se va mas de media unidad del punto pedido.
        expect(Math.abs(snapped - seconds)).toBeLessThanOrEqual(unit / 2 + 1e-6);
      }
    }
  });

  it("mantiene el beat si no le pasan una escala utilizable", () => {
    // Llamadas antiguas sin pixeles por segundo fiables: comportamiento previo.
    expect(snapToTimelineGrid(1.4, BPM, SIG, 7, 0)).toBeCloseTo(1.5, 6);
    expect(snapToTimelineGrid(1.4, BPM, SIG, 7, Number.NaN)).toBeCloseTo(1.5, 6);
  });
});
