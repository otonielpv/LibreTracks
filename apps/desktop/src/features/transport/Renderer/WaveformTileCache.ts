import type {
  ClipSummary,
  WaveformLodDto,
  WaveformSummaryDto,
  WaveformWindowDto,
} from "../desktopApi";
import { getWaveformWindow } from "../desktopApi";
import { recordWaveformTileRender } from "../perf/perfMetrics";
import { clamp } from "../timeline/timelineMath";

export const WAVEFORM_TILE_WIDTH_PX = 1024;
// 1.5 permitía hasta +22 % / -18 % de escalado respecto al bitmap nativo y se
// percibía como desenfoque durante la rueda. Con la cola y los sustitutos ya
// fuera del frame, 1.25 limita el error a aproximadamente ±11 %.
const WAVEFORM_ZOOM_CACHE_STEP = 1.25;

/**
 * Alturas de tile permitidas, en píxeles.
 *
 * El tile se rasterizaba SIEMPRE a 256 px de alto y luego se escalaba al
 * carril. Con la altura mínima de pista (18 px) eso son **14 veces más píxeles
 * de los que se ven**, y el escalado 256→18 además se come los picos finos: es
 * parte de por qué la onda se ve sucia en carriles bajos.
 *
 * Se cuantiza en cuatro escalones en vez de usar la altura exacta para que la
 * caché no se fragmente: arrastrar el borde de una pista cambia su altura
 * píxel a píxel, y con altura exacta cada píxel sería un namespace nuevo.
 */
const TILE_HEIGHT_STEPS = [32, 64, 128, 256] as const;

/**
 * Techo de la caché en BYTES, no en número de tiles.
 *
 * Antes el tope eran 320 tiles, que con 1024x256 RGBA son 320 MiB en el caso
 * peor — y medido en el build de medición se llegó a un pico de 146 MB. Un
 * tope en bytes es el único que da una garantía; el de conteo depende de un
 * tamaño de tile que ahora es variable.
 */
const MAX_CACHE_BYTES = 48 * 1024 * 1024;

/**
 * Milisegundos que un frame puede gastar rasterizando tiles.
 *
 * El presupuesto de frame a 60 Hz son 16,7 ms y a 144 Hz son 6,9. Cuatro
 * milisegundos dejan sitio al resto del pintado en el primer caso y, en el
 * segundo, reparten el trabajo en más frames en vez de tirar uno entero.
 */
export const WAVEFORM_TILE_FRAME_BUDGET_MS = 4;
const decodedWaveformLodCache = new WeakMap<
  WaveformLodDto,
  ResolvedWaveformLod
>();

type ResolvedWaveformLod = {
  resolutionFrames: number;
  bucketCount: number;
  minPeaks: Float32Array;
  maxPeaks: Float32Array;
  minPeaksRight: Float32Array;
  maxPeaksRight: Float32Array;
};

type TileSurface = OffscreenCanvas | HTMLCanvasElement;

type TileEntry = {
  namespace: string;
  canvas: TileSurface;
  /** Ancho del backing store, en píxeles físicos. */
  width: number;
  height: number;
  /** Tramo cubierto en el espacio lógico del timeline. */
  logicalWidth: number;
  pixelRatio: number;
  /** true cuando la superficie procede de una ventana PCM bajo demanda. */
  detail: boolean;
  lastUsedAt: number;
};

export type WaveformTile = {
  canvas: TileSurface;
  tileStartPixel: number;
  tileWidth: number;
};

export type WaveformFallbackTileSlice = {
  canvas: TileSurface;
  sourceX: number;
  sourceWidth: number;
  targetStartPixel: number;
  targetWidth: number;
};

export type TileRequest = {
  clip: ClipSummary;
  waveform: WaveformSummaryDto;
  pixelsPerSecond: number;
  clipPixelWidth: number;
  tileIndex: number;
  /** Alto del carril en el que se va a dibujar, para no rasterizar de más. */
  laneHeightPx: number;
  /** Escala física del tile. Opcional para callers y pruebas anteriores. */
  pixelRatio?: number;
  /** Distancia al centro del viewport, en píxeles. Ordena la cola: lo que el
   *  usuario está mirando se rasteriza antes que lo que roza el borde. */
  priority: number;
};

/** Escalón de altura de tile que cubre un carril de `laneHeightPx`. */
export function tileHeightForLane(laneHeightPx: number) {
  const target = Math.max(1, laneHeightPx);
  for (const step of TILE_HEIGHT_STEPS) {
    if (step >= target) {
      return step;
    }
  }
  return TILE_HEIGHT_STEPS[TILE_HEIGHT_STEPS.length - 1];
}

function tilePixelRatio(request: Pick<TileRequest, "pixelRatio">) {
  const ratio = request.pixelRatio ?? 1;
  return Number.isFinite(ratio) ? clamp(ratio, 1, 2) : 1;
}

