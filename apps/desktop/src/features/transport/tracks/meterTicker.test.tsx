import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSongStore } from "../songStore";
import { useMeterStore, type TrackMeterState } from "../meterStore";
import { meterTickerStats, registerMeter } from "./meterTicker";
import { TrackMeter } from "./TrackMeter";

/**
 * Paso 02 de `docs/plans/track-virtualization`: N medidores, un solo bucle de
 * animación y una sola suscripción al store.
 */

type FrameCallback = (now: number) => void;

/** rAF y reloj manuales: cada `frame()` avanza 16 ms y cuenta los rAF pedidos. */
function installManualFrames() {
  let queue: FrameCallback[] = [];
  let now = 1000;
  let requested = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameCallback) => {
    requested += 1;
    queue.push(callback);
    return requested;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    // Los handles son la posición de llamada: basta con vaciar si coincide.
    if (handle === requested) queue = [];
  });
  return {
    /** Ejecuta un frame; devuelve cuántos rAF se pidieron DURANTE él. */
    frame(stepMs = 16) {
      now += stepMs;
      const pending = queue;
      queue = [];
      const before = requested;
      pending.forEach((callback) => callback(now));
      return requested - before;
    },
    pending: () => queue.length,
  };
}

function meterDictionary(ids: string[], peak: number) {
  return Object.fromEntries(
    ids.map((id) => [id, { leftPeak: peak, rightPeak: peak }]),
  ) as Record<string, TrackMeterState>;
}

const trackIds = (count: number) =>
  Array.from({ length: count }, (_, index) => `track-${index}`);

beforeEach(() => {
  useMeterStore.setState({ meters: {}, regionMeters: {} });
  useSongStore.setState({ song: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("shared meter ticker", () => {
  it("runs ONE animation frame callback per frame for 20 moving meters", () => {
    const frames = installManualFrames();
    const ids = trackIds(20);
    render(
      <>
        {ids.map((id) => (
          <TrackMeter key={id} trackId={id} />
        ))}
      </>,
    );

    act(() => useMeterStore.setState({ meters: meterDictionary(ids, 0.8) }));
    // Todos reciben objetivo nuevo y quedan en movimiento (subiendo + pico).
    frames.frame();
    expect(frames.frame()).toBe(1);
    expect(frames.frame()).toBe(1);
  });

  it("only dispatches to the meter whose entry changed", () => {
    installManualFrames();
    const onA = vi.fn();
    const onB = vi.fn();
    const a = registerMeter({ source: "track", id: "a", onMeter: onA, step: () => false });
    const b = registerMeter({ source: "track", id: "b", onMeter: onB, step: () => false });
    try {
      useMeterStore.setState({ meters: meterDictionary(["a", "b"], 0.5) });
      onA.mockClear();
      onB.mockClear();

      useMeterStore.setState({
        meters: { a: { leftPeak: 0.9, rightPeak: 0.9 }, b: { leftPeak: 0.5, rightPeak: 0.5 } },
      });

      expect(onA).toHaveBeenCalledTimes(1);
      expect(onB).not.toHaveBeenCalled();
    } finally {
      a.unregister();
      b.unregister();
    }
  });

  it("subscribes to the meter store once, whatever the number of meters", () => {
    installManualFrames();
    const subscribe = vi.spyOn(useMeterStore, "subscribe");
    const ids = trackIds(20);
    const view = render(
      <>
        {ids.map((id) => (
          <TrackMeter key={id} trackId={id} />
        ))}
      </>,
    );

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(meterTickerStats().registered).toBe(20);
    view.unmount();
    expect(meterTickerStats()).toMatchObject({ registered: 0, subscribed: false });
  });

  it("stops scheduling frames once every meter is at rest", () => {
    const frames = installManualFrames();
    const ids = trackIds(5);
    render(
      <>
        {ids.map((id) => (
          <TrackMeter key={id} trackId={id} />
        ))}
      </>,
    );

    act(() => useMeterStore.setState({ meters: meterDictionary(ids, 0.8) }));
    frames.frame();
    act(() => useMeterStore.setState({ meters: meterDictionary(ids, 0) }));
    // Caída + retención del pico: unos segundos de frames bastan.
    for (let index = 0; index < 600 && frames.pending() > 0; index += 1) {
      frames.frame(16);
    }

    expect(frames.pending()).toBe(0);
    expect(meterTickerStats()).toMatchObject({ moving: 0, frameScheduled: false });
  });

  it("does not scan the song's tracks once per meter on a song edit", () => {
    installManualFrames();
    const ids = trackIds(100);
    let trackReads = 0;
    const songWithCountedTracks = (volume: number) => {
      const tracks = ids.map((id) => ({ id, monoDownmix: false, volume }));
      return {
        get tracks() {
          trackReads += 1;
          return tracks;
        },
      } as never;
    };
    useSongStore.setState({ song: songWithCountedTracks(1) });
    render(
      <>
        {ids.map((id) => (
          <TrackMeter key={id} trackId={id} />
        ))}
      </>,
    );

    trackReads = 0;
    // Cambiar el volumen de una pista publica una canción nueva.
    act(() => useSongStore.setState({ song: songWithCountedTracks(0.5) }));

    expect(trackReads).toBe(1);
  });
});
