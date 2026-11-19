// @vitest-environment jsdom
import { Profiler } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TrackEq, TrackSummary } from "@libretracks/shared/models";

const platform = { isMobileApp: false };

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && "number" in options ? `${key}:${String(options.number)}` : key,
  }),
}));

vi.mock("@libretracks/shared/desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@libretracks/shared/desktopApi")>()),
  get isMobileApp() {
    return platform.isMobileApp;
  },
}));

import { TrackEqEditor, bandSampleFrequencies, curvePath, gainToY } from "./TrackEqEditor";
import { trackEqResponseDb } from "./eqResponse";
import { defaultTrackEq } from "./trackEqModel";
import type { TrackEqHandlers } from "../tracks/trackEqHandlers";

function makeHandlers() {
  return {
    open: vi.fn((_trackId: string) => undefined),
    close: vi.fn(() => undefined),
    applyLive: vi.fn((_trackId: string, _eq: TrackEq | null) => undefined),
    commit: vi.fn(async (_trackId: string, _eq: TrackEq | null) => undefined),
    toggleBypass: vi.fn(async (_trackId: string) => undefined),
    reset: vi.fn(async (_trackId: string) => undefined),
    remove: vi.fn(async (_trackId: string) => undefined),
    startAnalyzer: vi.fn((_trackId: string) => undefined),
    stopAnalyzer: vi.fn(() => undefined),
    readSpectrum: vi.fn(async () => [-90, -60, -30, -12, -40, -80] as number[]),
  } satisfies TrackEqHandlers;
}

function makeTrack(eq: TrackEq | null = defaultTrackEq()): TrackSummary {
  return {
    id: "t1",
    name: "Bajo",
    kind: "audio",
    depth: 0,
    hasChildren: false,
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
    audioTo: "master",
    transposeEnabled: true,
    eq,
  };
}

// jsdom no tiene PointerEvent: un MouseEvent con pointerId hace de puntero
// (project_jsdom_no_pointer_event).
function pointer(target: Element, type: string, clientX: number, clientY: number, shiftKey = false) {
  const event = new MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true, shiftKey });
  Object.defineProperty(event, "pointerId", { value: 1 });
  fireEvent(target, event);
}

let frames: FrameRequestCallback[] = [];
function flushFrames() {
  const pending = frames;
  frames = [];
  act(() => pending.forEach((callback) => callback(0)));
}