export function getWaveformRenderPixelsPerSecond(pixelsPerSecond: number) {
  if (!Number.isFinite(pixelsPerSecond) || pixelsPerSecond <= 0) {
    return 1;
  }

  const rawExponent =
    Math.log(pixelsPerSecond) / Math.log(WAVEFORM_ZOOM_CACHE_STEP);
  // Los niveles vecinos se calculan multiplicando por el propio step. Por
  // error binario, log(step^n * step) puede producir n+0.499999999999996 y
  // Math.round lo manda de vuelta al nivel anterior. En zoom-out eso hacía que
  // el sustituto superior se saltase y reapareciese una forma vieja inferior.
  const exponent = Math.floor(rawExponent + 0.5 + 1e-9);
  return Math.max(1, Math.pow(WAVEFORM_ZOOM_CACHE_STEP, exponent));
}

function decodeBase64ToBytes(base64: string) {
  if (typeof atob === "function") {
    const decoded = atob(base64);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }

    return bytes;
  }

  return new Uint8Array(0);
}

export function decodeFloat32Peaks(
  base64: string | undefined,
  expectedCount: number,
) {
  if (!base64 || expectedCount <= 0) {
    return new Float32Array(0);
  }

  const bytes = decodeBase64ToBytes(base64);
  const availableCount = Math.min(
    expectedCount,
    Math.floor(bytes.byteLength / 4),
  );
  const values = new Float32Array(availableCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let index = 0; index < availableCount; index += 1) {
    values[index] = view.getFloat32(index * 4, true);
  }

  return values;
}

function resolveWaveformLod(lod: WaveformLodDto): ResolvedWaveformLod {
  const cached = decodedWaveformLodCache.get(lod);
  if (cached) {
    return cached;
  }

  const resolved = {
    resolutionFrames: lod.resolutionFrames,
    bucketCount: lod.bucketCount,
    minPeaks: lod.minPeaks
      ? Float32Array.from(lod.minPeaks)
      : decodeFloat32Peaks(lod.minPeaksBase64, lod.bucketCount),
    maxPeaks: lod.maxPeaks
      ? Float32Array.from(lod.maxPeaks)
      : decodeFloat32Peaks(lod.maxPeaksBase64, lod.bucketCount),
    minPeaksRight: lod.minPeaksRight
      ? Float32Array.from(lod.minPeaksRight)
      : decodeFloat32Peaks(lod.minPeaksRightBase64, lod.bucketCount),
    maxPeaksRight: lod.maxPeaksRight
      ? Float32Array.from(lod.maxPeaksRight)
      : decodeFloat32Peaks(lod.maxPeaksRightBase64, lod.bucketCount),
  };
  decodedWaveformLodCache.set(lod, resolved);
  return resolved;
}

export function selectWaveformLod(
  waveform: WaveformSummaryDto | undefined,
  pixelsPerSecond: number,
): ResolvedWaveformLod | null {
  if (!waveform?.lods.length) {
    return null;
  }

  const framesPerPixel =
    waveform.sampleRate > 0 && pixelsPerSecond > 0
      ? waveform.sampleRate / pixelsPerSecond
      : waveform.lods[0].resolutionFrames;
  let selectedLod = waveform.lods[0];

  for (const lod of waveform.lods) {
    if (lod.resolutionFrames <= framesPerPixel) {
      selectedLod = lod;
      continue;
    }

    break;
  }

  return resolveWaveformLod(selectedLod);
}

function createTileSurface(width: number, height: number): TileSurface | null {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }

  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  return null;
}

function getTileContext(surface: TileSurface) {
  const context = surface.getContext("2d");
  if (!context || !("fillRect" in context)) {
    return null;
  }
  return context;
}

/**
 * Clave de caché de un tile. Exportada porque su propiedad clave —que dos
 * clips distintos NUNCA compartan clave— es de corrección, no de rendimiento:
 * si colisionaran, un clip mostraría la onda de otro. Tiene tests propios.
 */
export function tileNamespace(request: TileRequest) {
  const renderPixelsPerSecond = getWaveformRenderPixelsPerSecond(
    request.pixelsPerSecond,
  );
  const channelLayout = request.waveform.lods.some(
    (lod) =>
      Boolean(lod.maxPeaksRight?.length) || Boolean(lod.maxPeaksRightBase64),
  )
    ? "stereo"
    : "mono";
  return [
    request.clip.waveformKey,
    request.waveform.version,
    // Partial summaries (a file still being analysed) arrive several times with
    // progressively more peaks under the SAME key and version. Without this the
    // first partial's tiles would be reused for every later one and the
    // waveform would stop growing on screen. "full" for a finished summary
    // keeps the key stable once analysis is done.
    request.waveform.analyzedSeconds?.toFixed(3) ?? "full",
    channelLayout,
    request.waveform.sampleRate,
    request.waveform.durationSeconds.toFixed(6),
    request.clip.sourceStartSeconds.toFixed(6),
    (
      request.clip.sourceWindowDurationSeconds ?? request.clip.durationSeconds
    ).toFixed(6),
    request.clip.sourceDurationSeconds.toFixed(6),
    request.clip.durationSeconds.toFixed(6),
    renderPixelsPerSecond.toFixed(4),
    // La altura entra en la clave: un tile de 32 px no sirve para un carril
    // de 128, y rasterizar siempre a 256 era el desperdicio que este paso quita.
    String(tileHeightForLane(request.laneHeightPx)),
    tilePixelRatio(request).toFixed(3),
  ].join(":");
}

