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

const STORAGE_KEY = "lt:perf:hud";

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

export function isPerfHudEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setPerfHudEnabled(enabled: boolean) {
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
  if (started || typeof window === "undefined") return;
  started = true;
  lastFrameTime = performance.now();
  frameWindowStart = lastFrameTime;
  rafId = window.requestAnimationFrame(tick);
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

  rafId = window.requestAnimationFrame(tick);
}

export function recordRender(componentName: string) {
  if (!started) return;
  renderCounts.set(componentName, (renderCounts.get(componentName) ?? 0) + 1);
}

export function recordSnapshotIpc(ms: number) {
  if (!started) return;
  snapshotIpcSamples.push(ms);
  if (snapshotIpcSamples.length > SNAPSHOT_SAMPLE_SIZE) snapshotIpcSamples.shift();
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
};

export function recordCanvasRender(ms: number) {
  if (!started) return;
  canvasRenderEma = canvasRenderEma === 0 ? ms : canvasRenderEma * 0.85 + ms * 0.15;
  if (ms > canvasRenderWorstThisSecond) canvasRenderWorstThisSecond = ms;
  const now = performance.now();
  if (canvasRenderWindowStart === 0) canvasRenderWindowStart = now;
  if (now - canvasRenderWindowStart >= 1000) {
    canvasRenderWorstLastSecond = canvasRenderWorstThisSecond;
    canvasRenderWorstThisSecond = 0;
    canvasRenderWindowStart = now;
  }
}

export function readPerfSnapshot(): PerfSnapshot {
  const sortedIpc = [...snapshotIpcSamples].sort((a, b) => a - b);
  const p99Index = Math.max(0, Math.ceil(sortedIpc.length * 0.99) - 1);
  return {
    fps: fpsEma,
    frameMs: frameTimeWindow[frameTimeWindow.length - 1] ?? 0,
    worstFrameMs: worstFrameMsLastSecond,
    renderCounts: [...renderCounts.entries()].sort((left, right) => right[1] - left[1]),
    snapshotIpcEma,
    snapshotIpcP99: sortedIpc[p99Index] ?? 0,
    snapshotCommitGapEma,
    canvasRenderEma,
    canvasRenderWorstMs: canvasRenderWorstLastSecond,
  };
}
