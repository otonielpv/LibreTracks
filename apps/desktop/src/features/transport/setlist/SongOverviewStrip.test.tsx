import { act, fireEvent, render } from "@testing-library/react";
import { Profiler, type ComponentProps } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClipSummary, WaveformSummaryDto } from "@libretracks/shared/models";

import { resetFrameGateForTests } from "../frameGate";
import { FOLLOW_CAMERA_MANUAL_PAUSE_MS } from "../followCamera";
import { useTransportStore } from "../store";
import { OverviewZoom, ZoomWindowContext } from "./OverviewZoom";
import { drawWindowFor, SongOverviewStrip } from "./SongOverviewStrip";
import { testRegion } from "./testBindings";
import { INITIAL_SETLIST_STATE, useSetlistStore } from "./setlistStore";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const peaksSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("./songOverviewPeaks", async (importOriginal) => {
  const original = await importOriginal<typeof import("./songOverviewPeaks")>();
  return {
    ...original,
    buildSongOverviewPeaks: (...args: Parameters<typeof original.buildSongOverviewPeaks>) => {
      peaksSpy.calls += 1;
      return original.buildSongOverviewPeaks(...args);
    },
  };
});

// Song from 100 s to 200 s drawn 1000 px wide: 10 px per second.
const region = testRegion("r1", { name: "Canción", startSeconds: 100, endSeconds: 200 });
const WIDTH = 1000;

const clip = (overrides: Partial<ClipSummary> = {}): ClipSummary => ({
  id: "c1",
  trackId: "t",
  trackName: "t",
  filePath: "a.wav",
  waveformKey: "a",
  isMissing: false,
  timelineStartSeconds: 100,
  sourceStartSeconds: 0,
  sourceWindowDurationSeconds: 100,
  sourceDurationSeconds: 100,
  durationSeconds: 100,
  gain: 1,
  ...overrides,
});
const summaries: Record<string, WaveformSummaryDto> = {
  a: {
    waveformKey: "a",
    version: 1,
    durationSeconds: 100,
    sampleRate: 10,
    lods: [{ resolutionFrames: 10, bucketCount: 100, maxPeaks: new Array(100).fill(0.5), minPeaks: new Array(100).fill(-0.5) }],
  },
};

type StripProps = ComponentProps<typeof SongOverviewStrip>;
const stripProps = (overrides: Partial<StripProps> = {}): StripProps => ({
  region,
  clips: [clip()],
  sectionMarkers: [],
  waveformSummaries: summaries,
  positionSecondsRef: { current: 0 },
  layout: "wide",
  onSeek: vi.fn(),
  ...overrides,
});

class FakeResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe() {
    this.callback(
      [{ contentRect: { width: WIDTH, height: 80 } } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  disconnect() {}
}

let frames: FrameRequestCallback[] = [];
const runFrames = () => {
  const pending = frames;
  frames = [];
  act(() => {
    for (const callback of pending) callback(0);
  });
};

function layOut(container: HTMLElement, getOffset: () => number = () => 0) {
  const root = container.querySelector<HTMLElement>(".lt-setlist-overview")!;
  root.getBoundingClientRect = () => {
    const left = 50 - getOffset();
    return { left, top: 0, width: WIDTH, height: 80, right: left + WIDTH, bottom: 80 } as DOMRect;
  };
  Object.defineProperty(root, "offsetWidth", { configurable: true, value: WIDTH });
  return root;
}

const originalPointerEvent = window.PointerEvent;
beforeAll(() => {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  Object.defineProperty(window, "PointerEvent", { configurable: true, value: TestPointerEvent });
});
afterAll(() => {
  Object.defineProperty(window, "PointerEvent", { configurable: true, value: originalPointerEvent });
});

beforeEach(() => {
  frames = [];
  peaksSpy.calls = 0;
  useSetlistStore.setState(INITIAL_SETLIST_STATE);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  resetFrameGateForTests();
  useTransportStore.setState({ playback: { playbackState: "playing" } as never });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SongOverviewStrip playhead", () => {
  it("moves by rAF with 0 renders, hidden outside the song", () => {
    const positionSecondsRef = { current: 90 };
    let renders = 0;
    const { container } = render(
      <Profiler id="strip" onRender={() => (renders += 1)}>
        <SongOverviewStrip {...stripProps({ positionSecondsRef })} />
      </Profiler>,
    );
    const playhead = container.querySelector<HTMLElement>(".lt-setlist-overview-playhead")!;
    runFrames();
    expect(playhead.style.visibility).toBe("hidden");
    const baseline = renders;

    positionSecondsRef.current = 125;
    runFrames();
    expect(playhead.style.visibility).toBe("visible");
    expect(playhead.style.transform).toBe("translate3d(250px, 0, 0)");
    positionSecondsRef.current = 150;
    runFrames();
    expect(playhead.style.transform).toBe("translate3d(500px, 0, 0)");
    expect(renders).toBe(baseline);
  });
});

describe("OverviewZoom playhead follow", () => {
  it("keeps a manual pan while active, then returns to the playhead after inactivity", () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    useSetlistStore.setState({ overviewZoom: 4 });
    const positionSecondsRef = { current: 150 };
    const { container } = render(
      <OverviewZoom
        startSeconds={100}
        endSeconds={200}
        positionSecondsRef={positionSecondsRef}
      >
        <div />
      </OverviewZoom>,
    );
    const viewport = container.querySelector<HTMLElement>(
      ".lt-setlist-zoom-viewport",
    )!;
    Object.defineProperty(viewport, "clientWidth", {
      configurable: true,
      value: 250,
    });
    const layer = container.querySelector<HTMLElement>(
      ".lt-setlist-zoom-layer",
    )!;
    runFrames();
    expect(layer.style.transform).toBe("translate3d(-375px, 0, 0)");

    vi.mocked(performance.now).mockReturnValue(1_000);
    fireEvent.wheel(viewport, { deltaY: 120 });
    expect(layer.style.transform).toBe("translate3d(-495px, 0, 0)");

    positionSecondsRef.current = 160;
    vi.mocked(performance.now).mockReturnValue(
      1_000 + FOLLOW_CAMERA_MANUAL_PAUSE_MS - 1,
    );
    runFrames();
    expect(layer.style.transform).toBe("translate3d(-495px, 0, 0)");

    vi.mocked(performance.now).mockReturnValue(
      1_000 + FOLLOW_CAMERA_MANUAL_PAUSE_MS,
    );
    runFrames();
    expect(layer.style.transform).toBe("translate3d(-475px, 0, 0)");
  });
});

describe("SongOverviewStrip peaks", () => {
  it("are computed once per clip change, not per parent render", () => {
    const props = stripProps();
    const { rerender } = render(<SongOverviewStrip {...props} />);
    const afterMount = peaksSpy.calls;
    expect(afterMount).toBeGreaterThan(0);

    rerender(<SongOverviewStrip {...props} clips={[clip()]} />);
    rerender(<SongOverviewStrip {...props} clips={[clip({ gain: 0.3 })]} />);
    expect(peaksSpy.calls).toBe(afterMount);

    rerender(<SongOverviewStrip {...props} clips={[clip({ timelineStartSeconds: 120 })]} />);
    expect(peaksSpy.calls).toBe(afterMount + 1);
  });
});

describe("SongOverviewStrip seek", () => {
  it.each(["wide", "medium", "short"] as const)("%s: edit surfaces seek on a stationary click", (layout) => {
    const onSeek = vi.fn();
    const { container } = render(
      <SongOverviewStrip {...stripProps({ layout, onSeek, clickToSeek: true })} />,
    );
    const root = layOut(container);

    fireEvent.pointerDown(root, { button: 0, pointerId: 7, clientX: 350, clientY: 10 });
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 350, clientY: 10 });

    expect(onSeek).toHaveBeenCalledWith(130);
  });

  it.each(["wide", "medium"] as const)("%s: a click does not seek and a drag scrubs once per frame", (layout) => {
    const onSeek = vi.fn();
    const { container } = render(<SongOverviewStrip {...stripProps({ layout, onSeek })} />);
    const root = layOut(container);

    fireEvent.pointerDown(root, { button: 0, pointerId: 1, clientX: 50 + 300 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 50 + 300 });
    expect(onSeek).not.toHaveBeenCalled();

    fireEvent.pointerDown(root, { button: 0, pointerId: 2, clientX: 50 + 350 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 50 + 400 });
    expect(root.querySelector(".lt-setlist-overview-playhead")?.classList.contains("is-dragging")).toBe(true);
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 50 + 450 });
    runFrames();
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenLastCalledWith(145);