beforeEach(() => {
  platform.isMobileApp = false;
  frames = [];
  window.localStorage.clear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frames = [];
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("TrackEqEditor drag", () => {
  it("one node drag: one commit, at most one live send per frame and no render per move", () => {
    const handlers = makeHandlers();
    let renders = 0;
    render(
      <Profiler id="eq" onRender={() => (renders += 1)}>
        <TrackEqEditor track={makeTrack()} handlers={handlers} />
      </Profiler>,
    );
    const node = screen.getByTestId("lt-eq-node-3");
    pointer(node, "pointerdown", 300, 110);
    const rendersAfterDown = renders;
    for (let i = 1; i <= 20; i += 1) {
      pointer(node, "pointermove", 300 + i * 5, 110 - i * 2);
      flushFrames();
    }
    expect(renders).toBe(rendersAfterDown);
    expect(handlers.applyLive.mock.calls.length).toBeGreaterThan(0);
    expect(handlers.applyLive.mock.calls.length).toBeLessThanOrEqual(20);
    expect(handlers.commit).not.toHaveBeenCalled();

    pointer(node, "pointerup", 400, 70);
    expect(handlers.commit).toHaveBeenCalledTimes(1);
    const [trackId, eq] = handlers.commit.mock.calls[0] as [string, TrackEq];
    expect(trackId).toBe("t1");
    expect(eq.bands[2].frequencyHz).toBeGreaterThan(400);
    expect(eq.bands[2].gainDb).toBeGreaterThan(0);
    // El nodo que el lector de pantalla anuncia ya cuenta lo nuevo.
    expect(node.getAttribute("aria-valuetext")).toContain("+");
  });

  it("moves inside one frame produce a single live send", () => {
    const handlers = makeHandlers();
    render(<TrackEqEditor track={makeTrack()} handlers={handlers} />);
    const node = screen.getByTestId("lt-eq-node-2");
    pointer(node, "pointerdown", 100, 110);
    for (let i = 1; i <= 20; i += 1) pointer(node, "pointermove", 100 + i, 110 - i);
    flushFrames();
    expect(handlers.applyLive).toHaveBeenCalledTimes(1);
    pointer(node, "pointerup", 120, 90);
    expect(handlers.commit).toHaveBeenCalledTimes(1);
  });

  it("a click without moving does not commit", () => {
    const handlers = makeHandlers();
    render(<TrackEqEditor track={makeTrack()} handlers={handlers} />);
    const node = screen.getByTestId("lt-eq-node-4");
    pointer(node, "pointerdown", 200, 110);
    pointer(node, "pointerup", 200, 110);
    expect(handlers.commit).not.toHaveBeenCalled();
  });

  it("vertical drag on a cut changes only its frequency", () => {
    const handlers = makeHandlers();
    render(<TrackEqEditor track={makeTrack()} handlers={handlers} />);
    const node = screen.getByTestId("lt-eq-node-1");
    pointer(node, "pointerdown", 50, 110);
    pointer(node, "pointermove", 80, 10);
    pointer(node, "pointerup", 80, 10);
    const eq = handlers.commit.mock.calls[0][1] as TrackEq;
    expect(eq.bands[0].gainDb).toBe(0);
    expect(eq.bands[0].frequencyHz).toBeGreaterThan(40);
  });

  it("double click toggles the band", () => {
    const handlers = makeHandlers();
    render(<TrackEqEditor track={makeTrack()} handlers={handlers} />);
    fireEvent.doubleClick(screen.getByTestId("lt-eq-node-1"));
    const eq = handlers.commit.mock.calls[0][1] as TrackEq;
    expect(eq.bands[0].enabled).toBe(true);
  });
});

describe("TrackEqEditor Q with the wheel and the model", () => {
  it("a node grabbed right after the wheel keeps the new Q", () => {
    const handlers = makeHandlers();
    render(<TrackEqEditor track={makeTrack()} handlers={handlers} />);
    const node = screen.getByTestId("lt-eq-node-3");
    fireEvent.focus(node);
    const graph = screen.getByTestId("lt-eq-graph");
    for (let i = 0; i < 10; i += 1) fireEvent.wheel(graph, { deltaY: -100 });
    // Antes de que la rueda haga su commit, se agarra el nodo y se mueve.
    pointer(node, "pointerdown", 300, 110);
    pointer(node, "pointermove", 340, 110);
    pointer(node, "pointerup", 340, 110);
    expect(handlers.commit).toHaveBeenCalledTimes(1);
    const eq = handlers.commit.mock.calls[0][1] as TrackEq;
    expect(eq.bands[2].q).toBeGreaterThan(2);
  });

  it("a late model from an earlier commit does not move the band back", async () => {
    let finish: () => void = () => undefined;
    const handlers = makeHandlers();
    handlers.commit.mockImplementation(
      () => new Promise<undefined>((resolve) => (finish = () => resolve(undefined))),
    );
    const first = defaultTrackEq();
    const { rerender } = render(<TrackEqEditor track={makeTrack(first)} handlers={handlers} />);
    const node = screen.getByTestId("lt-eq-node-3");
    pointer(node, "pointerdown", 300, 110);
    pointer(node, "pointermove", 360, 60);
    pointer(node, "pointerup", 360, 60);
    const sent = handlers.commit.mock.calls[0][1] as TrackEq;
    // Llega un modelo viejo (p. ej. el de un commit anterior) con el nuestro en vuelo.
    const stale = defaultTrackEq();
    stale.bands[2].q = 5;
    rerender(<TrackEqEditor track={makeTrack(stale)} handlers={handlers} />);
    expect(node.getAttribute("aria-valuenow")).toBe(String(Math.round(sent.bands[2].frequencyHz)));
    // Con todo de vuelta, el modelo vuelve a mandar.
    rerender(<TrackEqEditor track={makeTrack(sent)} handlers={handlers} />);
    await act(async () => finish());
    expect(node.getAttribute("aria-valuenow")).toBe(String(Math.round(sent.bands[2].frequencyHz)));
  });

  it("a narrow bell is drawn up to its gain", () => {
    const eq = defaultTrackEq();
    eq.bands[2] = { ...eq.bands[2], enabled: true, gainDb: 18, q: 18, frequencyHz: 295.2 };
    const peak = Math.min(
      ...[...curvePath((hz) => trackEqResponseDb(eq, 48000, hz), bandSampleFrequencies(eq.bands))
        .matchAll(/[ML][\d.]+ (-?[\d.]+)/g)].map((m) => Number(m[1])),
    );
    // Sin las muestras de la banda, el pico se quedaba muy por debajo de +18 dB.
    expect(peak).toBeLessThan(gainToY(17));
  });
});

describe("TrackEqEditor keyboard fields", () => {
  it("each field edit commits once and clamps like the core", () => {
    const handlers = makeHandlers();
    render(<TrackEqEditor track={makeTrack()} handlers={handlers} />);

    const freq = screen.getByLabelText("eq.frequencyOf:3");
    fireEvent.change(freq, { target: { value: "50000" } });
    fireEvent.keyDown(freq, { key: "Enter" });
    expect(handlers.commit).toHaveBeenCalledTimes(1);
    expect((handlers.commit.mock.calls[0][1] as TrackEq).bands[2].frequencyHz).toBe(20000);
    fireEvent.blur(freq); // mismo valor: no repite
    expect(handlers.commit).toHaveBeenCalledTimes(1);

    const gain = screen.getByLabelText("eq.gainOf:2");
    fireEvent.change(gain, { target: { value: "-40" } });
    fireEvent.blur(gain);
    expect(handlers.commit).toHaveBeenCalledTimes(2);
    expect((handlers.commit.mock.calls[1][1] as TrackEq).bands[1].gainDb).toBe(-18);

    const q = screen.getByLabelText("eq.qOf:4");
    fireEvent.change(q, { target: { value: "0,01" } });
    fireEvent.keyDown(q, { key: "Enter" });
    expect((handlers.commit.mock.calls[2][1] as TrackEq).bands[3].q).toBe(0.1);

    const bogus = screen.getByLabelText("eq.qOf:5");
    fireEvent.change(bogus, { target: { value: "abc" } });
    fireEvent.blur(bogus);
    expect(handlers.commit).toHaveBeenCalledTimes(3);
  });

  it("cuts show the slope and no gain; bells show gain and no slope", () => {
    render(<TrackEqEditor track={makeTrack()} handlers={makeHandlers()} />);
    expect(screen.getByLabelText("eq.slopeOf:1")).toBeTruthy();
    expect(screen.queryByLabelText("eq.gainOf:1")).toBeNull();
    expect(screen.getByLabelText("eq.gainOf:3")).toBeTruthy();
    expect(screen.queryByLabelText("eq.slopeOf:3")).toBeNull();
  });
});

describe("TrackEqEditor buttons", () => {
  it("bypass, reset, remove and close call their handlers", () => {
    const handlers = makeHandlers();
    render(<TrackEqEditor track={makeTrack()} handlers={handlers} />);
    fireEvent.click(screen.getByText("eq.bypass"));
    // El bypass sale del borrador del editor, no del modelo.
    expect(handlers.commit).toHaveBeenCalledTimes(1);
    expect((handlers.commit.mock.calls[0][1] as TrackEq).enabled).toBe(false);
    fireEvent.click(screen.getByText("eq.reset"));
    expect(handlers.reset).toHaveBeenCalledWith("t1");
    fireEvent.click(screen.getByText("eq.remove"));
    expect(handlers.remove).toHaveBeenCalledWith("t1");
    fireEvent.click(screen.getByLabelText("eq.close"));
    expect(handlers.close).toHaveBeenCalled();
  });

  it("a track without eq opens on the default bands", () => {
    render(<TrackEqEditor track={makeTrack(null)} handlers={makeHandlers()} />);
    expect(screen.getAllByRole("slider")).toHaveLength(6);
  });
});

function touch(target: Element, type: string, points: [number, number][]) {
  const touches = points.map(([clientX, clientY], identifier) => ({ clientX, clientY, identifier }));
  fireEvent(
    target,
    Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      touches,
      targetTouches: touches,
      changedTouches: touches,
    }),
  );
}

