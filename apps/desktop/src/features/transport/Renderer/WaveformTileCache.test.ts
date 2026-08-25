import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ClipSummary, WaveformSummaryDto } from "../desktopApi";
import {
  getWaveformRenderPixelsPerSecond,
  WaveformTileCache,
  decodeFloat32Peaks,
  selectWaveformLod,
  tileHeightForLane,
  tileNamespace,
} from "./WaveformTileCache";

function encodeFloat32Peaks(values: number[]) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    view.setFloat32(index * 4, value, true);
  });

  return btoa(String.fromCharCode(...bytes));
}

function buildWaveform(
  overrides?: Partial<WaveformSummaryDto>,
): WaveformSummaryDto {
  return {
    waveformKey: "audio/test.wav",
    version: 1,
    durationSeconds: 8,
    sampleRate: 48_000,
    lods: [
      {
        resolutionFrames: 256,
        bucketCount: 8,
        minPeaks: [-0.8, -0.7, -0.6, -0.5, -0.4, -0.3, -0.2, -0.1],
        maxPeaks: [0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1],
      },
      {
        resolutionFrames: 2048,
        bucketCount: 4,
        minPeaks: [-0.9, -0.6, -0.3, -0.2],
        maxPeaks: [0.9, 0.6, 0.3, 0.2],
      },
    ],
    ...overrides,
  };
}

function buildClip(overrides?: Partial<ClipSummary>): ClipSummary {
  return {
    id: "clip-1",
    trackId: "track-1",
    trackName: "Track 1",
    filePath: "audio/test.wav",
    waveformKey: "audio/test.wav",
    isMissing: false,
    timelineStartSeconds: 0,
    sourceStartSeconds: 0,
    sourceWindowDurationSeconds: 4,
    sourceDurationSeconds: 8,
    durationSeconds: 4,
    gain: 1,
    ...overrides,
  };
}

/** Clave de cache de un clip, con los valores por defecto del test. */
function namespaceOf(
  clip: ReturnType<typeof buildClip>,
  waveform: ReturnType<typeof buildWaveform>,
  pixelsPerSecond = 120,
  laneHeightPx = 96,
) {
  return tileNamespace({
    clip,
    waveform,
    pixelsPerSecond,
    clipPixelWidth: Math.max(1, clip.durationSeconds * pixelsPerSecond),
    tileIndex: 0,
    laneHeightPx,
    priority: 0,
  });
}

