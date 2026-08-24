/**
 * Lightweight runtime perf metrics for the timeline UI.
 *
 * Everything in here is opt-in via the `lt:perf:hud` localStorage flag (or
 * the in-app toggle keybinding) — when off, the recording functions are
 * cheap no-ops and the rAF loop never starts, so leaving the metrics
 * sprinkled through the codebase costs essentially nothing in production.
 *
 * Three groups of numbers are tracked:
 *
 *   1. Frame-budget: fps (EMA), worst frame in the last second, current
 *      frame time in ms.
 *   2. React work: monotonically increasing render counts per component
 *      name we explicitly mark via recordRender(name).
 *   3. Engine bridge: rolling average of getTransportSnapshot IPC cost
 *      and of the gap between snapshot arrival and React commit.
 *
 * Numbers are stored in mutable arrays/maps so subscribers can grab a
 * snapshot once per HUD refresh (1 Hz) instead of triggering a re-render
 * on every recordRender call.
 */

import { setIpcObserver } from "@libretracks/shared/desktopApi";

const STORAGE_KEY = "lt:perf:hud";

function isPerfInstrumentationAvailable() {
  if (import.meta.env.DEV) return true;
  if (typeof window === "undefined") return false;
  return Boolean(
    (window as unknown as { __LT_DEBUG_BUILD?: boolean }).__LT_DEBUG_BUILD,
  );
}

let started = false;
let rafId = 0;
let lastFrameTime = 0;

// Frame-budget metrics.
const frameTimeWindow: number[] = []; // last ~120 frames
const FRAME_WINDOW_SIZE = 120;
let fpsEma = 60;
let worstFrameMsThisSecond = 0;
let worstFrameMsLastSecond = 0;
let frameWindowStart = 0;

// React work.
const renderCounts = new Map<string, number>();

// Engine bridge.
let snapshotIpcSamples: number[] = [];
const SNAPSHOT_SAMPLE_SIZE = 30;
let snapshotIpcEma = 0;

let snapshotCommitGapEma = 0;

// Canvas paint (TimelineRenderer).
let canvasRenderEma = 0;
let canvasRenderWorstThisSecond = 0;
let canvasRenderWorstLastSecond = 0;
let canvasRenderWindowStart = 0;
let canvasPaintCount = 0; // monotonic; lets the HUD distinguish "0 because idle" from "0 because instrumentation is broken"

// ── Métricas del plan docs/plans/ui-performance ─────────────────────────
//
// Cinco grupos añadidos para poder demostrar (o desmentir) las causas del
// diagnóstico. Todos siguen el patrón de arriba: variables de módulo, función
// `record*` que sale inmediatamente si el HUD está apagado, y lectura por
// snapshot desde el HUD a 4 Hz. Ninguna dispara un render de React.

// Rasterización de tiles de waveform (causa C4 del diagnóstico).
let waveformTileRenderCount = 0; // monotónico
let waveformTileRenderEma = 0;
let waveformTileRenderWorstThisSecond = 0;
let waveformTileRenderWorstLastSecond = 0;
let waveformTileMsThisSecond = 0;
let waveformTileMsLastSecond = 0;
let waveformTileWindowStart = 0;
let tileDrainWindowStart = 0;
// Gauges publicados por la caché una vez por pintado.
let waveformTileCacheEntries = 0;
let waveformTileCacheBytes = 0;
let waveformTileCachePeakBytes = 0;

/**
 * Duración de la llamada de drenado COMPLETA, por frame — no de cada tile.
 *
 * Tras el paso 04 la aritmética dejó de cuadrar: los tiles suman 20-38 ms por
 * SEGUNDO (≈0,2 ms por frame) y sin embargo siguen apareciendo frames de 27 a
 * 42 ms. O el drenado cuesta mucho más que la suma de sus tiles —asignar y
 * liberar superficies, expulsiones de la caché— o el pico no es del drenado en
 * absoluto. Medir el drenado entero es lo que separa las dos hipótesis.
 */
let tileDrainWorstThisSecond = 0;
let tileDrainWorstLastSecond = 0;
let tileDrainMsThisSecond = 0;
let tileDrainMsLastSecond = 0;

// Reconstrucciones de la rejilla (causa C6).
let gridBuildCount = 0; // monotónico
let gridEntryCount = 0; // tamaño de la última rejilla construida

// Perfil de IPC por comando (causas C2/C3). Alimentado por el observador que
// `startPerfMetrics` registra en `desktopApi`.
type IpcCommandStats = {
  calls: number;
  totalMs: number;
  worstMs: number;
  failures: number;
};
const ipcByCommand = new Map<string, IpcCommandStats>();

// Gestos (causa C1) y commits de edición (causa C2).
//
// La detección vive AQUÍ, en los listeners de ventana que el HUD ya instala,
// y no en el código de arrastre, por dos razones: no añade una sola línea al
// hot path, y no puede desincronizarse del código que mide (si un arrastre
// cambia de sitio, el gesto se sigue detectando por el elemento que recibe el
// puntero). `TimelineCanvasPane.tsx` está además a 1 línea de su presupuesto.
//
// LOS LISTENERES VAN EN FASE DE CAPTURA. No es un detalle: `beginRegionMove`,
// `beginRegionResize` y el arrastre de marcas llaman a `event.stopPropagation()`
// en el propio elemento, así que un listener de ventana en fase de burbuja
// NUNCA los ve. En la primera medición eso dejó el banco ciego justo para el
// gesto que el plan viene a medir: 8 llamadas a `move_song_region` en la tabla
// de IPC y CERO gestos `region-move` registrados. La captura corre antes que
// el destino, así que `stopPropagation()` no puede silenciarla.

/** Clase CSS del elemento agarrado → nombre del gesto. */
const GESTURE_KIND_BY_CLASS: Record<string, string> = {
  "lt-region-hotspot": "region-move",
  "lt-region-resize-handle": "region-resize",
  "lt-marker-hotspot": "marker-move",
  "lt-automation-hotspot": "cue-move",
  "lt-track-lane": "clip-drag",
  "lt-playhead": "playhead-drag",
  "lt-library-asset": "library-drag",
};