describe("TrackEqEditor pinch", () => {
  it("on a phone a pinch changes the Q and commits once", () => {
    platform.isMobileApp = true;
    const handlers = makeHandlers();
    render(<TrackEqEditor track={makeTrack()} handlers={handlers} />);
    fireEvent.focus(screen.getByTestId("lt-eq-node-3"));
    const graph = screen.getByTestId("lt-eq-graph");
    touch(graph, "touchstart", [[100, 100], [140, 100]]);
    touch(graph, "touchmove", [[80, 100], [160, 100]]);
    flushFrames();
    touch(graph, "touchend", []);
    expect(handlers.commit).toHaveBeenCalledTimes(1);
    const eq = handlers.commit.mock.calls[0][1] as TrackEq;
    expect(eq.bands[2].q).toBeCloseTo(1.42, 2);
  });

  it("on the desktop there are no touch handlers: a pinch does nothing", () => {
    const handlers = makeHandlers();
    render(<TrackEqEditor track={makeTrack()} handlers={handlers} />);
    const graph = screen.getByTestId("lt-eq-graph");
    touch(graph, "touchstart", [[100, 100], [140, 100]]);
    touch(graph, "touchmove", [[80, 100], [160, 100]]);
    flushFrames();
    touch(graph, "touchend", []);
    expect(handlers.commit).not.toHaveBeenCalled();
    expect(handlers.applyLive).not.toHaveBeenCalled();
  });
});