    fireEvent.pointerUp(window, { pointerId: 2, clientX: 50 + 450 });
    expect(root.querySelector(".lt-setlist-overview-playhead")?.classList.contains("is-dragging")).toBe(false);
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 50 + 900 });
    runFrames();
    expect(onSeek).toHaveBeenCalledTimes(1);
  });

  it("short: tapping or dragging the waveform does not seek", () => {
    const onSeek = vi.fn();
    const { container } = render(<SongOverviewStrip {...stripProps({ layout: "short", onSeek })} />);
    const root = layOut(container);
    fireEvent.pointerDown(root, { button: 0, pointerId: 1, clientX: 50 + 100 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 50 + 700 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 50 + 700 });
    runFrames();
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("short: dragging the playhead suspends follow and ignores a second finger", () => {
    useSetlistStore.setState({ overviewZoom: 4 });
    const onSeek = vi.fn();
    const positionSecondsRef = { current: 150 };
    const { container, unmount } = render(
      <OverviewZoom startSeconds={100} endSeconds={200} positionSecondsRef={positionSecondsRef} onSeek={onSeek}>
        <SongOverviewStrip {...stripProps({ layout: "short", onSeek, positionSecondsRef })} />
      </OverviewZoom>,
    );
    const root = layOut(container);
    const viewport = container.querySelector<HTMLElement>(".lt-setlist-zoom-viewport")!;
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 250 });
    viewport.getBoundingClientRect = () =>
      ({ left: 50, top: 0, width: 250, height: 80, right: 300, bottom: 80 }) as DOMRect;
    const handle = root.querySelector("button")!;
    const layer = container.querySelector<HTMLElement>(".lt-setlist-zoom-layer")!;
    runFrames();
    const initialTransform = layer.style.transform;
    expect(initialTransform).toBe("translate3d(-375px, 0, 0)");
    fireEvent.pointerDown(handle, { pointerType: "touch", button: 0, pointerId: 1, clientX: 175 });
    fireEvent.pointerDown(root, { pointerType: "touch", button: 0, pointerId: 2, clientX: 200 });
    fireEvent.pointerMove(window, { pointerType: "touch", pointerId: 2, clientX: 210 });
    runFrames();
    expect(onSeek).not.toHaveBeenCalled();
    fireEvent.pointerMove(window, { pointerType: "touch", pointerId: 1, clientX: 100 });
    runFrames();
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenLastCalledWith(105);
    positionSecondsRef.current = 105;
    runFrames();
    expect(layer.style.transform).toBe(initialTransform);
    fireEvent.pointerUp(window, { pointerType: "touch", pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(window, { pointerType: "touch", pointerId: 1, clientX: 900 });
    runFrames();
    expect(onSeek).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("short: a touch drag on the waveform still pans without seeking", () => {
    useSetlistStore.setState({ overviewZoom: 4 });
    const onSeek = vi.fn();
    const { container } = render(
      <OverviewZoom startSeconds={100} endSeconds={200} positionSecondsRef={{ current: 150 }} onSeek={onSeek}>
        <SongOverviewStrip {...stripProps({ layout: "short", onSeek })} />
      </OverviewZoom>,
    );
    const root = layOut(container);
    Object.defineProperty(container.querySelector(".lt-setlist-zoom-viewport"), "clientWidth", { configurable: true, value: 250 });
    fireEvent.pointerDown(root, { pointerType: "touch", button: 0, pointerId: 1, clientX: 550 });
    fireEvent.pointerMove(window, { pointerType: "touch", pointerId: 1, clientX: 250 });
    fireEvent.pointerUp(window, { pointerType: "touch", pointerId: 1, clientX: 250 });
    expect(container.querySelector<HTMLElement>(".lt-setlist-zoom-layer")!.style.transform).toBe("translate3d(-300px, 0, 0)");
    runFrames();
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("can disable touch tap-to-seek for the section-oriented overview", () => {
    const onSeek = vi.fn();
    const { container } = render(
      <OverviewZoom
        startSeconds={100}
        endSeconds={200}
        positionSecondsRef={{ current: 150 }}
        onSeek={onSeek}
        tapToSeek={false}
      >
        <div />
      </OverviewZoom>,
    );
    const viewport = container.querySelector<HTMLElement>(".lt-setlist-zoom-viewport")!;
    fireEvent.pointerDown(viewport, { pointerType: "touch", pointerId: 1, clientX: 150 });
    fireEvent.pointerUp(window, { pointerType: "touch", pointerId: 1, clientX: 150 });
    expect(onSeek).not.toHaveBeenCalled();
  });

  it.each([
    ["left edge", 52, -1],
    ["right edge", 298, 1],
  ] as const)("short: dragging the playhead handle auto-scrolls at the %s", (_, edgeX, direction) => {
    useSetlistStore.setState({ overviewZoom: 4 });
    const onSeek = vi.fn();
    const positionSecondsRef = { current: 150 };
    const { container } = render(
      <OverviewZoom startSeconds={100} endSeconds={200} positionSecondsRef={positionSecondsRef} onSeek={onSeek}>
        <SongOverviewStrip {...stripProps({ layout: "short", onSeek, positionSecondsRef })} />
      </OverviewZoom>,
    );
    const viewport = container.querySelector<HTMLElement>(".lt-setlist-zoom-viewport")!;
    Object.defineProperty(viewport, "clientWidth", { configurable: true, value: 250 });
    viewport.getBoundingClientRect = () =>
      ({ left: 50, top: 0, width: 250, height: 80, right: 300, bottom: 80 }) as DOMRect;

    const layer = container.querySelector<HTMLElement>(".lt-setlist-zoom-layer")!;
    const getOffset = () => {
      const match = layer.style.transform.match(/translate3d\((-?[\d.]+)px/);
      return match ? -Number(match[1]) : 0;
    };
    const root = layOut(container, getOffset);
    runFrames();
    const startOffset = getOffset();
    expect(startOffset).toBeGreaterThan(0);

    const handle = root.querySelector<HTMLButtonElement>(".lt-setlist-playhead-handle")!;
    fireEvent.pointerDown(handle, { pointerType: "touch", button: 0, pointerId: 1, clientX: 175 });
    fireEvent.pointerMove(window, { pointerType: "touch", pointerId: 1, clientX: edgeX });
    runFrames();
    const offsetAfterFirstFrame = getOffset();
    const seekAfterFirstFrame = onSeek.mock.lastCall?.[0] as number;
    runFrames();
    const offsetAfterSecondFrame = getOffset();
    const seekAfterSecondFrame = onSeek.mock.lastCall?.[0] as number;

    expect((offsetAfterSecondFrame - offsetAfterFirstFrame) * direction).toBeGreaterThan(0);
    expect((seekAfterSecondFrame - seekAfterFirstFrame) * direction).toBeGreaterThan(0);
    fireEvent.pointerUp(window, { pointerType: "touch", pointerId: 1, clientX: edgeX });
  });

  it.each(["cancel", "unmount"])("short: %s discards pending playhead moves and removes listeners", (ending) => {
    const onSeek = vi.fn();
    const setScrubbing = vi.fn();
    const { container, unmount } = render(
      <ZoomWindowContext.Provider value={{ offset: 0, width: WIDTH, setScrubbing }}>
        <SongOverviewStrip {...stripProps({ layout: "short", onSeek })} />
      </ZoomWindowContext.Provider>,
    );
    const root = layOut(container);
    fireEvent.pointerDown(root.querySelector("button")!, { button: 0, pointerId: 1, clientX: 550 });
    expect(setScrubbing).toHaveBeenLastCalledWith(true);
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 250 });
    if (ending === "cancel") fireEvent.pointerCancel(window, { pointerId: 1 });
    else unmount();
    expect(setScrubbing).toHaveBeenLastCalledWith(false);
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 900 });
    runFrames();
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("without onSeek (editing) the strip is read-only", () => {
    const { container } = render(<SongOverviewStrip {...stripProps({ onSeek: undefined })} />);
    const root = layOut(container);
    expect(root.classList.contains("is-seekable")).toBe(false);
    fireEvent.pointerDown(root, { button: 0, pointerId: 1, clientX: 400 });
  });
});

// The iPhone asked for more zoom with real detail. Zoomed, only the stretch
// around the view is drawn (3 screens), at full resolution, and a new one
// when the view leaves it: never one canvas for the whole zoomed song.
describe("SongOverviewStrip zoomed window", () => {
  it("draws three screens around the view, clamped to the song", () => {
    expect(drawWindowFor({ offset: 400, width: 250 }, 1000)).toEqual({ start: 150, width: 750 });
    expect(drawWindowFor({ offset: 0, width: 250 }, 1000)).toEqual({ start: 0, width: 750 });
    expect(drawWindowFor({ offset: 750, width: 250 }, 1000)).toEqual({ start: 250, width: 750 });
    // Not zoomed enough for a window: the whole song.
    expect(drawWindowFor({ offset: 0, width: 400 }, 1000)).toEqual({ start: 0, width: 1000 });
  });

  it("the canvas covers the stretch, and moves on when the view leaves it", () => {
    const view = { offset: 400, width: 250 };
    const { container } = render(
      <ZoomWindowContext.Provider value={view}>
        <SongOverviewStrip {...stripProps()} />
      </ZoomWindowContext.Provider>,
    );
    const canvas = container.querySelector<HTMLCanvasElement>(".lt-setlist-overview-canvas")!;
    runFrames();
    expect([canvas.style.left, canvas.style.width]).toEqual(["150px", "750px"]);
    const calls = peaksSpy.calls;
    view.offset = 500;
    runFrames();
    // Still inside: no new stretch, no new peaks.
    expect(canvas.style.left).toBe("150px");
    expect(peaksSpy.calls).toBe(calls);
    view.offset = 700;
    runFrames();
    expect([canvas.style.left, canvas.style.width]).toEqual(["250px", "750px"]);
    expect(peaksSpy.calls).toBe(calls + 1);
  });
});