/** Gestos cuyo `pointerup` dispara una edición que hay que cronometrar. */
const GESTURE_KINDS_THAT_COMMIT = new Set([
  "region-move",
  "region-resize",
  "marker-move",
  "cue-move",
  "clip-drag",
]);

/**
 * Píxeles que hay que recorrer para que el gesto cuente como arrastre y no
 * como clic. Espeja `DRAG_THRESHOLD_PX` de `../constants`: por debajo de eso la
 * app no edita nada, así que abrir un cronómetro de commit dejaría un commit
 * colgando hasta el timeout. Pasó en la primera medición: un `clip-drag` de un
 * solo movimiento produjo un commit de 8171 ms «(timeout)» que era en realidad
 * un clic de posicionado.
 */
const GESTURE_DRAG_THRESHOLD_PX = 6;

type ActiveGesture = {
  kind: string;
  startedAt: number;
  startClientX: number;
  startClientY: number;
  moves: number;
  /** Ha superado el umbral de arrastre: sólo entonces hay edición que medir. */
  movedEnough: boolean;
  renders: number;
  rendersByComponent: Map<string, number>;
  tileRenders: number;
  canvasPaintsAtStart: number;
};

export type GestureReport = {
  kind: string;
  /** Eventos de puntero (o de rueda) recibidos durante el gesto. */
  moves: number;
  /** Superó el umbral de arrastre (6 px). Un clic no edita nada. */
  movedEnough: boolean;
  /** Renders de React durante el gesto. El objetivo del paso 02 es CERO. */
  renders: number;
  rendersByComponent: Record<string, number>;
  /** Tiles rasterizados durante el gesto. El objetivo del paso 04 es repartirlos. */
  tileRenders: number;
  canvasPaints: number;
  durationMs: number;
};

export type CommitReport = {
  kind: string;
  /** De `pointerup` al render que ya muestra el cambio. Métrica del paso 03. */
  ms: number;
  settledBy: "song" | "timeout";
};

const MAX_REPORTS = 200;
/** Un commit sin resolver más allá de esto se cierra como "timeout". */
const COMMIT_TIMEOUT_MS = 8000;

let activeGesture: ActiveGesture | null = null;
const gestureReports: GestureReport[] = [];
const commitReports: CommitReport[] = [];
let openCommits: Array<{ kind: string; startedAt: number }> = [];