function tileKey(namespace: string, tileIndex: number) {
  return `${namespace}:tile:${tileIndex}`;
}

function renderWaveformTile(
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  request: TileRequest,
  tileStartPixel: number,
  tileWidth: number,
  tileHeight: number,
  resolvedLod?: ResolvedWaveformLod,
) {
  const waveformLod =
    resolvedLod ??
    selectWaveformLod(request.waveform, request.pixelsPerSecond);
  const maxPeaks = waveformLod?.maxPeaks ?? new Float32Array(0);
  const minPeaks = waveformLod?.minPeaks ?? new Float32Array(0);
  const maxPeaksRight = waveformLod?.maxPeaksRight ?? new Float32Array(0);
  const minPeaksRight = waveformLod?.minPeaksRight ?? new Float32Array(0);
  if (
    !maxPeaks.length ||
    !minPeaks.length ||
    tileWidth < 2 ||
    request.clipPixelWidth < 2 ||
    request.clip.sourceDurationSeconds <= 0
  ) {
    return;
  }

  const clipStartRatio = clamp(
    request.clip.sourceStartSeconds / request.clip.sourceDurationSeconds,
    0,
    1,
  );
  const sourceWindowDurationSeconds =
    request.clip.sourceWindowDurationSeconds ?? request.clip.durationSeconds;
  const clipSpanRatio = clamp(
    sourceWindowDurationSeconds / request.clip.sourceDurationSeconds,
    0,
    1,
  );
  const clipStartIndex = Math.max(
    0,
    Math.floor(clipStartRatio * maxPeaks.length),
  );
  const clipEndIndex = Math.min(
    maxPeaks.length,
    Math.max(
      clipStartIndex + 1,
      Math.ceil((clipStartRatio + clipSpanRatio) * maxPeaks.length),
    ),
  );
  const clipSampleCount = clipEndIndex - clipStartIndex;
  if (clipSampleCount <= 0) {
    return;
  }

  const tileEndPixel = Math.min(
    request.clipPixelWidth,
    tileStartPixel + tileWidth,
  );
  const startIndex = Math.max(
    clipStartIndex,
    clipStartIndex +
      Math.floor((tileStartPixel / request.clipPixelWidth) * clipSampleCount),
  );
  const endIndex = Math.min(
    clipEndIndex,
    Math.max(
      startIndex + 1,
      clipStartIndex +
        Math.ceil((tileEndPixel / request.clipPixelWidth) * clipSampleCount),
    ),
  );
  if (startIndex >= endIndex || startIndex >= minPeaks.length) {
    return;
  }

  context.clearRect(0, 0, tileWidth, tileHeight);
  context.fillStyle = "rgba(20, 20, 20, 0.72)";
  context.lineJoin = "round";
  context.lineCap = "round";

  const hasRightChannel =
    minPeaksRight.length === minPeaks.length &&
    maxPeaksRight.length === maxPeaks.length;

  if (hasRightChannel) {
    context.fillStyle = "rgba(20, 20, 20, 0.18)";
    context.fillRect(0, Math.round(tileHeight * 0.5), tileWidth, 1);
    context.fillStyle = "rgba(20, 20, 20, 0.72)";
    drawChannelPeaks(
      context,
      minPeaks,
      maxPeaks,
      startIndex,
      endIndex,
      clipStartIndex,
      clipSampleCount,
      request.clipPixelWidth,
      tileStartPixel,
      tileHeight * 0.25,
      tileHeight * 0.2,
    );
    drawChannelPeaks(
      context,
      minPeaksRight,
      maxPeaksRight,
      startIndex,
      endIndex,
      clipStartIndex,
      clipSampleCount,
      request.clipPixelWidth,
      tileStartPixel,
      tileHeight * 0.75,
      tileHeight * 0.2,
    );
    return;
  }

  drawChannelPeaks(
    context,
    minPeaks,
    maxPeaks,
    startIndex,
    endIndex,
    clipStartIndex,
    clipSampleCount,
    request.clipPixelWidth,
    tileStartPixel,
    tileHeight * 0.5,
    tileHeight * 0.42,
  );
}

function drawChannelPeaks(
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  minPeaks: Float32Array,
  maxPeaks: Float32Array,
  startIndex: number,
  endIndex: number,
  clipStartIndex: number,
  clipSampleCount: number,
  clipPixelWidth: number,
  tileStartPixel: number,
  centerY: number,
  amplitudeY: number,
) {
  const bucketBoundaryX = (index: number) =>
    ((index - clipStartIndex) / clipSampleCount) * clipPixelWidth -
    tileStartPixel;

  // Cada entrada del LOD es el minimo/maximo de un INTERVALO de audio, no
  // una muestra puntual. Unir los centros con diagonales convertia un click
  // aislado en un rombo y hacia que su forma cambiase al saltar de LOD durante
  // el zoom. La envolvente escalonada conserva los extremos de cada bucket y
  // sólo cambia en su frontera temporal real.
  context.beginPath();
  for (let index = startIndex; index < endIndex; index += 1) {
    const y = centerY - clamp(maxPeaks[index], -1, 1) * amplitudeY;
    if (index === startIndex) {
      context.moveTo(bucketBoundaryX(index), y);
    }
    const right = bucketBoundaryX(index + 1);
    context.lineTo(right, y);
    if (index + 1 < endIndex) {
      const nextY =
        centerY - clamp(maxPeaks[index + 1], -1, 1) * amplitudeY;
      context.lineTo(right, nextY);
    }
  }

  for (let index = endIndex - 1; index >= startIndex; index -= 1) {
    const y = centerY - clamp(minPeaks[index], -1, 1) * amplitudeY;
    if (index === endIndex - 1) {
      context.lineTo(bucketBoundaryX(index + 1), y);
    }
    const left = bucketBoundaryX(index);
    context.lineTo(left, y);
    if (index > startIndex) {
      const previousY =
        centerY - clamp(minPeaks[index - 1], -1, 1) * amplitudeY;
      context.lineTo(left, previousY);
    }
  }

  context.closePath();
  context.fill();
}

