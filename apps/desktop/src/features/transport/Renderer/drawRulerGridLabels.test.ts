import { describe, expect, it } from "vitest";

import { drawRulerGridLabels } from "./drawBackground";
import {
  buildVisibleTimelineGrid,
  screenXToSeconds,
  secondsToScreenX,
  type TimelineGrid,
} from "../timeline/timelineMath";

/**
 * Equivalencia del paso 06 de `docs/plans/ui-performance`.
 *
 * `drawRulerGridLabels` dejó de recorrer TODAS las marcas del proyecto en cada
 * pintado: ahora acota el tramo visible con búsqueda binaria y cachea por
 * identidad de rejilla la lista de candidatas y el hueco mínimo entre ellas.
 *
 * Ese cambio sólo vale si pinta **exactamente las mismas etiquetas en los
 * mismos sitios**. Aquí el oráculo es el algoritmo ANTERIOR, reimplementado
 * literalmente, y se comparan las dos salidas en varios zooms y posiciones de
 * cámara — incluidos los bordes del proyecto, que es donde una ventana mal
 * acotada se delata.
 */

// Espeja `MIN_LABEL_WIDTH_PX` de drawBackground.ts. Es la única constante que
// el oráculo necesita, porque decide CUÁNTAS etiquetas se pintan. Las `y` no se
// duplican aquí: son constantes de maquetación que este cambio no toca, y se
// comprueban aparte (ver el último test).
const MIN_LABEL_WIDTH_PX = 112;

type TextCall = { text: string; x: number; y: number };

/** Lo que este cambio sí puede alterar: qué etiquetas y dónde en horizontal. */
function positions(calls: TextCall[]) {
  return calls.map((call) => `${call.text}@${call.x}`);
}

function createRecordingContext() {
  const texts: TextCall[] = [];
  return {
    texts,
    ctx: {
      fillText: (text: string, x: number, y: number) => {
        texts.push({ text, x, y });
      },
      measureText: (text: string) => ({ width: text.length * 7 }),
      font: "",
      fillStyle: "",
      textAlign: "",
      textBaseline: "",
    } as unknown as CanvasRenderingContext2D,
  };
}

// ── Oráculo: el algoritmo tal y como estaba antes del paso 06 ──────────────

function formatRulerMusicalPosition(barNumber: number, beatInBar: number) {
  return `${barNumber}.${beatInBar}.00`;
}

function formatRulerTimecode(seconds: number) {
  const safeSeconds = Math.max(0, seconds);
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds - minutes * 60;
  return `${minutes}:${remainder.toFixed(3).padStart(6, "0")}`;
}

function legacyPrimaryMarkers(grid: TimelineGrid) {
  if (grid.showBeatLabels) return grid.markers;
  return grid.markers.filter(
    (marker) =>
      marker.isBarStart && (marker.barNumber - 1) % grid.barLabelStep === 0,
  );
}

function legacyOrdinal(
  marker: TimelineGrid["markers"][number],
  grid: TimelineGrid,
) {
  if (grid.showBeatLabels) {
    return (marker.barNumber - 1) * grid.beatsPerBar + (marker.beatInBar - 1);
  }
  return Math.floor((marker.barNumber - 1) / grid.barLabelStep);
}

function legacyDrawRulerGridLabels(
  grid: TimelineGrid,
  width: number,
  cameraX: number,
  pixelsPerSecond: number,
): TextCall[] {
  const visibleStartSeconds = screenXToSeconds(0, cameraX, pixelsPerSecond);
  const visibleEndSeconds = screenXToSeconds(width, cameraX, pixelsPerSecond);
  const primaryMarkers = legacyPrimaryMarkers(grid);

  let minimumPrimaryIntervalPx = Number.POSITIVE_INFINITY;
  for (let index = 1; index < primaryMarkers.length; index += 1) {
    const intervalPx =
      (primaryMarkers[index].seconds - primaryMarkers[index - 1].seconds) *
      pixelsPerSecond;
    if (intervalPx > 0) {
      minimumPrimaryIntervalPx = Math.min(minimumPrimaryIntervalPx, intervalPx);
    }
  }
  let labelSkipDivisor = 1;
  while (
    Number.isFinite(minimumPrimaryIntervalPx) &&
    minimumPrimaryIntervalPx * labelSkipDivisor < MIN_LABEL_WIDTH_PX
  ) {
    labelSkipDivisor *= 2;
  }

  const texts: TextCall[] = [];
  for (const marker of primaryMarkers) {
    if (legacyOrdinal(marker, grid) % labelSkipDivisor !== 0) continue;
    const markerX = secondsToScreenX(marker.seconds, cameraX, pixelsPerSecond);
    if (
      marker.seconds < visibleStartSeconds - 2 ||
      marker.seconds > visibleEndSeconds + 2
    ) {
      continue;
    }
    const x = Math.round(markerX) + 4;
    texts.push({
      text: formatRulerMusicalPosition(marker.barNumber, marker.beatInBar),
      x,
      y: 0,
    });
    if (marker.isBarStart) {
      texts.push({
        text: formatRulerTimecode(marker.seconds),
        x,
        y: 1,
      });
    }
  }
  return texts;
}

