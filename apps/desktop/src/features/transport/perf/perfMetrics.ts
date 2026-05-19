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
let canvasPaintCount = 0; // monotonic; lets the HUD distinguish "0 because idle" from "0 because instrumentation is broken"

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
  canvasPaintCount: number;
};

export function recordCanvasRender(ms: number) {
  if (!started) return;
  canvasPaintCount += 1;
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
  return {
    capturedAt: new Date().toISOString(),
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
}

export function clearRecording() {
  recordedSamples.length = 0;
  recordedMarkers.length = 0;
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
  onPointerUp: (event: PointerEvent) => void;
  onKeyDown: (event: KeyboardEvent) => void;
};

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
      ".lt-playhead",
      ".lt-track-lane",
      ".lt-track-header",
      ".lt-library-asset",
      ".lt-clip",
      ".lt-ruler",
    ].join(","),
  );
  if (interesting) {
    return interesting.className
      .split(/\s+/)
      .find((cls) => cls.startsWith("lt-")) ?? interesting.tagName.toLowerCase();
  }
  return target.tagName.toLowerCase();
}

function installAutoMarkers() {
  if (typeof window === "undefined" || autoMarkerListeners) return;

  const listeners: AutoMarkerListeners = {
    onWheel: (event) => {
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
      markEvent(
        `pointer-down button=${event.button} target=${describeTarget(event.target)}`,
      );
    },
    onPointerUp: (event) => {
      markEvent(
        `pointer-up button=${event.button} target=${describeTarget(event.target)}`,
      );
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

  window.addEventListener("wheel", listeners.onWheel, { passive: true });
  window.addEventListener("pointerdown", listeners.onPointerDown, { passive: true });
  window.addEventListener("pointerup", listeners.onPointerUp, { passive: true });
  window.addEventListener("keydown", listeners.onKeyDown, { passive: true });
  autoMarkerListeners = listeners;
}

function uninstallAutoMarkers() {
  if (!autoMarkerListeners || typeof window === "undefined") return;
  window.removeEventListener("wheel", autoMarkerListeners.onWheel);
  window.removeEventListener("pointerdown", autoMarkerListeners.onPointerDown);
  window.removeEventListener("pointerup", autoMarkerListeners.onPointerUp);
  window.removeEventListener("keydown", autoMarkerListeners.onKeyDown);
  autoMarkerListeners = null;
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
    renderCounts: [...renderCounts.entries()].sort((left, right) => right[1] - left[1]),
    snapshotIpcEma,
    snapshotIpcP99: sortedIpc[p99Index] ?? 0,
    snapshotCommitGapEma,
    canvasRenderEma,
    canvasRenderWorstMs: canvasRenderWorstLastSecond,
    canvasPaintCount,
  };
}