type PendingTile = {
  key: string;
  namespace: string;
  request: TileRequest;
  tileStartPixel: number;
  tileWidth: number;
  surfaceWidth: number;
  tileHeight: number;
  priority: number;
};

/**
 * Memoria del backing store de un tile. Cada superficie es RGBA de 8 bits, así
 * que son 4 bytes por píxel. Con los valores actuales (1024x256) sale
 * exactamente 1 MiB por tile — el dato que hace visible que el techo de la
 * caché son 320 MiB (ver C4d del diagnóstico).
 */
function tileByteSize(entry: Pick<TileEntry, "width" | "height">) {
  return entry.width * entry.height * 4;
}

/** Buckets del boceto. Suficientes para que se lea como una onda y no como una
 *  fila de bloques; muy por debajo de los ~1024 de un tile de verdad. */
const SKETCH_BUCKETS = 64;

export type SketchRect = {
  /** Tramo de la VENTANA del clip que cubre este dibujo, en [0,1]. */
  fromRatio: number;
  toRatio: number;
  left: number;
  width: number;
  top: number;
  height: number;
};

type DetailWindowEntry = {
  lod: ResolvedWaveformLod;
  bytes: number;
  lastUsedAt: number;
};

export type WaveformWindowLoader = (
  waveformKey: string,
  startSeconds: number,
  endSeconds: number,
  bucketCount: number,
) => Promise<WaveformWindowDto | null>;

type DetailRequestState = "not-needed" | "pending" | "ready" | "unavailable";

function sketchPeakForBucket(
  peaks: Float32Array,
  from: number,
  step: number,
  bucket: number,
  takeMaximum: boolean,
) {
  const sliceStart = Math.max(0, Math.floor(from + bucket * step));
  const sliceEnd = Math.min(
    peaks.length,
    Math.max(sliceStart + 1, Math.ceil(from + (bucket + 1) * step)),
  );
  let peak = takeMaximum ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  for (let source = sliceStart; source < sliceEnd; source += 1) {
    peak = takeMaximum
      ? Math.max(peak, peaks[source])
      : Math.min(peak, peaks[source]);
  }
  return Number.isFinite(peak) ? clamp(peak, -1, 1) : 0;
}