// ── Rejillas de prueba ─────────────────────────────────────────────────────

function buildGrid(pixelsPerSecond: number, songs = 6, songSeconds = 240) {
  const regions = Array.from({ length: songs }, (_, index) => ({
    startSeconds: index * songSeconds,
    endSeconds: (index + 1) * songSeconds,
    bpm: index % 2 === 0 ? 120 : 90,
    timeSignature: index % 3 === 0 ? "4/4" : "3/4",
  }));
  const durationSeconds = songs * songSeconds;
  return buildVisibleTimelineGrid({
    durationSeconds,
    bpm: 120,
    timeSignature: "4/4",
    regions,
    zoomLevel: pixelsPerSecond / 18,
    pixelsPerSecond,
    viewportStartSeconds: 0,
    viewportEndSeconds: durationSeconds,
  });
}

describe("drawRulerGridLabels tras acotar por viewport", () => {
  const WIDTH = 1400;

  it.each([4.5, 18, 60, 180, 600])(
    "pinta las mismas etiquetas que el algoritmo anterior a %s px/s",
    (pixelsPerSecond) => {
      const grid = buildGrid(pixelsPerSecond);
      const durationSeconds = 6 * 240;
      const maxCameraX = durationSeconds * pixelsPerSecond;

      // Incluye los dos bordes del proyecto y algo antes del cero: ahí es donde
      // una ventana mal acotada se come la primera o la última etiqueta.
      const cameras = [
        -200,
        0,
        maxCameraX * 0.25,
        maxCameraX * 0.5,
        maxCameraX * 0.9,
        Math.max(0, maxCameraX - WIDTH),
        maxCameraX,
      ];

      for (const cameraX of cameras) {
        const { texts, ctx } = createRecordingContext();
        drawRulerGridLabels(ctx, grid, WIDTH, cameraX, pixelsPerSecond);
        const expected = legacyDrawRulerGridLabels(
          grid,
          WIDTH,
          cameraX,
          pixelsPerSecond,
        );
        expect(
          positions(texts),
          `cameraX=${cameraX} pps=${pixelsPerSecond}`,
        ).toEqual(positions(expected));
      }
    },
  );

  it("sigue pintando etiquetas (el test no pasa por estar todo vacío)", () => {
    const grid = buildGrid(60);
    const { texts, ctx } = createRecordingContext();
    drawRulerGridLabels(ctx, grid, WIDTH, 0, 60);
    expect(texts.length).toBeGreaterThan(0);
  });

  it("mantiene las dos líneas: compás arriba, timecode debajo", () => {
    const grid = buildGrid(60);
    const { texts, ctx } = createRecordingContext();
    drawRulerGridLabels(ctx, grid, WIDTH, 0, 60);

    const musical = texts.find((call) => /^\d+\.\d+\.00$/.test(call.text));
    const timecode = texts.find((call) => call.text.includes(":"));
    expect(musical).toBeDefined();
    expect(timecode).toBeDefined();
    expect(musical!.y).toBeLessThan(timecode!.y);
    // Ambas líneas comparten x cuando corresponden a la misma marca.
    expect(musical!.x).toBe(timecode!.x);
  });

  it("no arrastra la caché de una rejilla a otra", () => {
    // La lista de candidatas se cachea por identidad de rejilla. Dos rejillas
    // distintas seguidas tienen que dar resultados distintos, no el primero
    // repetido.
    const dense = buildGrid(600);
    const sparse = buildGrid(4.5);

    const first = createRecordingContext();
    drawRulerGridLabels(first.ctx, dense, WIDTH, 0, 600);
    const second = createRecordingContext();
    drawRulerGridLabels(second.ctx, sparse, WIDTH, 0, 4.5);
    const third = createRecordingContext();
    drawRulerGridLabels(third.ctx, dense, WIDTH, 0, 600);

    expect(positions(second.texts)).not.toEqual(positions(first.texts));
    expect(positions(third.texts)).toEqual(positions(first.texts));
  });
});