export function isPerfHudEnabled(): boolean {
  if (!isPerfInstrumentationAvailable()) return false;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setPerfHudEnabled(enabled: boolean) {
  if (!isPerfInstrumentationAvailable()) return;
  if (typeof window === "undefined") return;
  try {
    if (enabled) {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Ignore — quota or private-mode.
  }
}

/**
 * Start the rAF measurement loop. Safe to call repeatedly; only the first
 * call wires the loop. Stops automatically when the HUD flag flips off
 * via stopPerfMetrics().
 */
export function startPerfMetrics() {
  if (!isPerfInstrumentationAvailable()) return;
  if (started || typeof window === "undefined") return;
  started = true;
  lastFrameTime = performance.now();
  frameWindowStart = lastFrameTime;
  rafId = window.requestAnimationFrame(tick);
  setIpcObserver(recordIpcCommand);
  startRecording();
  installAutoMarkers();
  installConsoleHandle();
}

export function stopPerfMetrics() {
  if (!started) return;
  started = false;
  if (rafId) window.cancelAnimationFrame(rafId);
  rafId = 0;
  frameTimeWindow.length = 0;
  fpsEma = 60;
  worstFrameMsThisSecond = 0;
  worstFrameMsLastSecond = 0;
  renderCounts.clear();
  snapshotIpcSamples = [];
  snapshotIpcEma = 0;
  snapshotCommitGapEma = 0;
  canvasRenderEma = 0;
  canvasRenderWorstThisSecond = 0;
  canvasRenderWorstLastSecond = 0;
  canvasRenderWindowStart = 0;
  canvasPaintCount = 0;
  waveformTileRenderCount = 0;
  waveformTileRenderEma = 0;
  waveformTileRenderWorstThisSecond = 0;
  waveformTileRenderWorstLastSecond = 0;
  waveformTileMsThisSecond = 0;
  waveformTileMsLastSecond = 0;
  waveformTileWindowStart = 0;
  tileDrainWorstThisSecond = 0;
  tileDrainWorstLastSecond = 0;
  tileDrainMsThisSecond = 0;
  tileDrainMsLastSecond = 0;
  tileDrainWindowStart = 0;
  waveformTileCacheEntries = 0;
  waveformTileCacheBytes = 0;
  waveformTileCachePeakBytes = 0;
  gridBuildCount = 0;
  gridEntryCount = 0;
  ipcByCommand.clear();
  gestureReports.length = 0;
  commitReports.length = 0;
  openCommits = [];
  setIpcObserver(null);
  stopRecording();
  uninstallAutoMarkers();
}

function tick(now: number) {
  const frameMs = now - lastFrameTime;
  lastFrameTime = now;

  frameTimeWindow.push(frameMs);
  if (frameTimeWindow.length > FRAME_WINDOW_SIZE) frameTimeWindow.shift();

  // EMA over the window — bias toward recent samples.
  if (frameMs > 0) {
    const instantFps = 1000 / frameMs;
    fpsEma = fpsEma === 0 ? instantFps : fpsEma * 0.9 + instantFps * 0.1;
  }

  if (frameMs > worstFrameMsThisSecond) worstFrameMsThisSecond = frameMs;

  if (now - frameWindowStart >= 1000) {
    worstFrameMsLastSecond = worstFrameMsThisSecond;
    worstFrameMsThisSecond = 0;
    frameWindowStart = now;
  }

  rollWaveformTileWindow(now);
  if (now - tileDrainWindowStart >= 1000) {
    tileDrainWorstLastSecond = tileDrainWorstThisSecond;
    tileDrainMsLastSecond = tileDrainMsThisSecond;
    tileDrainWorstThisSecond = 0;
    tileDrainMsThisSecond = 0;
    tileDrainWindowStart = now;
  }

  rafId = window.requestAnimationFrame(tick);
}

/**
 * Cierra la ventana de un segundo de los tiles de waveform. La llama `tick()`
 * en cada frame; **no** se llama desde `recordWaveformTileRender`.
 *
 * Por qué vive aquí: los tiles se rasterizan en ráfaga (al cruzar un paso de
 * zoom aparecen decenas de golpe) y después no se toca ninguno durante
 * segundos. Con el cierre dentro del `record*`, tras la ráfaga no volvía a
 * ejecutarse y el total del último segundo se quedaba congelado — en la primera
 * medición real salieron 64 tiles rasterizados y `waveformTileMsLastSecond` = 0
 * en las 513 muestras.
 *
 * Exportada sólo para poder probar ese cierre sin depender del rAF.
 */
export function rollWaveformTileWindow(now: number) {
  if (waveformTileWindowStart === 0) {
    waveformTileWindowStart = now;
    return;
  }
  if (now - waveformTileWindowStart < 1000) {
    return;
  }
  waveformTileRenderWorstLastSecond = waveformTileRenderWorstThisSecond;
  waveformTileMsLastSecond = waveformTileMsThisSecond;
  waveformTileRenderWorstThisSecond = 0;
  waveformTileMsThisSecond = 0;
  waveformTileWindowStart = now;
}

export function recordRender(componentName: string) {
  if (!started) return;
  renderCounts.set(componentName, (renderCounts.get(componentName) ?? 0) + 1);
  // Un render ocurrido DENTRO de un gesto es la métrica del paso 02: un
  // arrastre correcto (refs + canvas) no debe producir ninguno.
  if (activeGesture) {
    activeGesture.renders += 1;
    activeGesture.rendersByComponent.set(
      componentName,
      (activeGesture.rendersByComponent.get(componentName) ?? 0) + 1,
    );
  }
}

/**
 * Coste de rasterizar UN tile de waveform. Se llama desde el fallo de caché de
 * `WaveformTileCache.getTile`, que hoy ocurre dentro del frame — de ahí que
 * interese tanto el total por segundo como el peor caso individual.
 */
export function recordWaveformTileRender(ms: number) {
  if (!started) return;
  waveformTileRenderCount += 1;
  waveformTileRenderEma =
    waveformTileRenderEma === 0 ? ms : waveformTileRenderEma * 0.85 + ms * 0.15;
  if (ms > waveformTileRenderWorstThisSecond)
    waveformTileRenderWorstThisSecond = ms;
  waveformTileMsThisSecond += ms;
  if (activeGesture) activeGesture.tileRenders += 1;
  // La ventana de un segundo NO rueda aquí: la hace rodar `tick()`. Ver el
  // comentario en esa función — este fue un defecto real, detectado en la
  // primera medición.
}

/** Coste de una llamada completa a la cola de tiles, en un frame. */
export function recordTileDrain(ms: number) {
  if (!started) return;
  tileDrainMsThisSecond += ms;
  if (ms > tileDrainWorstThisSecond) tileDrainWorstThisSecond = ms;
}

/** Estado de la caché de tiles, publicado una vez por pintado. */
export function reportWaveformTileCache(entries: number, bytes: number) {
  if (!started) return;
  waveformTileCacheEntries = entries;
  waveformTileCacheBytes = bytes;
  if (bytes > waveformTileCachePeakBytes) waveformTileCachePeakBytes = bytes;
}

/**
 * Una construcción real de la rejilla del timeline. Si este contador sube al
 * ritmo de los renders de React (y no al de los cambios de canción o de
 * viewport), el memo de `useTimelineGrid` no está acertando — causa C6.
 */
export function recordGridBuild(entries: number) {
  if (!started) return;
  gridBuildCount += 1;
  gridEntryCount = entries;
}

function beginGesture(kind: string, clientX = 0, clientY = 0) {
  if (!started) return;
  // Un gesto nuevo cancela el anterior sin cerrarlo: un pointerdown sin su
  // pointerup (capture perdida, ventana desenfocada) no debe falsear el
  // siguiente.
  activeGesture = {
    kind,
    startedAt: performance.now(),
    startClientX: clientX,
    startClientY: clientY,
    moves: 0,
    movedEnough: false,
    renders: 0,
    rendersByComponent: new Map(),
    tileRenders: 0,
    canvasPaintsAtStart: canvasPaintCount,
  };
}

function endGesture() {
  const gesture = activeGesture;
  activeGesture = null;
  if (!started || !gesture) return;

  const report: GestureReport = {
    kind: gesture.kind,
    moves: gesture.moves,
    movedEnough: gesture.movedEnough,
    renders: gesture.renders,
    rendersByComponent: Object.fromEntries(gesture.rendersByComponent),
    tileRenders: gesture.tileRenders,
    canvasPaints: canvasPaintCount - gesture.canvasPaintsAtStart,
    durationMs: performance.now() - gesture.startedAt,
  };
  gestureReports.push(report);
  if (gestureReports.length > MAX_REPORTS) gestureReports.shift();
  markEvent(
    `gesture ${report.kind}: ${report.moves} moves, ${report.renders} renders, ` +
      `${report.tileRenders} tiles, ${report.durationMs.toFixed(0)} ms`,
  );

  // Sólo cronometramos el commit si el gesto superó el umbral de arrastre: un
  // clic (o un temblor de 1 px) no edita nada y dejaría un commit colgando
  // hasta el timeout.
  if (report.movedEnough && GESTURE_KINDS_THAT_COMMIT.has(report.kind)) {
    openCommits.push({ kind: report.kind, startedAt: performance.now() });
  }
}

/**
 * Cierra los commits abiertos. La llama el frontend cuando el modelo ya
 * refleja la edición (efecto sobre `song` en TransportPanelContent), que es
 * el instante en que el usuario VE el cambio.
 */
export function settlePerfCommits(reason: CommitReport["settledBy"] = "song") {
  if (!started || openCommits.length === 0) return;
  const now = performance.now();
  for (const commit of openCommits) {
    commitReports.push({
      kind: commit.kind,
      ms: now - commit.startedAt,
      settledBy: reason,
    });
    markEvent(
      `commit ${commit.kind}: ${(now - commit.startedAt).toFixed(0)} ms (${reason})`,
    );
  }
  while (commitReports.length > MAX_REPORTS) commitReports.shift();
  openCommits = [];
}

/** Un commit que nunca se resolvió no puede quedarse contando para siempre. */
function expireStaleCommits() {
  if (openCommits.length === 0) return;
  const now = performance.now();
  const stale = openCommits.filter(
    (commit) => now - commit.startedAt >= COMMIT_TIMEOUT_MS,
  );
  if (stale.length === 0) return;
  openCommits = openCommits.filter(
    (commit) => now - commit.startedAt < COMMIT_TIMEOUT_MS,
  );
  for (const commit of stale) {
    commitReports.push({
      kind: commit.kind,
      ms: now - commit.startedAt,
      settledBy: "timeout",
    });
  }
  while (commitReports.length > MAX_REPORTS) commitReports.shift();
}

/** Exportado para que el test pueda ejercitar el mismo camino que el
 *  observador registrado en `desktopApi`. */
export function recordIpcCommand(
  command: string,
  durationMs: number,
  ok: boolean,
) {
  if (!started) return;
  let stats = ipcByCommand.get(command);
  if (!stats) {
    stats = { calls: 0, totalMs: 0, worstMs: 0, failures: 0 };
    ipcByCommand.set(command, stats);
  }
  stats.calls += 1;
  stats.totalMs += durationMs;
  if (durationMs > stats.worstMs) stats.worstMs = durationMs;
  if (!ok) stats.failures += 1;
}

export function recordSnapshotIpc(ms: number) {
  if (!started) return;
  snapshotIpcSamples.push(ms);
  if (snapshotIpcSamples.length > SNAPSHOT_SAMPLE_SIZE)
    snapshotIpcSamples.shift();
  snapshotIpcEma = snapshotIpcEma === 0 ? ms : snapshotIpcEma * 0.8 + ms * 0.2;
}

export function recordSnapshotCommitGap(ms: number) {
  if (!started) return;
  snapshotCommitGapEma =
    snapshotCommitGapEma === 0 ? ms : snapshotCommitGapEma * 0.8 + ms * 0.2;
}

export type PerfSnapshot = {
  fps: number;
  frameMs: number;
  worstFrameMs: number;
  renderCounts: Array<[string, number]>;
  snapshotIpcEma: number;
  snapshotIpcP99: number;
  snapshotCommitGapEma: number;
  canvasRenderEma: number;
  canvasRenderWorstMs: number;
  canvasPaintCount: number;
  // ── Plan docs/plans/ui-performance ──
  waveformTileRenders: number;
  waveformTileRenderEma: number;
  waveformTileRenderWorstMs: number;
  /** Milisegundos gastados rasterizando tiles durante el último segundo. */
  waveformTileMsLastSecond: number;
  /** Peor llamada de drenado del último segundo, y total del segundo. */
  tileDrainWorstMs: number;
  tileDrainMsLastSecond: number;
  waveformTileCacheEntries: number;
  waveformTileCacheBytes: number;
  waveformTileCachePeakBytes: number;
  gridBuilds: number;
  gridEntries: number;
  /** [comando, llamadas, ms medios, peor ms, fallos], por coste total. */
  ipcByCommand: Array<[string, number, number, number, number]>;
  /** Últimos gestos cerrados, el más reciente primero. */
  gestures: GestureReport[];
  /** Últimos commits de edición cronometrados, el más reciente primero. */
  commits: CommitReport[];
  openCommits: number;
};

export function recordCanvasRender(ms: number) {
  if (!started) return;
  canvasPaintCount += 1;
  canvasRenderEma =
    canvasRenderEma === 0 ? ms : canvasRenderEma * 0.85 + ms * 0.15;
  if (ms > canvasRenderWorstThisSecond) canvasRenderWorstThisSecond = ms;
  const now = performance.now();
  if (canvasRenderWindowStart === 0) canvasRenderWindowStart = now;
  if (now - canvasRenderWindowStart >= 1000) {
    canvasRenderWorstLastSecond = canvasRenderWorstThisSecond;
    canvasRenderWorstThisSecond = 0;
    canvasRenderWindowStart = now;
  }
}

// ── Recording buffer ────────────────────────────────────────────────────
//
// Captures snapshots over time so the user can reproduce a long action
// (scroll, zoom, play with many tracks) and afterwards export everything
// to a JSON file — easier than taking screenshots while the action is
// happening. Bounded so long sessions don't bloat memory.

type RecordedSample = {
  t: number; // ms since recording started
  fps: number;
  frameMs: number;
  worstFrameMs: number;
  snapshotIpcEma: number;
  snapshotIpcP99: number;
  snapshotCommitGapEma: number;
  canvasRenderEma: number;
  canvasRenderWorstMs: number;
  canvasPaintCount: number;
  renderCounts: Record<string, number>;
  waveformTileRenders: number;
  waveformTileMsLastSecond: number;
  waveformTileCacheBytes: number;
  tileDrainWorstMs: number;
  gridBuilds: number;
};

type RecordedMarker = {
  t: number;
  label: string;
};

const MAX_RECORDED_SAMPLES = 4000; // ~16 minutes at 4 Hz sampling
let recordingStartedAt = 0;
const recordedSamples: RecordedSample[] = [];
const recordedMarkers: RecordedMarker[] = [];

function appendRecordedSample() {
  if (!started) return;
  if (recordingStartedAt === 0) return;
  // Antes de leer: cierra los commits que nunca se resolvieron, para que no
  // se queden contando y contaminen la siguiente medición.
  expireStaleCommits();
  const snap = readPerfSnapshot();
  recordedSamples.push({
    t: performance.now() - recordingStartedAt,
    fps: snap.fps,
    frameMs: snap.frameMs,
    worstFrameMs: snap.worstFrameMs,
    snapshotIpcEma: snap.snapshotIpcEma,
    snapshotIpcP99: snap.snapshotIpcP99,
    snapshotCommitGapEma: snap.snapshotCommitGapEma,
    canvasRenderEma: snap.canvasRenderEma,
    canvasRenderWorstMs: snap.canvasRenderWorstMs,
    canvasPaintCount: snap.canvasPaintCount,
    renderCounts: Object.fromEntries(snap.renderCounts),
    waveformTileRenders: snap.waveformTileRenders,
    waveformTileMsLastSecond: snap.waveformTileMsLastSecond,
    waveformTileCacheBytes: snap.waveformTileCacheBytes,
    tileDrainWorstMs: snap.tileDrainWorstMs,
    gridBuilds: snap.gridBuilds,
  });
  if (recordedSamples.length > MAX_RECORDED_SAMPLES) {
    recordedSamples.shift();
  }
}

/** Public API for the recording buffer. Called from PerfHud's sampling
 *  interval AND from console helpers exposed via window.__lt_perf. */
export function recordingTick() {
  appendRecordedSample();
}

export function markEvent(label: string) {
  if (!started || recordingStartedAt === 0) return;
  recordedMarkers.push({
    t: performance.now() - recordingStartedAt,
    label,
  });
}

export function startRecording() {
  recordingStartedAt = performance.now();
  recordedSamples.length = 0;
  recordedMarkers.length = 0;
}

export function stopRecording() {
  recordingStartedAt = 0;
}

function buildRecordingPayload() {
  const snapshot = readPerfSnapshot();
  return {
    capturedAt: new Date().toISOString(),
    // Contexto de la máquina: una cifra de rendimiento sin esto no se puede
    // comparar con la de otra persona (regla 1 del plan).
    environment: {
      userAgent:
        typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
      devicePixelRatio:
        typeof window !== "undefined" ? window.devicePixelRatio : 1,
      viewport:
        typeof window !== "undefined"
          ? `${window.innerWidth}x${window.innerHeight}`
          : "unknown",
      hardwareConcurrency:
        typeof navigator !== "undefined"
          ? navigator.hardwareConcurrency
          : undefined,
      isDevBuild: import.meta.env.DEV,
    },
    // Los resúmenes van ANTES que `samples` a propósito: el array de muestras
    // pesa ~100 KB y, pegado en un chat o en un issue, se corta por longitud.
    // Las dos primeras exportaciones reales perdieron justo estas listas, que
    // son las que responden a las preguntas del plan.
    gestures: snapshot.gestures,
    commits: snapshot.commits,
    ipcByCommand: snapshot.ipcByCommand,
    waveformTileCachePeakBytes: snapshot.waveformTileCachePeakBytes,
    sampleCount: recordedSamples.length,
    markerCount: recordedMarkers.length,
    samples: recordedSamples,
    markers: recordedMarkers,
  };
}

/**
 * Try several strategies to surface the recorded JSON. We do all of them
 * because the Tauri webview blocks <a download> on Windows (file never
 * appears in the Downloads folder) but clipboard + console always work.
 *
 * Order of attempts:
 *   1. Copy to clipboard via the async Clipboard API. This is the most
 *      useful path — the user can paste the JSON straight into chat.
 *   2. Print the full payload to the console with `console.log`. The
 *      user can right-click → "Copy object" / "Copy string" from DevTools
 *      if the clipboard write failed (e.g. focus issues).
 *   3. Trigger an <a download> click as a best-effort browser fallback.
 *
 * Returns a label describing what actually happened so the HUD button
 * can show a brief confirmation.
 */
export async function downloadRecording(): Promise<string> {
  const payload = buildRecordingPayload();
  const json = JSON.stringify(payload, null, 2);

  // Always log first — guaranteed to surface in DevTools and the user can
  // copy from there as a last resort.
  // eslint-disable-next-line no-console
  console.log(
    `[perf] recording (${payload.sampleCount} samples, ${payload.markerCount} markers):`,
    payload,
  );

  // Clipboard path. Requires the document to be focused; in Tauri's
  // webview this is usually the case but we still catch and fall through.
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(json);
      return `copied ${payload.sampleCount} samples to clipboard`;
    } catch {
      // fall through
    }
  }

  // Best-effort download fallback. Tauri 2 on Windows ignores this in
  // most configurations but it doesn't hurt to try.
  try {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "lt-perf-recording.json";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } catch {
    // ignore
  }

  return `${payload.sampleCount} samples printed to console`;
}