describe("WaveformTileCache", () => {
  it("decodes float32 peaks from base64 payloads", () => {
    const decoded = decodeFloat32Peaks(
      encodeFloat32Peaks([-0.5, 0.25, 0.75]),
      3,
    );

    expect(Array.from(decoded)).toHaveLength(3);
    expect(decoded[0]).toBeCloseTo(-0.5);
    expect(decoded[1]).toBeCloseTo(0.25);
    expect(decoded[2]).toBeCloseTo(0.75);
  });

  it("selects the highest-detail lod that does not exceed frames per pixel", () => {
    const waveform = buildWaveform();

    const highZoomLod = selectWaveformLod(waveform, 200);
    const lowZoomLod = selectWaveformLod(waveform, 10);

    expect(highZoomLod?.resolutionFrames).toBe(256);
    expect(lowZoomLod?.resolutionFrames).toBe(2048);
  });

  it("decodes right-channel peaks for stereo waveforms", () => {
    const waveform = buildWaveform({
      lods: [
        {
          resolutionFrames: 256,
          bucketCount: 3,
          minPeaksBase64: encodeFloat32Peaks([-0.8, -0.7, -0.6]),
          maxPeaksBase64: encodeFloat32Peaks([0.8, 0.7, 0.6]),
          minPeaksRightBase64: encodeFloat32Peaks([-0.2, -0.3, -0.4]),
          maxPeaksRightBase64: encodeFloat32Peaks([0.2, 0.3, 0.4]),
        },
      ],
    });

    const lod = selectWaveformLod(waveform, 200);

    expect(Array.from(lod?.maxPeaksRight ?? [])).toHaveLength(3);
    expect(lod?.maxPeaksRight[2]).toBeCloseTo(0.4);
    expect(lod?.minPeaksRight[0]).toBeCloseTo(-0.2);
  });

  it("builds different namespaces when waveform identity inputs change", () => {
    const baseNamespace = namespaceOf(buildClip(), buildWaveform());
    const durationNamespace = namespaceOf(
      buildClip({ sourceDurationSeconds: 9 }),
      buildWaveform(),
    );
    const waveformNamespace = namespaceOf(
      buildClip({ waveformKey: "audio/other.wav" }),
      buildWaveform({ waveformKey: "audio/other.wav" }),
    );

    expect(durationNamespace).not.toBe(baseNamespace);
    expect(waveformNamespace).not.toBe(baseNamespace);
  });

  // Los resumenes parciales de `waveform:progress` llegan varias veces con la
  // MISMA clave y version, cada uno con mas picos. Si no entraran en el
  // namespace, los tiles del primero se reutilizarian para todos los demas y la
  // onda dejaria de crecer en pantalla.
  it("builds different namespaces as a partial waveform grows", () => {
    const clip = buildClip();
    const quarter = namespaceOf(clip, buildWaveform({ analyzedSeconds: 2 }));
    const half = namespaceOf(clip, buildWaveform({ analyzedSeconds: 4 }));
    const complete = namespaceOf(clip, buildWaveform());

    expect(half).not.toBe(quarter);
    expect(complete).not.toBe(half);
    // Y una vez completo la clave es estable: nada obliga a re-rasterizar.
    expect(namespaceOf(clip, buildWaveform())).toBe(complete);
  });

  it("builds different namespaces for different lane heights", () => {
    // El alto entra en la clave desde el paso 04: un tile rasterizado para un
    // carril de 32 px no sirve para uno de 128, y reutilizarlo lo estiraria.
    const clip = buildClip();
    const waveform = buildWaveform();
    expect(namespaceOf(clip, waveform, 120, 30)).not.toBe(
      namespaceOf(clip, waveform, 120, 120),
    );
    // Pero dentro del mismo escalon SI se reutiliza, o arrastrar el borde de
    // una pista invalidaria la cache pixel a pixel.
    expect(namespaceOf(clip, waveform, 120, 30)).toBe(
      namespaceOf(clip, waveform, 120, 31),
    );
  });

  it("builds different namespaces for mono and stereo waveform tiles", () => {
    const baseClip = buildClip();
    const monoNamespace = namespaceOf(baseClip, buildWaveform(), 120);
    const stereoNamespace = namespaceOf(
      baseClip,
      buildWaveform({
        lods: [
          {
            resolutionFrames: 256,
            bucketCount: 2,
            minPeaks: [-0.8, -0.6],
            maxPeaks: [0.8, 0.6],
            minPeaksRight: [-0.2, -0.4],
            maxPeaksRight: [0.2, 0.4],
          },
        ],
      }),
      120,
    );

    expect(stereoNamespace).not.toBe(monoNamespace);
  });

  it("quantizes nearby zoom levels to the same waveform render scale", () => {
    expect(getWaveformRenderPixelsPerSecond(50)).toBe(
      getWaveformRenderPixelsPerSecond(52),
    );
    expect(getWaveformRenderPixelsPerSecond(72)).toBe(
      getWaveformRenderPixelsPerSecond(75),
    );
  });

  it("limita el desenfoque de cuantización de zoom a aproximadamente 12 %", () => {
    for (let pixelsPerSecond = 18; pixelsPerSecond <= 1152; pixelsPerSecond *= 1.03) {
      const render = getWaveformRenderPixelsPerSecond(pixelsPerSecond);
      expect(Math.max(render / pixelsPerSecond, pixelsPerSecond / render)).toBeLessThan(1.12);
    }
  });

  it("avanza exactamente al vecino superior sin volver por redondeo flotante", () => {
    for (const pixelsPerSecond of [20, 50, 120, 200, 600, 1100]) {
      const level = getWaveformRenderPixelsPerSecond(pixelsPerSecond);
      expect(getWaveformRenderPixelsPerSecond(level * 1.25)).toBeCloseTo(
        level * 1.25,
        8,
      );
    }
  });
});

