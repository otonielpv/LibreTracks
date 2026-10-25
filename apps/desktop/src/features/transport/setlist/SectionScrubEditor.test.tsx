import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SongView } from "@libretracks/shared/models";

import { resetFrameGateForTests } from "../frameGate";
import { useTimelineUIStore } from "../uiStore";
import { SectionScrubEditor } from "./SectionScrubEditor";
import { testRegion } from "./testBindings";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.bar !== undefined ? `${key}:${String(options.bar)}` : key,
  }),
}));

// 120 BPM 4/4: a bar every 2 s. The viewport is 800 px and shows 8 bars
// (16 s): 50 px per second, the centre line at 400 px.
const region = testRegion("r", { startSeconds: 0, endSeconds: 40 });
const song = {
  bpm: 120,
  timeSignature: "4/4",
  tempoMarkers: [],
  timeSignatureMarkers: [],
  regions: [region],
  clips: [],
  sectionMarkers: [
    { id: "intro", name: "Intro", kind: "intro", startSeconds: 0 },
    { id: "verse", name: "Verso", kind: "verse", startSeconds: 8 },
  ],
} as unknown as SongView;

class FakeResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe() {
    this.callback([{ contentRect: { width: 800, height: 120 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  disconnect() {}
}

let frames: FrameRequestCallback[] = [];
const runFrames = () => {
  const pending = frames;
  frames = [];
  act(() => pending.forEach((callback) => callback(0)));
};

function handlers() {
  return {
    createAt: vi.fn(),
    commitMove: vi.fn(() => true),
    select: vi.fn(),
    dragGroup: vi.fn((id: string) => [id]),
    openMenu: vi.fn(),
    duplicateSelection: vi.fn(),
    deleteSelection: vi.fn(),
  };
}

type Props = ComponentProps<typeof SectionScrubEditor>;
function props(overrides: Partial<Props> = {}): Props {
  return {
    song,
    region,
    waveformSummaries: {},
    positionSecondsRef: { current: 0 },
    onSeek: vi.fn(),
    handlers: handlers(),
    ...overrides,
  };
}

const layer = (container: HTMLElement) => container.querySelector<HTMLElement>(".lt-setlist-scrub-layer")!;
const viewport = (container: HTMLElement) => container.querySelector<HTMLElement>(".lt-setlist-scrub-viewport")!;
const barLabel = (container: HTMLElement) => container.querySelector(".lt-setlist-scrub-bar")?.textContent;

const originalPointerEvent = window.PointerEvent;
beforeAll(() => {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  Object.defineProperty(window, "PointerEvent", { configurable: true, value: TestPointerEvent });
});
afterAll(() => {
  Object.defineProperty(window, "PointerEvent", { configurable: true, value: originalPointerEvent });
});
beforeEach(() => {
  frames = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  resetFrameGateForTests();
  // jsdom has no canvas: the waveform draws nothing here.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  useTimelineUIStore.getState().clearSelection();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SectionScrubEditor (Playback-style section editing)", () => {
  // The iPhone report: a selector building a new array every read re-rendered
  // forever and the drawer went black.
  it("renders and stays put with a section selected", () => {
    useTimelineUIStore.getState().setSelectedMarkers([{ kind: "section", id: "verse" }], { kind: "section", id: "verse" });
    const { container } = render(<SectionScrubEditor {...props()} />);
    expect(container.querySelector(".lt-setlist-scrub-section.is-selected")?.textContent).toBe("Verso");
  });

  it("the song's start sits under the centre line, at bar 1", () => {
    const { container } = render(<SectionScrubEditor {...props()} />);
    expect(layer(container).style.transform).toBe("translate3d(400px, 0, 0)");
    expect(barLabel(container)).toBe("setlistView.sections.barLabel:1");
  });

  it("a swipe moves only the layer; releasing lands on the nearest bar and seeks there", () => {
    const base = props();
    const { container } = render(<SectionScrubEditor {...base} />);
    fireEvent.pointerDown(viewport(container), { button: 0, pointerId: 1, clientX: 600 });
    // 290 px to the left = 5.8 s later.
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 310 });
    expect(layer(container).style.transform).toBe("translate3d(110px, 0, 0)");
    expect(base.onSeek).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 310 });
    expect(base.onSeek).toHaveBeenCalledWith(6);
    expect(barLabel(container)).toBe("setlistView.sections.barLabel:4");
  });

  it("«Section here» creates at the line; the bar arrows move the line", () => {
    const base = props({ positionSecondsRef: { current: 10 } });
    const { container } = render(<SectionScrubEditor {...base} />);
    runFrames();
    expect(barLabel(container)).toBe("setlistView.sections.barLabel:6");
    fireEvent.click(screen.getByRole("button", { name: /setlistView.sections.addHere/ }));
    expect(base.handlers.createAt).toHaveBeenCalledWith(10);
    fireEvent.click(screen.getByRole("button", { name: "setlistView.sections.nextBar" }));
    expect(base.onSeek).toHaveBeenLastCalledWith(12);
    fireEvent.click(screen.getByRole("button", { name: "setlistView.sections.prevBar" }));
    expect(base.onSeek).toHaveBeenLastCalledWith(10);
  });

  it("the arrows move the selected section one bar (Playback's «Move Song Section»)", () => {
    const base = props();
    const { rerender } = render(<SectionScrubEditor {...base} />);
    expect(screen.getByRole("button", { name: "setlistView.sections.moveRight" })).toHaveProperty("disabled", true);
    act(() =>
      useTimelineUIStore.getState().setSelectedMarkers([{ kind: "section", id: "verse" }], { kind: "section", id: "verse" }),
    );
    rerender(<SectionScrubEditor {...base} />);
    fireEvent.click(screen.getByRole("button", { name: "setlistView.sections.moveRight" }));
    expect(base.handlers.commitMove).toHaveBeenLastCalledWith(["verse"], 2);
    fireEvent.click(screen.getByRole("button", { name: "setlistView.sections.moveLeft" }));
    expect(base.handlers.commitMove).toHaveBeenLastCalledWith(["verse"], -2);
  });

  it("follows the playhead while it plays, not while the finger is on it", () => {
    const position = { current: 0 };
    const { container } = render(<SectionScrubEditor {...props({ positionSecondsRef: position })} />);
    position.current = 4;
    runFrames();
    expect(layer(container).style.transform).toBe("translate3d(200px, 0, 0)");
    fireEvent.pointerDown(viewport(container), { button: 0, pointerId: 2, clientX: 400 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 300 });
    position.current = 20;
    runFrames();
    expect(layer(container).style.transform).toBe("translate3d(100px, 0, 0)");
  });
});