export function dumpRecordingSummary() {
  if (recordedSamples.length === 0) {
    // eslint-disable-next-line no-console
    console.log("[perf] no samples recorded yet");
    return;
  }
  const fps = recordedSamples.map((s) => s.fps);
  const worst = recordedSamples.map((s) => s.worstFrameMs);
  const canvas = recordedSamples.map((s) => s.canvasRenderEma);
  const ipc = recordedSamples.map((s) => s.snapshotIpcEma);
  // eslint-disable-next-line no-console
  console.table({
    samples: { count: recordedSamples.length },
    fps: {
      min: Math.min(...fps).toFixed(1),
      avg: (fps.reduce((a, b) => a + b, 0) / fps.length).toFixed(1),
      max: Math.max(...fps).toFixed(1),
    },
    worstFrameMs: {
      min: Math.min(...worst).toFixed(1),
      avg: (worst.reduce((a, b) => a + b, 0) / worst.length).toFixed(1),
      max: Math.max(...worst).toFixed(1),
    },
    canvasMs: {
      min: Math.min(...canvas).toFixed(1),
      avg: (canvas.reduce((a, b) => a + b, 0) / canvas.length).toFixed(1),
      max: Math.max(...canvas).toFixed(1),
    },
    ipcMs: {
      min: Math.min(...ipc).toFixed(1),
      avg: (ipc.reduce((a, b) => a + b, 0) / ipc.length).toFixed(1),
      max: Math.max(...ipc).toFixed(1),
    },
  });
  if (recordedMarkers.length > 0) {
    // eslint-disable-next-line no-console
    console.log("[perf] markers:", recordedMarkers);
  }
  dumpPlanSummary();
}