/**
 * Paso 04 de docs/plans/ui-performance: la rasterización sale del frame.
 *
 * Medido antes del cambio: al cruzar un paso de zoom de 1,5x cambian de golpe
 * TODOS los namespaces visibles, y los tiles se rasterizaban dentro del
 * pintado. Picos de frame de 27,7 / 41,7 / 55,5 / 69,4 / 76,5 ms contra un
 * presupuesto de 6,9 ms (144 Hz), y un pico de caché de 146 MB.
 */
/**
 * jsdom no implementa canvas: `getContext("2d")` devuelve null, asi que la
 * rasterizacion no llegaria a ocurrir y los tests medirian una cola que nunca
 * se vacia. Un `OffscreenCanvas` de mentira con lo justo que usa
 * `renderWaveformTile` es suficiente — aqui no se comprueban pixeles, se
 * comprueba CUANDO y CUANTO se rasteriza.
 */
function installFakeCanvas() {
  const context = {
    clearRect() {},
    fillRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    fill() {},
    setTransform() {},
    set fillStyle(_value: string) {},
    set lineJoin(_value: string) {},
    set lineCap(_value: string) {},
  };
  class FakeOffscreenCanvas {
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext() {
      return context;
    }
  }
  (globalThis as Record<string, unknown>).OffscreenCanvas = FakeOffscreenCanvas;
}

type PathPoint = { x: number; y: number };

function installRecordingCanvas(paths: PathPoint[][]) {
  let currentPath: PathPoint[] | null = null;
  const context = {
    clearRect() {},
    fillRect() {},
    beginPath() {
      currentPath = [];
      paths.push(currentPath);
    },
    moveTo(x: number, y: number) {
      currentPath?.push({ x, y });
    },
    lineTo(x: number, y: number) {
      currentPath?.push({ x, y });
    },
    closePath() {
      if (currentPath?.length) {
        currentPath.push(currentPath[0]);
      }
    },
    fill() {},
    setTransform() {},
    set fillStyle(_value: string) {},
    set lineJoin(_value: string) {},
    set lineCap(_value: string) {},
  };
  class RecordingOffscreenCanvas {
    constructor(
      public width: number,
      public height: number,
    ) {}
    getContext() {
      return context;
    }
  }
  (globalThis as Record<string, unknown>).OffscreenCanvas =
    RecordingOffscreenCanvas;
}

function removeFakeCanvas() {
  delete (globalThis as Record<string, unknown>).OffscreenCanvas;
}