describe("TrackEqEditor RTA", () => {
  it("analyzes the open track, paints the spectrum without re-rendering and stops on close", async () => {
    const handlers = makeHandlers();
    let renders = 0;
    const { unmount } = render(
      <Profiler id="eq" onRender={() => (renders += 1)}>
        <TrackEqEditor track={makeTrack()} handlers={handlers} />
      </Profiler>,
    );
    expect(handlers.startAnalyzer).toHaveBeenCalledWith("t1");
    const before = renders;
    for (let i = 0; i < 3; i += 1) {
      flushFrames();
      await act(async () => undefined);
    }
    expect(handlers.readSpectrum).toHaveBeenCalled();
    expect(screen.getByTestId("lt-eq-spectrum").getAttribute("d")).toMatch(/^M0 .*Z$/);
    expect(renders).toBe(before);
    unmount();
    expect(handlers.stopAnalyzer).toHaveBeenCalled();
  });

  it("the RTA button turns the analyzer off and remembers it", async () => {
    const handlers = makeHandlers();
    render(<TrackEqEditor track={makeTrack()} handlers={handlers} />);
    const button = screen.getByText("eq.rta");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(handlers.stopAnalyzer).toHaveBeenCalledTimes(1);
    handlers.readSpectrum.mockClear();
    flushFrames();
    await act(async () => undefined);
    expect(handlers.readSpectrum).not.toHaveBeenCalled();
    expect(screen.getByTestId("lt-eq-spectrum").getAttribute("d")).toBe("");
    cleanup();
    const again = makeHandlers();
    render(<TrackEqEditor track={makeTrack()} handlers={again} />);
    expect(again.startAnalyzer).not.toHaveBeenCalled();
  });
});