/**
 * Resumen orientado a los criterios de aceptación de
 * `docs/plans/ui-performance`. Agrupa los gestos por tipo, porque el
 * protocolo pide 5 repeticiones de cada uno y lo que importa es la mediana,
 * no un gesto suelto.
 */
export function dumpPlanSummary() {
  const snapshot = readPerfSnapshot();

  if (snapshot.gestures.length > 0) {
    const byKind = new Map<string, GestureReport[]>();
    for (const gesture of snapshot.gestures) {
      const bucket = byKind.get(gesture.kind);
      if (bucket) bucket.push(gesture);
      else byKind.set(gesture.kind, [gesture]);
    }
    const rows: Record<string, unknown> = {};
    for (const [kind, reports] of byKind) {
      rows[kind] = {
        gestos: reports.length,
        "moves (mediana)": median(reports.map((r) => r.moves)).toFixed(0),
        "RENDERS (mediana)": median(reports.map((r) => r.renders)).toFixed(0),
        "renders (peor)": Math.max(...reports.map((r) => r.renders)),
        "tiles (mediana)": median(reports.map((r) => r.tileRenders)).toFixed(0),
        "tiles (peor)": Math.max(...reports.map((r) => r.tileRenders)),
      };
    }
    // eslint-disable-next-line no-console
    console.log(
      "[perf] gestos — objetivo del paso 02: RENDERS = 0 en region-move / marker-move / clip-drag",
    );
    // eslint-disable-next-line no-console
    console.table(rows);
  }

  if (snapshot.commits.length > 0) {
    const byKind = new Map<string, number[]>();
    for (const commit of snapshot.commits) {
      if (commit.settledBy === "timeout") continue;
      const bucket = byKind.get(commit.kind);
      if (bucket) bucket.push(commit.ms);
      else byKind.set(commit.kind, [commit.ms]);
    }
    const rows: Record<string, unknown> = {};
    for (const [kind, samples] of byKind) {
      rows[kind] = {
        commits: samples.length,
        "ms (mediana)": median(samples).toFixed(0),
        "ms (peor)": Math.max(...samples).toFixed(0),
      };
    }
    const timeouts = snapshot.commits.filter(
      (commit) => commit.settledBy === "timeout",
    ).length;
    // eslint-disable-next-line no-console
    console.log(
      `[perf] editCommitMs — de soltar a ver el cambio (paso 03)${timeouts > 0 ? ` · ${timeouts} sin resolver` : ""}`,
    );
    // eslint-disable-next-line no-console
    console.table(rows);
  }

  if (snapshot.ipcByCommand.length > 0) {
    const rows: Record<string, unknown> = {};
    for (const [command, calls, avgMs, worstMs, failures] of snapshot
      .ipcByCommand.slice(0, 12)) {
      rows[command] = {
        llamadas: calls,
        "media ms": avgMs.toFixed(1),
        "peor ms": worstMs.toFixed(1),
        "total ms": (calls * avgMs).toFixed(0),
        fallos: failures,
      };
    }
    // eslint-disable-next-line no-console
    console.log("[perf] IPC por comando (12 más costosos en total)");
    // eslint-disable-next-line no-console
    console.table(rows);
  }

  // eslint-disable-next-line no-console
  console.table({
    "rejilla (C6)": {
      construcciones: snapshot.gridBuilds,
      "entradas última": snapshot.gridEntries,
    },
    "tiles de onda (C4)": {
      rasterizados: snapshot.waveformTileRenders,
      "ms último segundo": snapshot.waveformTileMsLastSecond.toFixed(1),
      "peor tile ms": snapshot.waveformTileRenderWorstMs.toFixed(2),
    },
    "caché de tiles (C4d)": {
      entradas: snapshot.waveformTileCacheEntries,
      MiB: (snapshot.waveformTileCacheBytes / (1024 * 1024)).toFixed(1),
      "MiB pico": (
        snapshot.waveformTileCachePeakBytes /
        (1024 * 1024)
      ).toFixed(1),
    },
  });
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * Resumen compacto en TEXTO de las tres tablas del plan. Un par de KB frente a
 * los ~100 KB del JSON completo, así que se puede pegar entero donde sea.
 * Copia al portapapeles y lo devuelve.
 */
export function briefSummary(): string {
  const snapshot = readPerfSnapshot();
  const text = [
    "=== GESTOS ===",
    ...snapshot.gestures.map(
      (gesture) =>
        `${gesture.kind} moves=${gesture.moves} arrastre=${gesture.movedEnough} ` +
        `renders=${gesture.renders} tiles=${gesture.tileRenders} ` +
        `ms=${gesture.durationMs.toFixed(0)} ${JSON.stringify(gesture.rendersByComponent)}`,
    ),
    "",
    "=== COMMITS ===",
    ...snapshot.commits.map(
      (commit) =>
        `${commit.kind} ${commit.ms.toFixed(0)}ms (${commit.settledBy})`,
    ),
    "",
    "=== IPC ===",
    ...snapshot.ipcByCommand.map(
      ([command, calls, avgMs, worstMs, failures]) =>
        `${command} calls=${calls} avg=${avgMs.toFixed(1)} worst=${worstMs.toFixed(1)} fail=${failures}`,
    ),
  ].join("\n");

  // eslint-disable-next-line no-console
  console.log(text);
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => {});
  }
  return text;
}

