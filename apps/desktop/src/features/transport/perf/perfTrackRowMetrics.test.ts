import { afterEach, describe, expect, it, vi } from "vitest";

import {
  briefSummary,
  readPerfSnapshot,
  readTrackDomCounts,
  recordMeterTick,
  recordRender,
  startPerfMetrics,
  stopPerfMetrics,
} from "./perfMetrics";

/**
 * Contadores del plan `docs/plans/completed/track-virtualization` (paso 01).
 *
 * Igual que los del plan de UI: lo que protegen es que el banco mida algo y
 * que fuera del build de medición no cueste nada.
 */

type FrameCallback = (now: number) => void;

/** rAF manual: el bucle del HUD sólo avanza cuando el test lo pide. */
function installManualRaf() {
  let queue: FrameCallback[] = [];
  let now = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameCallback) => {
    queue.push(callback);
    return queue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return {
    frame() {
      now += 16;
      const pending = queue;
      queue = [];
      pending.forEach((callback) => callback(now));
    },
  };
}

function mountRows(className: string, count: number) {
  for (let index = 0; index < count; index += 1) {
    const row = document.createElement("div");
    row.className = className;
    document.body.appendChild(row);
  }
}

afterEach(() => {
  stopPerfMetrics();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("track-virtualization counters", () => {
  it("counts meter ticks per HUD frame (average and max over the window)", () => {
    const raf = installManualRaf();
    startPerfMetrics();

    // Frame 1: 20 medidores animándose. Frame 2: 4.
    for (let index = 0; index < 20; index += 1) recordMeterTick();
    raf.frame();
    for (let index = 0; index < 4; index += 1) recordMeterTick();
    raf.frame();

    const snapshot = readPerfSnapshot();
    expect(snapshot.meterTicksPerFrameMax).toBe(20);
    expect(snapshot.meterTicksPerFrameAvg).toBe(12);
  });

  it("reads TrackHeadersPane renders from the render counts", () => {
    installManualRaf();
    startPerfMetrics();
    recordRender("TrackHeadersPane");
    recordRender("TrackHeadersPane");
    recordRender("TimelineCanvasPane");

    expect(readPerfSnapshot().trackPaneRenders).toBe(2);
  });

  it("samples mounted header and lane rows and DOM nodes on demand", () => {
    installManualRaf();
    startPerfMetrics();
    mountRows("lt-track-header-row", 7);
    mountRows("lt-track-lane-row", 5);

    const counts = readTrackDomCounts();
    expect(counts.headerRowsMounted).toBe(7);
    expect(counts.laneRowsMounted).toBe(5);
    expect(counts.domNodes).toBeGreaterThanOrEqual(12);

    vi.spyOn(console, "log").mockImplementation(() => {});
    const text = briefSummary();
    expect(text).toContain("headerRowsMounted=7");
    expect(text).toContain("laneRowsMounted=5");
  });

  it("records nothing before the HUD starts", () => {
    installManualRaf();
    mountRows("lt-track-header-row", 3);
    recordMeterTick();
    recordRender("TrackHeadersPane");

    const snapshot = readPerfSnapshot();
    expect(snapshot.meterTicksPerFrameMax).toBe(0);
    expect(snapshot.trackPaneRenders).toBe(0);
    expect(readTrackDomCounts().headerRowsMounted).toBe(0);
  });

  it("never starts outside the measurement build", () => {
    const raf = installManualRaf();
    // Build de release normal: ni DEV ni __LT_DEBUG_BUILD.
    vi.stubEnv("DEV", false);
    startPerfMetrics();
    mountRows("lt-track-header-row", 3);
    recordMeterTick();
    raf.frame();

    expect(readPerfSnapshot().meterTicksPerFrameMax).toBe(0);
    expect(readTrackDomCounts().headerRowsMounted).toBe(0);
  });
});
