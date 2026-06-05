import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isPerfHudEnabled,
  readPerfSnapshot,
  recordRender,
  recordSnapshotIpc,
  setPerfHudEnabled,
  startPerfMetrics,
  stopPerfMetrics,
} from "./perfMetrics";

// Instrumentation is gated on import.meta.env.DEV (true under vitest), so the
// HUD flag round-trips through localStorage here.

afterEach(() => {
  stopPerfMetrics();
  window.localStorage.clear();
});

describe("perf HUD flag", () => {
  it("defaults to disabled", () => {
    expect(isPerfHudEnabled()).toBe(false);
  });

  it("round-trips through localStorage", () => {
    setPerfHudEnabled(true);
    expect(window.localStorage.getItem("lt:perf:hud")).toBe("1");
    expect(isPerfHudEnabled()).toBe(true);
    setPerfHudEnabled(false);
    expect(window.localStorage.getItem("lt:perf:hud")).toBeNull();
    expect(isPerfHudEnabled()).toBe(false);
  });
});

describe("recording is a no-op until started", () => {
  it("ignores recordRender / recordSnapshotIpc before start", () => {
    recordRender("Foo");
    recordSnapshotIpc(5);
    const snap = readPerfSnapshot();
    expect(snap.renderCounts).toEqual([]);
    expect(snap.snapshotIpcEma).toBe(0);
  });
});

describe("readPerfSnapshot", () => {
  it("returns the documented shape with numeric fields", () => {
    const snap = readPerfSnapshot();
    expect(typeof snap.fps).toBe("number");
    expect(typeof snap.frameMs).toBe("number");
    expect(typeof snap.worstFrameMs).toBe("number");
    expect(Array.isArray(snap.renderCounts)).toBe(true);
    expect(typeof snap.snapshotIpcP99).toBe("number");
    expect(typeof snap.canvasPaintCount).toBe("number");
  });
});

describe("after startPerfMetrics", () => {
  beforeEach(() => {
    startPerfMetrics();
  });

  it("accumulates render counts sorted by frequency", () => {
    recordRender("A");
    recordRender("A");
    recordRender("B");
    const counts = Object.fromEntries(readPerfSnapshot().renderCounts);
    expect(counts).toEqual({ A: 2, B: 1 });
    // Most-rendered component sorts first.
    expect(readPerfSnapshot().renderCounts[0][0]).toBe("A");
  });

  it("tracks an EMA of snapshot IPC cost", () => {
    recordSnapshotIpc(10);
    expect(readPerfSnapshot().snapshotIpcEma).toBeCloseTo(10, 6);
    recordSnapshotIpc(20);
    // EMA = 10 * 0.8 + 20 * 0.2 = 12.
    expect(readPerfSnapshot().snapshotIpcEma).toBeCloseTo(12, 6);
  });

  it("clears accumulated state on stop", () => {
    recordRender("A");
    recordSnapshotIpc(10);
    stopPerfMetrics();
    const snap = readPerfSnapshot();
    expect(snap.renderCounts).toEqual([]);
    expect(snap.snapshotIpcEma).toBe(0);
  });
});