export function clearRecording() {
  recordedSamples.length = 0;
  recordedMarkers.length = 0;
  // El protocolo del plan mide gesto a gesto: limpiar entre repeticiones tiene
  // que dejar también los contadores acumulados a cero, o la segunda medición
  // arrastra la primera.
  gestureReports.length = 0;
  commitReports.length = 0;
  openCommits = [];
  ipcByCommand.clear();
  renderCounts.clear();
  waveformTileRenderCount = 0;
  waveformTileCachePeakBytes = 0;
  gridBuildCount = 0;
  if (recordingStartedAt !== 0) {
    recordingStartedAt = performance.now();
  }
}

// ── Auto-markers ────────────────────────────────────────────────────────
//
// Listens on window for the actions most likely to cause UI lag (scroll,
// zoom via wheel+ctrl, mouse drags, keyboard play/pause) and records a
// marker so we can correlate metric dips with what the user was doing.
// Rate-limited per category so a long wheel gesture doesn't drown the
// buffer in 60 markers/second.

type AutoMarkerListeners = {
  onWheel: (event: WheelEvent) => void;
  onPointerDown: (event: PointerEvent) => void;
  onPointerMove: (event: PointerEvent) => void;
  onPointerUp: (event: PointerEvent) => void;
  /** pointercancel / blur: cierra el gesto sin leer nada del evento. */
  onCancel: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
};