describe("cola de rasterización con presupuesto", () => {
  beforeEach(installFakeCanvas);
  afterEach(removeFakeCanvas);

  function request(overrides: Record<string, unknown> = {}) {
    return {
      clip: buildClip(),
      waveform: buildWaveform(),
      pixelsPerSecond: 120,
      clipPixelWidth: 4096,
      tileIndex: 0,
      laneHeightPx: 96,
      priority: 0,
      ...overrides,
    } as Parameters<WaveformTileCache["getTile"]>[0];
  }

  it("NO rasteriza dentro de getTile: devuelve null y encola", () => {
    const cache = new WaveformTileCache();

    // Éste es el criterio del paso. Antes, este mismo getTile rasterizaba el
    // tile entero antes de devolverlo.
    expect(cache.getTile(request())).toBeNull();
    expect(cache.hasPendingTiles()).toBe(true);
    // Y no ocupa memoria hasta que se rasteriza de verdad.
    expect(cache.stats().entries).toBe(0);
  });

  it("sirve el tile ya rasterizado sin volver a encolar", () => {
    const cache = new WaveformTileCache();
    cache.getTile(request());
    expect(cache.drainPendingTiles(1000)).toBe(1);
    expect(cache.hasPendingTiles()).toBe(false);

    expect(cache.getTile(request())).not.toBeNull();
    expect(cache.hasPendingTiles()).toBe(false);
  });

  it("dibuja transitorios densos por intervalos sin diagonales entre buckets", () => {
    const paths: PathPoint[][] = [];
    installRecordingCanvas(paths);
    const cache = new WaveformTileCache();
    const peaks = [0, 0, 1, 0, 0, 0, 0, 0];
    const denseWaveform = buildWaveform({
      lods: [
        {
          resolutionFrames: 256,
          bucketCount: peaks.length,
          minPeaks: peaks.map((value) => -value),
          maxPeaks: peaks,
        },
      ],
    });

    cache.getTile(
      request({
        clip: buildClip({
          durationSeconds: 8,
          sourceWindowDurationSeconds: 8,
        }),
        waveform: denseWaveform,
        clipPixelWidth: 32,
      }),
    );
    expect(cache.drainPendingTiles(1000)).toBe(1);

    const waveformPath = paths.at(-1) ?? [];
    expect(waveformPath.length).toBeGreaterThan(2);
    for (let index = 1; index < waveformPath.length; index += 1) {
      const previous = waveformPath[index - 1];
      const current = waveformPath[index];
      const changesX = Math.abs(current.x - previous.x) > 1e-9;
      const changesY = Math.abs(current.y - previous.y) > 1e-9;
      expect(changesX && changesY).toBe(false);
    }
  });

  it("vacía la cola al empezar un pintado, para no rasterizar lo ya invisible", () => {
    // Durante un zoom continuo se piden tiles de niveles que se abandonan al
    // frame siguiente. Si la cola no se vaciara, se rasterizarían igual.
    const cache = new WaveformTileCache();
    cache.getTile(request({ tileIndex: 0 }));
    cache.getTile(request({ tileIndex: 1 }));
    expect(cache.hasPendingTiles()).toBe(true);

    cache.beginPaint();
    expect(cache.hasPendingTiles()).toBe(false);
    expect(cache.drainPendingTiles(1000)).toBe(0);
  });

  it("respeta el presupuesto en vez de vaciar la cola de golpe", () => {
    const cache = new WaveformTileCache();
    for (let index = 0; index < 40; index += 1) {
      cache.getTile(request({ tileIndex: index, clipPixelWidth: 64 * 1024 }));
    }

    // Presupuesto cero: rasteriza UNO (nunca se queda parado del todo) y deja
    // el resto para el frame siguiente.
    expect(cache.drainPendingTiles(0)).toBe(1);
    expect(cache.hasPendingTiles()).toBe(true);
  });

  it("rasteriza antes lo que está más cerca del centro del viewport", () => {
    const cache = new WaveformTileCache();
    cache.getTile(request({ tileIndex: 0, priority: 900 }));
    cache.getTile(request({ tileIndex: 1, priority: 10 }));

    cache.drainPendingTiles(0);
    expect(cache.getTile(request({ tileIndex: 1, priority: 10 }))).not.toBeNull();
    expect(cache.getTile(request({ tileIndex: 0, priority: 900 }))).toBeNull();
  });

  it("recorta un tile del nivel vecino mientras llega el zoom nuevo", () => {
    const cache = new WaveformTileCache();
    const oldPixelsPerSecond = getWaveformRenderPixelsPerSecond(120);
    const targetPixelsPerSecond = oldPixelsPerSecond * 1.5;
    const durationSeconds = 20;
    const zoomClip = buildClip({
      durationSeconds,
      sourceDurationSeconds: durationSeconds,
      sourceWindowDurationSeconds: durationSeconds,
    });
    const oldRequest = request({
      clip: zoomClip,
      pixelsPerSecond: oldPixelsPerSecond,
      clipPixelWidth: durationSeconds * oldPixelsPerSecond,
      tileIndex: 0,
    });
    cache.getTile(oldRequest);
    cache.drainPendingTiles(1000);

    const targetRequest = request({
      clip: zoomClip,
      pixelsPerSecond: targetPixelsPerSecond,
      clipPixelWidth: durationSeconds * targetPixelsPerSecond,
      tileIndex: 0,
    });
    expect(cache.getTile(targetRequest)).toBeNull();

    const slices = cache.getFallbackTileSlices(targetRequest);
    expect(slices).not.toBeNull();
    expect(
      slices?.reduce((total, slice) => total + slice.targetWidth, 0),
    ).toBeCloseTo(1024, 5);
  });

  it("no mezcla como fallback tiles pertenecientes a otro clip", () => {
    const cache = new WaveformTileCache();
    const oldPixelsPerSecond = getWaveformRenderPixelsPerSecond(120);
    const oldRequest = request({
      pixelsPerSecond: oldPixelsPerSecond,
      clipPixelWidth: 4096,
    });
    cache.getTile(oldRequest);
    cache.drainPendingTiles(1000);

    const otherClipRequest = request({
      clip: buildClip({ waveformKey: "audio/other.wav" }),
      waveform: buildWaveform({ waveformKey: "audio/other.wav" }),
      pixelsPerSecond: oldPixelsPerSecond * 1.5,
      clipPixelWidth: 4096 * 1.5,
    });
    expect(cache.getFallbackTileSlices(otherClipRequest)).toBeNull();
  });

  it("prefiere el vecino superior cuando existen ambos lados del zoom", () => {
    const cache = new WaveformTileCache();
    const waveform = buildWaveform({ sampleRate: 480_000 });
    const target = getWaveformRenderPixelsPerSecond(200);
    const lower = target / 1.25;
    const higher = target * 1.25;
    const base = { waveform, clipPixelWidth: 4096 };

    cache.getTile(request({ ...base, pixelsPerSecond: lower }));
    cache.drainPendingTiles(1000);
    cache.getTile(request({ ...base, pixelsPerSecond: higher }));
    cache.getTile(request({ ...base, pixelsPerSecond: higher, tileIndex: 1 }));
    cache.drainPendingTiles(1000);
    const higherTile = cache.getTile(
      request({ ...base, pixelsPerSecond: higher }),
    );

    const slices = cache.getFallbackTileSlices(
      request({ ...base, pixelsPerSecond: target }),
    );
    expect(slices?.[0].canvas).toBe(higherTile?.canvas);
  });

  it("sólo pide detalle nativo por encima del techo del LOD persistido", () => {
    const calls: unknown[][] = [];
    const cache = new WaveformTileCache(async (...args) => {
      calls.push(args);
      return null;
    });

    cache.getTile(request({ pixelsPerSecond: 180 }));
    expect(calls).toHaveLength(0);

    cache.getTile(request({ pixelsPerSecond: 200 }));
    expect(calls).toHaveLength(1);
  });

  it("no crea un tile grueso intermedio mientras espera el detalle fino", async () => {
    let resolveWindow!: (
      value: import("../desktopApi").WaveformWindowDto | null,
    ) => void;
    const response = new Promise<import("../desktopApi").WaveformWindowDto | null>(
      (resolve) => {
        resolveWindow = resolve;
      },
    );
    const cache = new WaveformTileCache(() => response);
    const highZoom = request({ pixelsPerSecond: 300, clipPixelWidth: 1200 });

    expect(cache.getTile(highZoom)).toBeNull();
    expect(cache.hasPendingTiles()).toBe(false);
    expect(cache.drainPendingTiles(1000)).toBe(0);

    const peaks = Array.from({ length: 1024 }, (_, index) =>
      index % 2 === 0 ? -0.75 : 0.75,
    );
    resolveWindow({
      sampleRate: 48_000,
      startSeconds: 0,
      endSeconds: 1024 / 300,
      bucketCount: 1024,
      minPeaksBase64: encodeFloat32Peaks(peaks.map((value) => -Math.abs(value))),
      maxPeaksBase64: encodeFloat32Peaks(peaks.map((value) => Math.abs(value))),
    });
    await response;
    await Promise.resolve();

    // La respuesta despierta el renderer; sólo entonces se encola la superficie
    // definitiva. No hubo una superficie gruesa que pudiera parpadear antes.
    expect(cache.hasPendingTiles()).toBe(true);
    expect(cache.drainPendingTiles(1000)).toBeGreaterThan(0);
    expect(cache.getTile(highZoom)).toBeNull();
    expect(cache.drainPendingTiles(1000)).toBe(1);
    expect(cache.getTile(highZoom)).not.toBeNull();
  });

  it("descarta la respuesta de una ventana que dejó de ser visible", async () => {
    let resolveWindow!: (value: import("../desktopApi").WaveformWindowDto | null) => void;
    const response = new Promise<import("../desktopApi").WaveformWindowDto | null>(
      (resolve) => {
        resolveWindow = resolve;
      },
    );
    const cache = new WaveformTileCache(() => response);
    cache.getTile(request({ pixelsPerSecond: 300, clipPixelWidth: 1200 }));

    cache.beginPaint();
    resolveWindow(null);
    await response;
    await Promise.resolve();

    expect(cache.hasPendingTiles()).toBe(false);
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
  });

  it("vuelve al LOD persistido si el detalle nativo no está disponible", async () => {
    const response = Promise.resolve(null);
    const cache = new WaveformTileCache(() => response);
    const highZoom = request({ pixelsPerSecond: 300, clipPixelWidth: 1200 });

    expect(cache.getTile(highZoom)).toBeNull();
    await response;
    await Promise.resolve();

    // Primer drain: notifica que terminó la petición. El siguiente pintado ya
    // puede encolar el tile tradicional sin mostrar un error al usuario.
    expect(cache.drainPendingTiles(1000)).toBe(1);
    await Promise.resolve();
    expect(cache.getTile(highZoom)).toBeNull();
    expect(cache.drainPendingTiles(1000)).toBe(1);
    expect(cache.getTile(highZoom)).not.toBeNull();
  });
});

