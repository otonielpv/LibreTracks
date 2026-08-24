import { describe, expect, it } from "vitest";

import { drawWaveformSketch } from "./WaveformTileCache";
import type { ClipSummary, WaveformSummaryDto } from "../desktopApi";

/**
 * El boceto de baja resolución es lo que se ve mientras el tile de verdad está
 * en la cola. La primera versión **muestreaba** un pico por bucket de salida en
 * vez de agregar el máximo del tramo, y con miles de buckets de LOD por medio
 * los puntos caían donde caían: donde uno aterrizaba en un cruce por cero la
 * envolvente se estrangulaba, y el clip se dibujaba como una fila de lentes.
 *
 * No lo detectó ningún test —sólo se vio a ojo, en una captura— así que aquí
 * está el que sí lo detecta.
 */

/** Onda con picos ALTOS y ceros intercalados, que es lo que rompía el muestreo. */
function combWaveform(): WaveformSummaryDto {
  const maxPeaks: number[] = [];
  const minPeaks: number[] = [];
  for (let index = 0; index < 512; index += 1) {
    const loud = index % 2 === 0;
    maxPeaks.push(loud ? 0.9 : 0);
    minPeaks.push(loud ? -0.9 : 0);
  }
  return {
    waveformKey: "audio/comb.wav",
    version: 1,
    durationSeconds: 10,
    sampleRate: 48000,
    lods: [{ resolutionFrames: 256, bucketCount: 512, minPeaks, maxPeaks }],
  } as unknown as WaveformSummaryDto;
}

function clip(): ClipSummary {
  return {
    id: "clip-1",
    trackId: "track-1",
    filePath: "audio/comb.wav",
    waveformKey: "audio/comb.wav",
    timelineStartSeconds: 0,
    sourceStartSeconds: 0,
    sourceWindowDurationSeconds: 10,
    sourceDurationSeconds: 10,
    durationSeconds: 10,
    gain: 1,
  } as unknown as ClipSummary;
}

/** Registra los vértices del contorno para poder medirlo. */
function createTracingContext() {
  const points: Array<{ x: number; y: number }> = [];
  return {
    points,
    ctx: {
      save() {},
      restore() {},
      beginPath() {},
      closePath() {},
      fill() {},
      fillRect() {},
      moveTo(x: number, y: number) {
        points.push({ x, y });
      },
      lineTo(x: number, y: number) {
        points.push({ x, y });
      },
      set fillStyle(_value: string) {},
    } as unknown as CanvasRenderingContext2D,
  };
}

const RECT = {
  fromRatio: 0,
  toRatio: 1,
  left: 0,
  width: 400,
  top: 0,
  height: 100,
};

describe("drawWaveformSketch", () => {
  it("agrega el máximo del tramo en vez de muestrear un punto", () => {
    const { points, ctx } = createTracingContext();
    expect(drawWaveformSketch(ctx, clip(), combWaveform(), RECT)).toBe(true);

    const centerY = RECT.top + RECT.height / 2;
    // Con una onda "peine" (picos altos y ceros alternados), agregar da SIEMPRE
    // el pico alto. Muestrear daría cero en la mitad de los buckets, que es lo
    // que dibujaba las lentes.
    const collapsed = points.filter(
      (point) => Math.abs(point.y - centerY) < 1,
    ).length;
    expect(collapsed).toBe(0);

    // Y la amplitud es la del pico real, no una fracción.
    const amplitude = Math.max(
      ...points.map((point) => Math.abs(point.y - centerY)),
    );
    expect(amplitude).toBeCloseTo(0.9 * RECT.height * 0.42, 5);
  });

  it("no fuerza hacia cero una onda con desplazamiento DC", () => {
    const waveform = combWaveform();
    const lod = waveform.lods[0];
    lod.minPeaks = lod.minPeaks!.map(() => 0.2);
    lod.maxPeaks = lod.maxPeaks!.map(() => 0.6);
    const { points, ctx } = createTracingContext();

    drawWaveformSketch(ctx, clip(), waveform, RECT);

    const centerY = RECT.top + RECT.height / 2;
    expect(points.every((point) => point.y < centerY)).toBe(true);
  });

  it("se queda dentro del rectángulo que se le da", () => {
    const { points, ctx } = createTracingContext();
    drawWaveformSketch(ctx, clip(), combWaveform(), {
      ...RECT,
      fromRatio: 0.5,
      toRatio: 0.75,
      left: 120,
      width: 60,
    });

    // Sin esto, el boceto de un tile que falta se pintaría sobre los tiles
    // vecinos que sí estaban rasterizados: el parpadeo que se vio a ojo.
    const xs = points.map((point) => point.x);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(120);
    expect(Math.max(...xs)).toBeLessThanOrEqual(180);
  });

  it("mantiene dos canales separados mientras llega el tile estéreo", () => {
    const waveform = combWaveform();
    const lod = waveform.lods[0];
    lod.minPeaksRight = lod.minPeaks!.map((peak) => peak * 0.5);
    lod.maxPeaksRight = lod.maxPeaks!.map((peak) => peak * 0.5);
    const { points, ctx } = createTracingContext();

    drawWaveformSketch(ctx, clip(), waveform, RECT);

    // Dos contornos de 64 buckets por arriba y por abajo. La versión anterior
    // dibujaba siempre un único canal a altura completa y saltaba al llegar el
    // tile definitivo.
    expect(points).toHaveLength(64 * 2 * 2);
    expect(points.slice(0, 64 * 2).every((point) => point.y < 50)).toBe(true);
    expect(points.slice(64 * 2).every((point) => point.y > 50)).toBe(true);
  });

  it("no dibuja nada si no hay sitio o no hay onda", () => {
    const narrow = createTracingContext();
    expect(
      drawWaveformSketch(narrow.ctx, clip(), combWaveform(), {
        ...RECT,
        width: 1,
      }),
    ).toBe(false);
    expect(narrow.points).toHaveLength(0);
  });
});