/**
 * El zoom/pan con rueda no tiene pointerup que lo cierre, así que su gesto se
 * cierra por silencio. 250 ms es bastante más que el hueco entre notches de
 * una rueda o entre eventos de un trackpad, y bastante menos que la pausa
 * entre dos gestos deliberados.
 */
const WHEEL_GESTURE_IDLE_MS = 250;
let wheelGestureTimer: number | null = null;

function keepWheelGestureAlive(kind: string) {
  if (!started) return;
  if (activeGesture?.kind !== kind) {
    if (wheelGestureTimer !== null) window.clearTimeout(wheelGestureTimer);
    endGesture();
    beginGesture(kind);
  }
  if (activeGesture) {
    activeGesture.moves += 1;
    // La rueda no tiene umbral de píxeles: un solo notch YA es el gesto.
    activeGesture.movedEnough = true;
  }
  if (wheelGestureTimer !== null) window.clearTimeout(wheelGestureTimer);
  wheelGestureTimer = window.setTimeout(() => {
    wheelGestureTimer = null;
    endGesture();
  }, WHEEL_GESTURE_IDLE_MS);
}

let autoMarkerListeners: AutoMarkerListeners | null = null;
const lastMarkerByCategory: Record<string, number> = {};
const AUTO_MARKER_THROTTLE_MS = 200;

function recordCategoryMarker(category: string, label: string) {
  const now = performance.now();
  const last = lastMarkerByCategory[category] ?? 0;
  if (now - last < AUTO_MARKER_THROTTLE_MS) return;
  lastMarkerByCategory[category] = now;
  markEvent(label);
}

function describeTarget(target: EventTarget | null): string {
  if (!(target instanceof HTMLElement)) return "?";
  // Closest semantic class wins so we get a useful label even when the
  // pointer lands on a child span/svg.
  const interesting = target.closest(
    [
      ".lt-region-hotspot",
      ".lt-region-resize-handle",
      ".lt-marker-hotspot",
      // Los diamantes de automatización viven en el carril de pistas, no en el
      // ruler; sin esta entrada su arrastre no se detectaba como gesto.
      ".lt-automation-hotspot",
      ".lt-playhead",
      ".lt-track-lane",
      ".lt-track-header",
      ".lt-library-asset",
      ".lt-clip",
      ".lt-ruler",
    ].join(","),
  );
  if (interesting) {
    return (
      interesting.className.split(/\s+/).find((cls) => cls.startsWith("lt-")) ??
      interesting.tagName.toLowerCase()
    );
  }
  return target.tagName.toLowerCase();
}

function installAutoMarkers() {
  if (typeof window === "undefined" || autoMarkerListeners) return;

  const listeners: AutoMarkerListeners = {
    onWheel: (event) => {
      // El esquema Ableton hace zoom con ctrl/meta y el legacy sin ellos; para
      // el gesto sólo importa distinguir "eje horizontal" de "lo demás".
      const horizontal =
        event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
      keepWheelGestureAlive(horizontal ? "wheel-pan" : "wheel-zoom");

      if (event.ctrlKey) {
        recordCategoryMarker(
          "zoom",
          `zoom delta=${event.deltaY.toFixed(0)} target=${describeTarget(event.target)}`,
        );
      } else if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        recordCategoryMarker(
          "scroll-h",
          `scroll-h delta=${event.deltaX.toFixed(0)} target=${describeTarget(event.target)}`,
        );
      } else {
        recordCategoryMarker(
          "scroll-v",
          `scroll-v delta=${event.deltaY.toFixed(0)} target=${describeTarget(event.target)}`,
        );
      }
    },
    onPointerDown: (event) => {
      const targetClass = describeTarget(event.target);
      markEvent(`pointer-down button=${event.button} target=${targetClass}`);
      if (event.button !== 0) return;
      const kind = GESTURE_KIND_BY_CLASS[targetClass];
      if (kind) beginGesture(kind, event.clientX, event.clientY);
    },
    onPointerMove: (event) => {
      if (!activeGesture) return;
      activeGesture.moves += 1;
      if (activeGesture.movedEnough) return;
      const deltaX = event.clientX - activeGesture.startClientX;
      const deltaY = event.clientY - activeGesture.startClientY;
      if (Math.hypot(deltaX, deltaY) > GESTURE_DRAG_THRESHOLD_PX) {
        activeGesture.movedEnough = true;
      }
    },
    onPointerUp: (event) => {
      markEvent(
        `pointer-up button=${event.button} target=${describeTarget(event.target)}`,
      );
      endGesture();
    },
    onCancel: () => {
      endGesture();
    },
    onKeyDown: (event) => {
      // Only the high-signal shortcuts; otherwise typing in inputs would
      // flood the markers.
      if (event.code === "Space") {
        markEvent("key: space (play/pause)");
        return;
      }
      if (event.key.toLowerCase() === "z" && (event.ctrlKey || event.metaKey)) {
        markEvent(`key: ${event.shiftKey ? "redo" : "undo"}`);
        return;
      }
      if (/^Digit\d$/.test(event.code) || /^Numpad\d$/.test(event.code)) {
        markEvent(
          `key: ${event.shiftKey ? "shift+" : ""}${event.code} (region/marker jump)`,
        );
      }
    },
  };

  window.addEventListener("wheel", listeners.onWheel, {
    passive: true,
    capture: true,
  });
  // capture: true es OBLIGATORIO — ver la nota sobre stopPropagation arriba.
  window.addEventListener("pointerdown", listeners.onPointerDown, {
    passive: true,
    capture: true,
  });
  window.addEventListener("pointermove", listeners.onPointerMove, {
    passive: true,
    capture: true,
  });
  window.addEventListener("pointerup", listeners.onPointerUp, {
    passive: true,
    capture: true,
  });
  // Soltar fuera de la ventana, o perder el foco a media faena, tiene que
  // cerrar el gesto igual: si no, el siguiente arrastre heredaría su contador.
  window.addEventListener("pointercancel", listeners.onCancel, {
    passive: true,
    capture: true,
  });
  window.addEventListener("blur", listeners.onCancel);
  window.addEventListener("keydown", listeners.onKeyDown, { passive: true });
  autoMarkerListeners = listeners;
}