describe("altura del tile", () => {
  beforeEach(installFakeCanvas);
  afterEach(removeFakeCanvas);

  it("cuantiza el alto del carril en escalones", () => {
    expect(tileHeightForLane(18)).toBe(32);
    expect(tileHeightForLane(32)).toBe(32);
    expect(tileHeightForLane(33)).toBe(64);
    expect(tileHeightForLane(96)).toBe(128);
    expect(tileHeightForLane(148)).toBe(256);
    // Por encima del último escalón no crece: 256 es el techo.
    expect(tileHeightForLane(4000)).toBe(256);
  });

  it("un carril bajo no paga la memoria de uno alto", () => {
    const low = new WaveformTileCache();
    low.getTile({
      clip: buildClip(),
      waveform: buildWaveform(),
      pixelsPerSecond: 120,
      clipPixelWidth: 1024,
      tileIndex: 0,
      laneHeightPx: 18,
      priority: 0,
    });
    low.drainPendingTiles(1000);

    const tall = new WaveformTileCache();
    tall.getTile({
      clip: buildClip(),
      waveform: buildWaveform(),
      pixelsPerSecond: 120,
      clipPixelWidth: 1024,
      tileIndex: 0,
      laneHeightPx: 148,
      priority: 0,
    });
    tall.drainPendingTiles(1000);

    // 32 px contra 256: ocho veces menos. Antes ambos rasterizaban a 256.
    expect(tall.stats().bytes).toBe(low.stats().bytes * 8);
  });

  it("rasteriza también el ancho del tile a resolución física", () => {
    const oneX = new WaveformTileCache();
    oneX.getTile({
      clip: buildClip(),
      waveform: buildWaveform(),
      pixelsPerSecond: 120,
      clipPixelWidth: 1024,
      tileIndex: 0,
      laneHeightPx: 64,
      pixelRatio: 1,
      priority: 0,
    });
    oneX.drainPendingTiles(1000);

    const twoX = new WaveformTileCache();
    twoX.getTile({
      clip: buildClip(),
      waveform: buildWaveform(),
      pixelsPerSecond: 120,
      clipPixelWidth: 1024,
      tileIndex: 0,
      laneHeightPx: 64,
      pixelRatio: 2,
      priority: 0,
    });
    twoX.drainPendingTiles(1000);

    expect(twoX.stats().bytes).toBe(oneX.stats().bytes * 2);
  });
});