function drawSketchChannel(
  context: CanvasRenderingContext2D,
  minPeaks: Float32Array,
  maxPeaks: Float32Array,
  from: number,
  to: number,
  rect: SketchRect,
  buckets: number,
  centerY: number,
  amplitude: number,
) {
  const step = (to - from) / buckets;
  context.beginPath();
  for (let index = 0; index < buckets; index += 1) {
    const x = rect.left + (index / (buckets - 1)) * rect.width;
    const peak = sketchPeakForBucket(maxPeaks, from, step, index, true);
    const y = centerY - peak * amplitude;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  for (let index = buckets - 1; index >= 0; index -= 1) {
    const x = rect.left + (index / (buckets - 1)) * rect.width;
    const peak = sketchPeakForBucket(minPeaks, from, step, index, false);
    context.lineTo(x, centerY - peak * amplitude);
  }
  context.closePath();
  context.fill();
}

/**
 * Envolvente de la onda a baja resolución, dibujada DIRECTAMENTE sobre el
 * lienzo de destino. Es el relleno mientras el tile de verdad está en la cola.
 *
 * Dos cosas que la primera versión hizo mal y se vieron en cuanto se probó a
 * ojo — ningún test las cubría:
 *
 * 1. **Agrega, no muestrea.** Tomar UN pico por bucket de salida, con miles de
 *    buckets de LOD por medio, hace que los puntos caigan donde caigan: allí
 *    donde uno cae en un cruce por cero la envolvente se estrangula, y el clip
 *    se dibuja como una fila de lentes en vez de como una onda. Hay que tomar
 *    el máximo y el mínimo de CADA tramo.
 * 2. **Sólo cubre el tramo que falta.** Antes se pintaba sobre el clip entero
 *    en cuanto faltaba un solo tile, tapando los que sí estaban rasterizados.
 *    Eso era el parpadeo: la onda buena sustituida por el boceto.
 *
 * Para que agregar salga barato se elige el LOD por la resolución del BOCETO,
 * no por la del zoom: con ~64 buckets de salida basta un LOD grueso, y el bucle
 * recorre decenas de valores en vez de decenas de miles.
 */
export function drawWaveformSketch(
  context: CanvasRenderingContext2D,
  clip: ClipSummary,
  waveform: WaveformSummaryDto,
  rect: SketchRect,
) {
  if (clip.sourceDurationSeconds <= 0 || rect.width < 2) {
    return false;
  }

  const windowSeconds =
    clip.sourceWindowDurationSeconds ?? clip.durationSeconds;
  if (windowSeconds <= 0) {
    return false;
  }

  const buckets = Math.max(
    2,
    Math.min(SKETCH_BUCKETS, Math.floor(rect.width / 3)),
  );
  // LOD elegido para la resolución del boceto, no para la del zoom.
  const lod = selectWaveformLod(waveform, buckets / windowSeconds);
  if (!lod || !lod.maxPeaks.length || !lod.minPeaks.length) {
    return false;
  }

  const startRatio = clamp(
    clip.sourceStartSeconds / clip.sourceDurationSeconds,
    0,
    1,
  );
  const spanRatio = clamp(windowSeconds / clip.sourceDurationSeconds, 0, 1);
  const windowFirst = startRatio * lod.maxPeaks.length;
  const windowSpan = spanRatio * lod.maxPeaks.length;
  const from = windowFirst + clamp(rect.fromRatio, 0, 1) * windowSpan;
  const to = windowFirst + clamp(rect.toRatio, 0, 1) * windowSpan;
  if (to - from <= 0) {
    return false;
  }

  context.save();
  context.fillStyle = "rgba(20, 20, 20, 0.55)";
  const hasRightChannel =
    lod.minPeaksRight.length === lod.minPeaks.length &&
    lod.maxPeaksRight.length === lod.maxPeaks.length;
  if (hasRightChannel) {
    context.fillStyle = "rgba(20, 20, 20, 0.18)";
    context.fillRect(
      rect.left,
      Math.round(rect.top + rect.height * 0.5),
      rect.width,
      1,
    );
    context.fillStyle = "rgba(20, 20, 20, 0.55)";
    drawSketchChannel(
      context,
      lod.minPeaks,
      lod.maxPeaks,
      from,
      to,
      rect,
      buckets,
      rect.top + rect.height * 0.25,
      rect.height * 0.2,
    );
    drawSketchChannel(
      context,
      lod.minPeaksRight,
      lod.maxPeaksRight,
      from,
      to,
      rect,
      buckets,
      rect.top + rect.height * 0.75,
      rect.height * 0.2,
    );
  } else {
    drawSketchChannel(
      context,
      lod.minPeaks,
      lod.maxPeaks,
      from,
      to,
      rect,
      buckets,
      rect.top + rect.height * 0.5,
      rect.height * 0.42,
    );
  }
  context.restore();
  return true;
}

export class WaveformTileCache {
  private readonly tiles = new Map<string, TileEntry>();

  private accessCounter = 0;

  /** Bytes de las superficies vivas, mantenido de forma incremental. */
  private byteEstimate = 0;

  /**
   * Tiles pedidos este pintado que aún no existen.
   *
   * Se vacía al principio de cada pintado (`beginPaint`) y lo rellena
   * `getTile`, así que sólo contiene tiles **visibles ahora mismo**. Eso lo
   * hace auto-podable: durante un zoom continuo, los tiles de un nivel que ya
   * se abandonó desaparecen de la cola sin que nadie tenga que limpiarlos.
   */
  private pending = new Map<string, PendingTile>();

  /** Ventanas finas ya decodificadas. Comparten el mismo presupuesto de bytes
   * con las superficies: así el detalle bajo demanda no crea una segunda caché
   * sin límite. */
  private readonly detailWindows = new Map<string, DetailWindowEntry>();

  private readonly detailRequests = new Map<string, Promise<void>>();

  private readonly detailUnavailableUntil = new Map<string, number>();

  /** Claves visibles en el pintado actual. Una respuesta que ya no pertenece a
   * este conjunto se descarta: el invoke nativo no se puede abortar, pero su
   * resultado sí, que es lo importante durante rueda/pinza continua. */
  private visibleDetailKeys = new Set<string>();

  private detailReadySinceLastDrain = false;

  constructor(
    private readonly loadWindow: WaveformWindowLoader = getWaveformWindow,
  ) {}

  /** Vacía la cola de pendientes. Se llama una vez por pintado. */
  beginPaint() {
    this.pending.clear();
    this.visibleDetailKeys = new Set<string>();
  }

  /**
   * Devuelve el tile si está listo; si no, lo **encola** y devuelve null.
   *
   * Antes rasterizaba aquí mismo, dentro del frame de pintado. Medido en el
   * build de medición: picos de frame de 27,7 / 41,7 / 55,5 / 69,4 / 76,5 ms
   * coincidiendo con ráfagas de tiles, contra un presupuesto de 6,9 ms
   * (144 Hz). Al cruzar un paso de zoom de 1,5x cambian de golpe TODOS los
   * namespaces visibles, así que la ráfaga son decenas de tiles en un frame.
   */
  getTile(request: TileRequest): WaveformTile | null {
    const namespace = tileNamespace(request);
    const tileStartPixel = request.tileIndex * WAVEFORM_TILE_WIDTH_PX;
    const tileWidth = Math.max(
      1,
      Math.ceil(
        Math.min(
          WAVEFORM_TILE_WIDTH_PX,
          request.clipPixelWidth - tileStartPixel,
        ),
      ),
    );
    if (tileWidth <= 0) {
      return null;
    }

    const key = tileKey(namespace, request.tileIndex);
    const detailState = this.requestDetailWindowIfUseful(
      key,
      request,
      tileStartPixel,
      tileWidth,
    );
    const entry = this.tiles.get(key);
    if (entry) {
      entry.lastUsedAt = ++this.accessCounter;
      // Mantén devolviendo el tile grueso mientras su sustituto fino se
      // rasteriza fuera del frame. Así la mejora es atómica y no hay ni un
      // frame de boceto/flash al llegar la respuesta nativa.
      if (this.detailWindows.has(key) && !entry.detail) {
        const existing = this.pending.get(key);
        if (!existing || request.priority < existing.priority) {
          this.pending.set(key, {
            key,
            namespace,
            request,
            tileStartPixel,
            tileWidth,
            surfaceWidth: Math.max(
              1,
              Math.ceil(tileWidth * tilePixelRatio(request)),
            ),
            tileHeight: tileHeightForLane(request.laneHeightPx),
            priority: request.priority,
          });
        }
      }
      return {
        canvas: entry.canvas,
        tileStartPixel,
        tileWidth: entry.logicalWidth,
      };
    }

    // A zoom alto no construyas primero un tile con el LOD persistido para
    // sustituirlo enseguida por otro fino. Mientras llega la ventana, drawTracks
    // conserva el vecino anterior (o el boceto en carga fría); después sólo hay
    // una transición, directamente a la geometría definitiva.
    if (detailState === "pending") {
      return null;
    }

    const existing = this.pending.get(key);
    if (!existing || request.priority < existing.priority) {
      this.pending.set(key, {
        key,
        namespace,
        request,
        tileStartPixel,
        tileWidth,
        surfaceWidth: Math.max(
          1,
          Math.ceil(tileWidth * tilePixelRatio(request)),
        ),
        tileHeight: tileHeightForLane(request.laneHeightPx),
        priority: request.priority,
      });
    }
    return null;
  }

  /**
   * Busca el mismo tramo temporal en una generación de zoom vecina.
   *
   * Los índices de tile no coinciden entre escalas: un tile de 1024 px a
   * 120 px/s cubre más tiempo que uno a 180 px/s. Por eso se traduce primero
   * el tile pedido a segundos locales del clip y después se recortan uno o más
   * tiles de la escala vecina. Sólo se devuelve una generación si cubre el
   * tramo entero; mezclar huecos de varias escalas volvería a producir el
   * parpadeo que este fallback evita.
   */
  getFallbackTileSlices(
    request: TileRequest,
  ): WaveformFallbackTileSlice[] | null {
    const targetPixelsPerSecond = getWaveformRenderPixelsPerSecond(
      request.pixelsPerSecond,
    );
    const targetStartPixel = request.tileIndex * WAVEFORM_TILE_WIDTH_PX;
    const targetEndPixel = Math.min(
      request.clipPixelWidth,
      targetStartPixel + WAVEFORM_TILE_WIDTH_PX,
    );
    if (targetEndPixel <= targetStartPixel || targetPixelsPerSecond <= 0) {
      return null;
    }

    const startSeconds = targetStartPixel / targetPixelsPerSecond;
    const endSeconds = targetEndPixel / targetPixelsPerSecond;
    // Vecino inmediato primero, tanto al acercar como al alejar. Se buscan más
    // anillos porque una rueda/pinza continua puede recorrer todo G3 antes de
    // que venza el debounce y se confirme un nuevo zoom.
    // 24 pasos de 1.25 cubren más de 200x, suficiente para todo el rango de
    // zoom aunque una rueda rápida avance muchos namespaces antes del drain.
    for (let distance = 1; distance <= 24; distance += 1) {
      // El nivel superior se prueba primero. Al alejar, es la generación que el
      // usuario estaba viendo justo antes y además contiene al menos tanta
      // información como el destino. El orden inverso elegía a menudo una
      // generación vieja y más basta, origen de las formas raras en zoom-out.
      for (const direction of [1, -1] as const) {
        const offset = distance * direction;
        const fallbackPixelsPerSecond = getWaveformRenderPixelsPerSecond(
          targetPixelsPerSecond * Math.pow(WAVEFORM_ZOOM_CACHE_STEP, offset),
        );
        if (fallbackPixelsPerSecond === targetPixelsPerSecond) {
          continue;
        }
        const fallbackClipPixelWidth = Math.max(
          1,
          request.clip.durationSeconds * fallbackPixelsPerSecond,
        );
        const fallbackStartPixel = startSeconds * fallbackPixelsPerSecond;
        const fallbackEndPixel = Math.min(
          fallbackClipPixelWidth,
          endSeconds * fallbackPixelsPerSecond,
        );
        const firstTileIndex = Math.max(
          0,
          Math.floor(fallbackStartPixel / WAVEFORM_TILE_WIDTH_PX),
        );
        const lastTileIndex = Math.max(
          firstTileIndex,
          Math.ceil(fallbackEndPixel / WAVEFORM_TILE_WIDTH_PX) - 1,
        );
        const fallbackRequest = {
          ...request,
          pixelsPerSecond: fallbackPixelsPerSecond,
          clipPixelWidth: fallbackClipPixelWidth,
        };
        const namespace = tileNamespace(fallbackRequest);
        const slices: WaveformFallbackTileSlice[] = [];
        let complete = true;

        for (
          let tileIndex = firstTileIndex;
          tileIndex <= lastTileIndex;
          tileIndex += 1
        ) {
          const entry = this.tiles.get(tileKey(namespace, tileIndex));
          if (!entry) {
            complete = false;
            break;
          }
          const tileStart = tileIndex * WAVEFORM_TILE_WIDTH_PX;
          const overlapStart = Math.max(fallbackStartPixel, tileStart);
          const overlapEnd = Math.min(
            fallbackEndPixel,
            tileStart + entry.logicalWidth,
          );
          if (overlapEnd <= overlapStart) {
            continue;
          }
          const overlapStartSeconds =
            overlapStart / fallbackPixelsPerSecond;
          const overlapEndSeconds = overlapEnd / fallbackPixelsPerSecond;
          entry.lastUsedAt = ++this.accessCounter;
          slices.push({
            canvas: entry.canvas,
            sourceX: (overlapStart - tileStart) * entry.pixelRatio,
            sourceWidth: (overlapEnd - overlapStart) * entry.pixelRatio,
            targetStartPixel: overlapStartSeconds * targetPixelsPerSecond,
            targetWidth:
              (overlapEndSeconds - overlapStartSeconds) *
              targetPixelsPerSecond,
          });
        }

        if (complete && slices.length > 0) {
          return slices;
        }
      }
    }

    return null;
  }

  /** ¿Queda trabajo encolado? */
  hasPendingTiles() {
    return this.pending.size > 0 || this.detailReadySinceLastDrain;
  }

  /**
   * Rasteriza tiles encolados hasta agotar `budgetMs`, de más cerca del centro
   * del viewport a más lejos. Devuelve cuántos rasterizó.
   *
   * El presupuesto se comprueba ANTES de cada tile, no después: así un tile
   * caro puede pasarse del presupuesto, pero nunca se empieza uno sabiendo que
   * ya no queda tiempo.
   */
  drainPendingTiles(budgetMs: number): number {
    const detailBecameReady = this.detailReadySinceLastDrain;
    this.detailReadySinceLastDrain = false;
    if (this.pending.size === 0) {
      return detailBecameReady ? 1 : 0;
    }

    const queue = [...this.pending.values()].sort(
      (left, right) => left.priority - right.priority,
    );
    const startedAt = performance.now();
    let rendered = 0;

    for (const item of queue) {
      if (rendered > 0 && performance.now() - startedAt >= budgetMs) {
        break;
      }
      this.pending.delete(item.key);
      if (this.rasterize(item)) {
        rendered += 1;
      }
    }

    return rendered;
  }

  private rasterize(item: PendingTile): boolean {
    const surface = createTileSurface(item.surfaceWidth, item.tileHeight);
    if (!surface) {
      return false;
    }
    const context = getTileContext(surface);
    if (!context) {
      return false;
    }

    const rasterStartedAt = performance.now();
    const pixelRatio = tilePixelRatio(item.request);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    const detail = this.detailWindows.get(item.key);
    if (detail) {
      detail.lastUsedAt = ++this.accessCounter;
      const sourceDuration = Math.max(
        Number.EPSILON,
        detail.lod.bucketCount / Math.max(1, item.surfaceWidth),
      );
      renderWaveformTile(
        context,
        {
          ...item.request,
          clip: {
            ...item.request.clip,
            sourceStartSeconds: 0,
            sourceWindowDurationSeconds: sourceDuration,
            sourceDurationSeconds: sourceDuration,
            durationSeconds: sourceDuration,
          },
          clipPixelWidth: item.tileWidth,
        },
        0,
        item.tileWidth,
        item.tileHeight / pixelRatio,
        detail.lod,
      );
    } else {
      renderWaveformTile(
        context,
        item.request,
        item.tileStartPixel,
        item.tileWidth,
        item.tileHeight / pixelRatio,
      );
    }
    recordWaveformTileRender(performance.now() - rasterStartedAt);

    const entry: TileEntry = {
      namespace: item.namespace,
      canvas: surface,
      width: item.surfaceWidth,
      height: item.tileHeight,
      logicalWidth: item.tileWidth,
      pixelRatio,
      detail: Boolean(detail),
      lastUsedAt: ++this.accessCounter,
    };
    const previous = this.tiles.get(item.key);
    if (previous) {
      this.byteEstimate -= tileByteSize(previous);
    }
    this.tiles.set(item.key, entry);
    this.byteEstimate += tileByteSize(entry);
    this.pruneLeastRecentlyUsedTiles();
    return true;
  }

  /** Tiles vivos y bytes que ocupan. Lo publica el pintado en el HUD. */
  stats() {
    return {
      entries: this.tiles.size + this.detailWindows.size,
      bytes: this.byteEstimate,
    };
  }

  private requestDetailWindowIfUseful(
    key: string,
    request: TileRequest,
    tileStartPixel: number,
    tileWidth: number,
  ): DetailRequestState {
    const finestResolution = request.waveform.lods.reduce(
      (best, lod) => Math.min(best, Math.max(1, lod.resolutionFrames)),
      Number.POSITIVE_INFINITY,
    );
    const detailThreshold = request.waveform.sampleRate / finestResolution;
    if (
      !Number.isFinite(detailThreshold) ||
      request.pixelsPerSecond <= detailThreshold ||
      request.clipPixelWidth <= 0
    ) {
      return "not-needed";
    }

    this.visibleDetailKeys.add(key);
    const cached = this.detailWindows.get(key);
    if (cached) {
      cached.lastUsedAt = ++this.accessCounter;
      return "ready";
    }
    if (this.detailRequests.has(key)) {
      return "pending";
    }
    if ((this.detailUnavailableUntil.get(key) ?? 0) > Date.now()) {
      return "unavailable";
    }

    const sourceWindowSeconds =
      request.clip.sourceWindowDurationSeconds ?? request.clip.durationSeconds;
    const fromRatio = clamp(tileStartPixel / request.clipPixelWidth, 0, 1);
    const toRatio = clamp(
      (tileStartPixel + tileWidth) / request.clipPixelWidth,
      fromRatio,
      1,
    );
    const startSeconds =
      request.clip.sourceStartSeconds + fromRatio * sourceWindowSeconds;
    const endSeconds =
      request.clip.sourceStartSeconds + toRatio * sourceWindowSeconds;
    const bucketCount = Math.max(
      1,
      Math.ceil(tileWidth * tilePixelRatio(request)),
    );

    const promise = this.loadWindow(
      request.clip.waveformKey,
      startSeconds,
      endSeconds,
      bucketCount,
    )
      .then((window) => {
        // Logical cancellation: never cache or repaint a generation that the
        // current viewport no longer asks for.
        if (!this.visibleDetailKeys.has(key)) {
          return;
        }
        const lod = resolveWaveformWindow(window);
        if (!lod) {
          this.detailUnavailableUntil.set(key, Date.now() + 750);
          this.detailReadySinceLastDrain = true;
          return;
        }
        const bytes =
          (lod.minPeaks.byteLength +
            lod.maxPeaks.byteLength +
            lod.minPeaksRight.byteLength +
            lod.maxPeaksRight.byteLength);
        this.detailWindows.set(key, {
          lod,
          bytes,
          lastUsedAt: ++this.accessCounter,
        });
        this.byteEstimate += bytes;
        // La superficie gruesa se conserva hasta que drainPendingTiles haya
        // terminado la fina; getTile la devuelve y a la vez encola el reemplazo.
        this.detailReadySinceLastDrain = true;
        this.pruneLeastRecentlyUsedTiles();
      })
      .catch(() => {
        // Detail is opportunistic. Native-unavailable and transient IPC errors
        // both keep the persisted LOD visible and retry later.
        this.detailUnavailableUntil.set(key, Date.now() + 750);
        this.detailReadySinceLastDrain = true;
      })
      .finally(() => {
        this.detailRequests.delete(key);
      });
    this.detailRequests.set(key, promise);
    return "pending";
  }

  private pruneLeastRecentlyUsedTiles() {
    if (this.byteEstimate <= MAX_CACHE_BYTES) {
      return;
    }

    const entriesByAge = [
      ...[...this.tiles.entries()].map(([key, entry]) => ({
        kind: "tile" as const,
        key,
        bytes: tileByteSize(entry),
        lastUsedAt: entry.lastUsedAt,
      })),
      ...[...this.detailWindows.entries()].map(([key, entry]) => ({
        kind: "detail" as const,
        key,
        bytes: entry.bytes,
        lastUsedAt: entry.lastUsedAt,
      })),
    ].sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    for (const entry of entriesByAge) {
      if (this.byteEstimate <= MAX_CACHE_BYTES) {
        break;
      }
      this.byteEstimate -= entry.bytes;
      if (entry.kind === "tile") this.tiles.delete(entry.key);
      else this.detailWindows.delete(entry.key);
    }
  }
}

function resolveWaveformWindow(
  window: WaveformWindowDto | null,
): ResolvedWaveformLod | null {
  if (!window || window.bucketCount <= 0) return null;
  const minPeaks = decodeFloat32Peaks(
    window.minPeaksBase64,
    window.bucketCount,
  );
  const maxPeaks = decodeFloat32Peaks(
    window.maxPeaksBase64,
    window.bucketCount,
  );
  if (
    minPeaks.length !== window.bucketCount ||
    maxPeaks.length !== window.bucketCount
  ) {
    return null;
  }
  return {
    resolutionFrames: 1,
    bucketCount: window.bucketCount,
    minPeaks,
    maxPeaks,
    minPeaksRight: decodeFloat32Peaks(
      window.minPeaksRightBase64,
      window.bucketCount,
    ),
    maxPeaksRight: decodeFloat32Peaks(
      window.maxPeaksRightBase64,
      window.bucketCount,
    ),
  };
}
