import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelGatedFrame,
  markFrameActivity,
  requestGatedFrame,
  resetFrameGateForTests,
} from "./frameGate";
import { useTransportStore } from "./store";
import type { TransportSnapshot } from "./desktopApi";

// Un bucle como los del timeline: pide el siguiente fotograma en cada vuelta.
function startLoop(onFrame: () => void = () => {}) {
  let frames = 0;
  let id = 0;
  const tick = () => {
    frames += 1;
    onFrame();
    id = requestGatedFrame(tick);
  };
  id = requestGatedFrame(tick);
  return {
    frames: () => frames,
    stop: () => cancelGatedFrame(id),
  };
}

describe("frameGate", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"],
    });
    useTransportStore.setState({ playback: null });
    resetFrameGateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("parks an idle loop instead of spinning on every vsync", () => {
    const loop = startLoop();
    vi.advanceTimersByTime(2_000);
    // ~500 ms of frames, then nothing: at 60 Hz that is ~30, not ~120.
    expect(loop.frames()).toBeGreaterThan(20);
    expect(loop.frames()).toBeLessThan(40);
    const parkedAt = loop.frames();
    vi.advanceTimersByTime(5_000);
    expect(loop.frames()).toBe(parkedAt);
    loop.stop();
  });

  it("wakes a parked loop on user input", () => {
    const loop = startLoop();
    vi.advanceTimersByTime(2_000);
    const parkedAt = loop.frames();

    window.dispatchEvent(new Event("pointerdown"));
    vi.advanceTimersByTime(100);
    expect(loop.frames()).toBeGreaterThan(parkedAt);
    loop.stop();
  });

  it("keeps running while something keeps changing", () => {
    // A loop that paints every frame (an animation) never parks.
    const loop = startLoop(markFrameActivity);
    vi.advanceTimersByTime(3_000);
    expect(loop.frames()).toBeGreaterThan(150);
    loop.stop();
  });

  it("never parks while the transport is playing", () => {
    useTransportStore.setState({
      playback: { playbackState: "playing" } as TransportSnapshot,
    });
    const loop = startLoop();
    vi.advanceTimersByTime(3_000);
    expect(loop.frames()).toBeGreaterThan(150);
    loop.stop();
  });

  it("wakes on any transport store change", () => {
    const loop = startLoop();
    vi.advanceTimersByTime(2_000);
    const parkedAt = loop.frames();

    useTransportStore.setState({ meters: {} });
    vi.advanceTimersByTime(100);
    expect(loop.frames()).toBeGreaterThan(parkedAt);
    loop.stop();
  });

  it("cancelling with the id of a parked frame still works after it woke", () => {
    const loop = startLoop();
    vi.advanceTimersByTime(2_000);
    const parkedAt = loop.frames();

    // Wake it, then cancel before the frame runs: the caller only ever held
    // the parked id, and an unmounted loop must not come back to life.
    markFrameActivity();
    loop.stop();
    vi.advanceTimersByTime(1_000);
    expect(loop.frames()).toBe(parkedAt);
  });
});