function uninstallAutoMarkers() {
  if (!autoMarkerListeners || typeof window === "undefined") return;
  // La bandera de captura tiene que coincidir con la del alta o no se quita.
  window.removeEventListener("wheel", autoMarkerListeners.onWheel, true);
  window.removeEventListener(
    "pointerdown",
    autoMarkerListeners.onPointerDown,
    true,
  );
  window.removeEventListener(
    "pointermove",
    autoMarkerListeners.onPointerMove,
    true,
  );
  window.removeEventListener("pointerup", autoMarkerListeners.onPointerUp, true);
  window.removeEventListener(
    "pointercancel",
    autoMarkerListeners.onCancel,
    true,
  );
  window.removeEventListener("blur", autoMarkerListeners.onCancel);
  window.removeEventListener("keydown", autoMarkerListeners.onKeyDown);
  autoMarkerListeners = null;
  if (wheelGestureTimer !== null) {
    window.clearTimeout(wheelGestureTimer);
    wheelGestureTimer = null;
  }
  activeGesture = null;
  for (const key of Object.keys(lastMarkerByCategory)) {
    delete lastMarkerByCategory[key];
  }
}

// ── Console handle ──────────────────────────────────────────────────────
//
// Exposes a `window.__lt_perf` object so users can run commands from the
// DevTools console without us having to ship UI for every operation.
//
//   __lt_perf.mark('about to scroll')
//   __lt_perf.download()        // exports lt-perf-recording.json
//   __lt_perf.dump()            // prints a summary table to the console
//   __lt_perf.clear()           // resets the buffer mid-session

function installConsoleHandle() {
  if (typeof window === "undefined") return;
  (window as unknown as { __lt_perf?: unknown }).__lt_perf = {
    mark: markEvent,
    download: downloadRecording,
    dump: dumpRecordingSummary,
    /** Sólo las tablas del plan, sin el resumen de fps/frames. */
    plan: dumpPlanSummary,
    /** Resumen compacto en texto, al portapapeles. Esto es lo que se pega. */
    brief: briefSummary,
    snapshot: readPerfSnapshot,
    clear: clearRecording,
  };
}

export function readPerfSnapshot(): PerfSnapshot {
  const sortedIpc = [...snapshotIpcSamples].sort((a, b) => a - b);
  const p99Index = Math.max(0, Math.ceil(sortedIpc.length * 0.99) - 1);
  return {
    fps: fpsEma,
    frameMs: frameTimeWindow[frameTimeWindow.length - 1] ?? 0,
    worstFrameMs: worstFrameMsLastSecond,
    renderCounts: [...renderCounts.entries()].sort(
      (left, right) => right[1] - left[1],
    ),
    snapshotIpcEma,
    snapshotIpcP99: sortedIpc[p99Index] ?? 0,
    snapshotCommitGapEma,
    canvasRenderEma,
    canvasRenderWorstMs: canvasRenderWorstLastSecond,
    canvasPaintCount,
    waveformTileRenders: waveformTileRenderCount,
    waveformTileRenderEma,
    waveformTileRenderWorstMs: waveformTileRenderWorstLastSecond,
    waveformTileMsLastSecond,
    tileDrainWorstMs: tileDrainWorstLastSecond,
    tileDrainMsLastSecond,
    waveformTileCacheEntries,
    waveformTileCacheBytes,
    waveformTileCachePeakBytes,
    gridBuilds: gridBuildCount,
    gridEntries: gridEntryCount,
    ipcByCommand: [...ipcByCommand.entries()]
      .map(
        ([command, stats]) =>
          [
            command,
            stats.calls,
            stats.calls > 0 ? stats.totalMs / stats.calls : 0,
            stats.worstMs,
            stats.failures,
          ] as [string, number, number, number, number],
      )
      // Por coste TOTAL (llamadas x media), que es lo que decide dónde se va
      // el tiempo: un comando barato llamado 100 veces importa más que uno
      // caro llamado una.
      .sort((left, right) => right[1] * right[2] - left[1] * left[2]),
    gestures: [...gestureReports].reverse(),
    commits: [...commitReports].reverse(),
    openCommits: openCommits.length,
  };
}
