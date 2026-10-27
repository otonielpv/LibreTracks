import { act, fireEvent, render, screen } from "@testing-library/react";
import { Profiler, type ComponentProps } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClipSummary, SongView, TrackSummary } from "@libretracks/shared/models";

import { resetFrameGateForTests } from "../../frameGate";
import type { TimelineMenus } from "../../menus/timelineMenus";
import { useSongStore } from "../../songStore";
import { useTransportStore } from "../../store";
import { INITIAL_STRUCTURE_STATE, useStructureStore } from "../../structure/structureStore";
import { useTimelineUIStore } from "../../uiStore";
import { INITIAL_SETLIST_STATE, useSetlistStore } from "../setlistStore";
import { testRegion } from "../testBindings";
import type { SongLaneType } from "./laneTypes";
import { DEFAULT_LANE_TYPES, SongLanes } from "./SongLanes";

const mobile = vi.hoisted(() => ({ value: false }));
const api = vi.hoisted(() => ({
  moveClipsBatch: vi.fn(async () => ({ projectRevision: 5 })),
  updateClipWindow: vi.fn(async () => ({ projectRevision: 6 })),
}));
vi.mock("../../desktopApi", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../desktopApi")>();
  return {
    ...original,
    ...api,
    get isMobileApp() {
      return mobile.value;
    },
  };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.name ? `${key}:${String(options.name)}` : key,
  }),
}));

// Song from 0 to 100 s, 120 BPM 4/4, drawn 1000 px wide at 1×: 10 px/s.
const region = testRegion("r", { name: "Canción", startSeconds: 0, endSeconds: 100 });
const track = (id: string, name: string, kind: TrackSummary["kind"] = "audio") =>
  ({ id, name, kind, depth: 0, hasChildren: false, volume: 1, pan: 0, muted: false, solo: false, audioTo: "m", transposeEnabled: true }) as TrackSummary;
const clip = (id: string, trackId: string, timelineStartSeconds: number, durationSeconds = 10) =>
  ({
    id,
    trackId,
    trackName: trackId,
    filePath: `${id}.wav`,
    waveformKey: id,
    isMissing: false,
    timelineStartSeconds,
    sourceStartSeconds: 0,
    sourceWindowDurationSeconds: durationSeconds,
    sourceDurationSeconds: 60,
    durationSeconds,
    gain: 1,
  }) as ClipSummary;
const tracks = [track("drums", "Batería"), track("bass", "Bajo"), track("empty", "Vacía")];
const song = {
  bpm: 120,
  timeSignature: "4/4",
  tempoMarkers: [],
  timeSignatureMarkers: [],
  regions: [region],
  sectionMarkers: [],
  tracks,
  clips: [clip("c1", "drums", 10), clip("c2", "bass", 30)],
} as unknown as SongView;

class FakeResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe() {
    this.callback([{ contentRect: { width: 1000, height: 40 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  disconnect() {}
}

let frames: FrameRequestCallback[] = [];
const runFrames = () => {
  const pending = frames;
  frames = [];
  act(() => pending.forEach((callback) => callback(0)));
};

type LanesProps = ComponentProps<typeof SongLanes>;
function props(overrides: Partial<LanesProps> = {}): LanesProps {
  return {
    song,
    region,
    tracks,
    waveformSummaries: {},
    positionSecondsRef: { current: 0 },
    layout: "wide",
    menus: { openMenu: vi.fn(), clipContextMenu: vi.fn(() => []) } as unknown as TimelineMenus,
    mixerHandlers: {
      onToggleMute: vi.fn(),
      onToggleSolo: vi.fn(),
      onToggleTranspose: vi.fn(),
      onVolumeChange: vi.fn(),
      onCommitVolume: vi.fn(),
      onPanChange: vi.fn(),
      onCommitPan: vi.fn(),
      onAudioToChange: vi.fn(),
    },
    runShortcutAction: vi.fn(),
    onSeek: vi.fn(),
    onRulerMenuAt: vi.fn(),
    runAction: vi.fn(async (action: () => Promise<void>) => {
      await action();
    }),
    onSnapshotApplied: vi.fn(),
    ...overrides,
  };
}

const clipBox = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-lane-clip-id="${id}"]`)!;
const flush = () => act(async () => {});

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
  mobile.value = false;
  frames = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  resetFrameGateForTests();
  useTransportStore.setState({ playback: { playbackState: "playing" } as never });
  useSetlistStore.setState(INITIAL_SETLIST_STATE);
  useStructureStore.setState(INITIAL_STRUCTURE_STATE);
  useSongStore.setState({ song });
  useTimelineUIStore.getState().clearSelection();
  useTimelineUIStore.setState({ snapEnabled: false, cameraX: 321, zoomLevel: 3 });
  api.moveClipsBatch.mockClear();
  api.updateClipWindow.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("SongLanes rows", () => {
  it("one lane per track with content in the song, clips at their place", () => {
    const { container } = render(<SongLanes {...props()} />);
    expect(Array.from(container.querySelectorAll("[data-lane-track-id]")).map((row) => row.getAttribute("data-lane-track-id"))).toEqual([
      "drums",
      "bass",
    ]);
    expect(clipBox(container, "c1").style.left).toBe("100px");
    expect(clipBox(container, "c1").style.width).toBe("100px");
  });

  it("a registered lane type is painted for the tracks it accepts", () => {
    const fake: SongLaneType = {
      kind: "fake",
      rowHeight: 30,
      accepts: (candidate) => candidate.id === "bass",
      render: ({ track: lane }) => <div data-testid={`fake-${lane.id}`} />,
    };
    render(<SongLanes {...props({ laneTypes: [fake, ...DEFAULT_LANE_TYPES] })} />);
    expect(screen.getByTestId("fake-bass")).toBeTruthy();
  });
});

describe("SongLanes gestures", () => {
  it("a drag previews locally and commits ONE moveClipsBatch on release", async () => {
    const { container } = render(<SongLanes {...props()} />);
    const box = clipBox(container, "c1");
    fireEvent.pointerDown(box, { button: 0, pointerId: 1, clientX: 150 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 180 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 200 });
    expect(api.moveClipsBatch).not.toHaveBeenCalled();
    expect(box.style.transform).toBe("translate3d(50px, 0, 0)");
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 200 });
    await flush();
    expect(api.moveClipsBatch).toHaveBeenCalledTimes(1);
    expect(api.moveClipsBatch).toHaveBeenCalledWith([{ clipId: "c1", timelineStartSeconds: 15 }]);
  });

  it("Esc during the drag cancels it without any command", async () => {
    const { container } = render(<SongLanes {...props()} />);
    const box = clipBox(container, "c1");
    fireEvent.pointerDown(box, { button: 0, pointerId: 1, clientX: 150 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 220 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 220 });
    await flush();
    expect(api.moveClipsBatch).not.toHaveBeenCalled();
    expect(box.style.transform).toBe("");
  });

  it("dropping a clip on another audio lane moves it to that track in the same command", async () => {
    const { container } = render(<SongLanes {...props()} />);
    const bassLane = container.querySelector<HTMLElement>("[data-lane-track-id='bass']")!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => bassLane });
    fireEvent.pointerDown(clipBox(container, "c1"), { button: 0, pointerId: 1, clientX: 150, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 150 + 20, clientY: 80 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 170, clientY: 80 });
    await flush();
    expect(api.moveClipsBatch).toHaveBeenCalledWith([{ clipId: "c1", timelineStartSeconds: 12, targetTrackId: "bass" }]);
  });

  it("dragging an edge trims with ONE update_clip_window", async () => {
    const { container } = render(<SongLanes {...props()} />);
    const end = clipBox(container, "c1").querySelector<HTMLElement>("[data-lane-trim='end']")!;
    fireEvent.pointerDown(end, { button: 0, pointerId: 1, clientX: 200 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 240 });
    expect(api.updateClipWindow).not.toHaveBeenCalled();
    expect(clipBox(container, "c1").style.width).toBe("140px");
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 240 });
    await flush();
    expect(api.updateClipWindow).toHaveBeenCalledWith("c1", 10, 0, 14);
  });

  it("a song with an applied arrangement asks «Edit the original?» and does not move", async () => {
    const arranged = {
      ...song,
      regions: [{ ...region, structure: { sections: [], arrangements: [{ id: "x", name: "Corto", blocks: [] }], appliedArrangementId: "x" } }],
    } as unknown as SongView;
    useSongStore.setState({ song: arranged });
    const { container } = render(<SongLanes {...props()} />);
    fireEvent.pointerDown(clipBox(container, "c1"), { button: 0, pointerId: 1, clientX: 150 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 200 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 200 });
    await flush();
    expect(api.moveClipsBatch).not.toHaveBeenCalled();
    expect(useStructureStore.getState().guard).toMatchObject({ arrangementName: "Corto" });
  });

  it("split, duplicate and delete are the DAW's shortcut actions on the selection", () => {
    const base = props();
    const { container } = render(<SongLanes {...base} />);
    fireEvent.pointerDown(clipBox(container, "c2"), { button: 0, pointerId: 1, clientX: 310 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 310 });
    expect(useTimelineUIStore.getState().selectedClipIds).toEqual(["c2"]);
    fireEvent.click(screen.getByRole("button", { name: "setlistView.lanes.split" }));
    fireEvent.click(screen.getByRole("button", { name: "setlistView.lanes.duplicate" }));
    fireEvent.click(screen.getByRole("button", { name: "setlistView.lanes.delete" }));
    expect((base.runShortcutAction as ReturnType<typeof vi.fn>).mock.calls.map(([action]) => action)).toEqual([
      "edit.splitClip",
      "edit.duplicate",
      "edit.delete",
    ]);
  });

  it("the clip menu is the DAW's clip menu", () => {
    const base = props();
    const { container } = render(<SongLanes {...base} />);
    fireEvent.contextMenu(clipBox(container, "c1"));
    expect(base.menus.clipContextMenu).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }));
    expect(base.menus.openMenu).toHaveBeenCalledWith(expect.anything(), "c1.wav", []);
    expect(useTimelineUIStore.getState().selectedClipIds).toEqual(["c1"]);
  });
});

describe("SongLanes view", () => {
  it("the playhead moves by rAF with 0 renders", () => {
    const positionSecondsRef = { current: 20 };
    let renders = 0;
    const { container } = render(
      <Profiler id="lanes" onRender={() => (renders += 1)}>
        <SongLanes {...props({ positionSecondsRef })} />
      </Profiler>,
    );
    runFrames();
    const playhead = container.querySelector<HTMLElement>(".lt-setlist-lanes-playhead")!;
    expect(playhead.style.transform).toBe("translate3d(200px, 0, 0)");
    const baseline = renders;
    positionSecondsRef.current = 40;
    runFrames();
    expect(playhead.style.transform).toBe("translate3d(400px, 0, 0)");
    expect(renders).toBe(baseline);
  });

  it("zoom and scroll are the lanes' own: the DAW camera stays put", () => {
    const { container } = render(<SongLanes {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "setlistView.lanes.zoomIn" }));
    expect(useSetlistStore.getState().lanesZoom).toBe(2);
    expect(clipBox(container, "c1").style.width).toBe("200px");
    fireEvent.wheel(container.querySelector(".lt-setlist-lanes")!, { deltaX: 120 });
    expect(useSetlistStore.getState().lanesScrollPx).toBeGreaterThan(0);
    expect(useTimelineUIStore.getState().cameraX).toBe(321);
    expect(useTimelineUIStore.getState().zoomLevel).toBe(3);
  });

  it("the ruler seeks; its menu is the DAW ruler menu", () => {
    const base = props();
    const { container } = render(<SongLanes {...base} />);
    const ruler = container.querySelector<HTMLElement>(".lt-setlist-lanes-ruler")!;
    Object.defineProperty(ruler, "offsetWidth", { configurable: true, value: 1000 });
    ruler.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 30, right: 1000, bottom: 30 }) as DOMRect;
    fireEvent.pointerDown(ruler, { button: 0, pointerId: 1, clientX: 250 });
    expect(base.onSeek).toHaveBeenCalledWith(25);
    fireEvent.contextMenu(ruler, { clientX: 500 });
    expect(base.onRulerMenuAt).toHaveBeenCalledWith(expect.anything(), 50);
  });

  it.each(["wide", "medium", "short"] as const)("%s: lanes with their toolbar", (layout) => {
    const { container } = render(<SongLanes {...props({ layout })} />);
    expect(container.querySelector(`.lt-setlist-lanes.is-${layout}`)).not.toBeNull();
    const toolbar = container.querySelector(".lt-setlist-lanes-toolbar")!;
    // short: the action bar goes under the lanes, like the mobile selection bar.
    expect(toolbar.previousElementSibling?.classList.contains("lt-setlist-lanes-body") ?? false).toBe(layout === "short");
  });

  it("touch: a finger on an unselected clip only selects it; dragging needs it selected", async () => {
    mobile.value = true;
    const { container } = render(<SongLanes {...props()} />);
    const box = clipBox(container, "c1");
    const touch = { button: 0, pointerId: 2, pointerType: "touch" };
    fireEvent.pointerDown(box, { ...touch, clientX: 150 });
    fireEvent.pointerMove(window, { ...touch, clientX: 220 });
    fireEvent.pointerUp(window, { ...touch, clientX: 220 });
    await flush();
    expect(useTimelineUIStore.getState().selectedClipIds).toEqual(["c1"]);
    expect(api.moveClipsBatch).not.toHaveBeenCalled();

    fireEvent.pointerDown(box, { ...touch, clientX: 150 });
    fireEvent.pointerMove(window, { ...touch, clientX: 200 });
    fireEvent.pointerUp(window, { ...touch, clientX: 200 });
    await flush();
    expect(api.moveClipsBatch).toHaveBeenCalledTimes(1);
  });
});
