import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SongView, TrackSummary, VideoClipSummary } from "@libretracks/shared/models";

import { resetFrameGateForTests } from "../../frameGate";
import type { TimelineMenus } from "../../menus/timelineMenus";
import { useTimelineUIStore } from "../../uiStore";
import type { VideoLaneBindings } from "../../video/VideoClipHotspots";
import { INITIAL_VIDEO_STATE, useVideoStore } from "../../video/videoStore";
import { INITIAL_SETLIST_STATE, useSetlistStore } from "../setlistStore";
import { testRegion } from "../testBindings";
import { SongLanes } from "./SongLanes";

const mobile = vi.hoisted(() => ({ value: false }));
const api = vi.hoisted(() => ({
  pickLibraryFiles: vi.fn(async () => ["C:/clips/fondo.mp4", "C:/clips/letra.mov"]),
  getVideoThumbnails: vi.fn(async () => null),
}));
vi.mock("../../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../desktopApi")>()),
  ...api,
  get isMobileApp() {
    return mobile.value;
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.name ? `${key}:${String(options.name)}` : key,
  }),
}));

// Song from 0 to 100 s at 120 BPM, 1000 px wide: 10 px/s.
const region = testRegion("r", { startSeconds: 0, endSeconds: 100 });
const track = (id: string, kind: TrackSummary["kind"]) =>
  ({ id, name: id, kind, depth: 0, hasChildren: false, volume: 1, pan: 0, muted: false, solo: false, audioTo: "m", transposeEnabled: true }) as TrackSummary;
const videoClip = (id: string, trackId: string, start: number, duration: number): VideoClipSummary =>
  ({
    id,
    trackId,
    filePath: `C:/clips/${id}.mp4`,
    isMissing: false,
    timelineStartSeconds: start,
    durationSeconds: duration,
    sourceStartSeconds: 0,
    sourceDurationSeconds: duration,
  }) as VideoClipSummary;
const tracks = [track("bg", "video"), track("lyrics", "video"), track("drums", "audio")];
const song = {
  bpm: 120,
  timeSignature: "4/4",
  tempoMarkers: [],
  timeSignatureMarkers: [],
  regions: [region],
  sectionMarkers: [{ id: "chorus", name: "Coro", kind: "chorus", startSeconds: 40 }],
  tracks,
  clips: [],
  videoClips: [videoClip("v1", "bg", 10, 20), videoClip("later", "bg", 150, 10)],
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

function bindings(readOnly = false) {
  return {
    handlers: {
      moveClip: vi.fn(),
      trimClip: vi.fn(),
      importVideoPaths: vi.fn(),
      addVideosFromDevice: vi.fn(),
    },
    readOnly,
    onContextMenu: vi.fn(),
  };
}

type LanesProps = ComponentProps<typeof SongLanes>;
function props(video = bindings(), overrides: Partial<LanesProps> = {}): LanesProps {
  return {
    song,
    region,
    tracks,
    waveformSummaries: {},
    positionSecondsRef: { current: 47 },
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
    videoLanes: video as unknown as VideoLaneBindings,
    ...overrides,
  };
}

const box = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-lane-video-clip-id="${id}"]`)!;
const lane = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`.lt-setlist-lane[data-lane-track-id="${id}"]`)!;

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
  mobile.value = false;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  resetFrameGateForTests();
  useSetlistStore.setState(INITIAL_SETLIST_STATE);
  useVideoStore.setState(INITIAL_VIDEO_STATE);
  useTimelineUIStore.setState({ snapEnabled: false, selectedTrackIds: [] });
  api.pickLibraryFiles.mockClear();
  api.getVideoThumbnails.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("video lane", () => {
  it("every video track gets a row; clips sit at their time and length", () => {
    const { container } = render(<SongLanes {...props()} />);
    expect(lane(container, "bg")).not.toBeNull();
    expect(lane(container, "lyrics")).not.toBeNull();
    expect(box(container, "v1").style.left).toBe("100px");
    expect(box(container, "v1").style.width).toBe("200px");
    expect(box(container, "later")).toBeNull();
  });

  it("a press selects like the DAW; a drag moves with ONE moveClip on release", () => {
    const video = bindings();
    const { container } = render(<SongLanes {...props(video)} />);
    const element = box(container, "v1");
    fireEvent.pointerDown(element, { button: 0, pointerId: 1, clientX: 150 });
    expect(useVideoStore.getState().selectedVideoClipIds).toEqual(["v1"]);
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 250 });
    expect(element.style.transform).toBe("translate3d(100px, 0, 0)");
    expect(video.handlers.moveClip).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 250 });
    expect(video.handlers.moveClip).toHaveBeenCalledTimes(1);
    expect(video.handlers.moveClip).toHaveBeenCalledWith("v1", 20, null);
  });

  it("dropped on another video track, the same call carries it", () => {
    const video = bindings();
    const { container } = render(<SongLanes {...props(video)} />);
    const target = lane(container, "lyrics");
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => target) });
    fireEvent.pointerDown(box(container, "v1"), { button: 0, pointerId: 2, clientX: 150 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 170 });
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 170 });
    expect(video.handlers.moveClip).toHaveBeenCalledWith("v1", 12, "lyrics");
  });

  it("dragging an edge trims with ONE trimClip; Esc cancels", () => {
    const video = bindings();
    const { container } = render(<SongLanes {...props(video)} />);
    const end = box(container, "v1").querySelector<HTMLElement>(".lt-setlist-lane-trim.is-end")!;
    fireEvent.pointerDown(end, { button: 0, pointerId: 3, clientX: 300 });
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 250 });
    expect(box(container, "v1").style.width).toBe("150px");
    fireEvent.pointerUp(window, { pointerId: 3, clientX: 250 });
    expect(video.handlers.trimClip).toHaveBeenCalledWith("v1", 10, 25);

    const start = box(container, "v1").querySelector<HTMLElement>(".lt-setlist-lane-trim.is-start")!;
    fireEvent.pointerDown(start, { button: 0, pointerId: 4, clientX: 100 });
    fireEvent.pointerMove(window, { pointerId: 4, clientX: 140 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(window, { pointerId: 4, clientX: 140 });
    expect(video.handlers.trimClip).toHaveBeenCalledTimes(1);
  });

  it("the menu is the DAW's video clip menu", () => {
    const video = bindings();
    const { container } = render(<SongLanes {...props(video)} />);
    fireEvent.contextMenu(box(container, "v1"));
    expect(video.onContextMenu).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "v1" }));
  });

  it("split / duplicate / delete work on a video selection (the DAW's shortcut actions)", () => {
    const base = props();
    render(<SongLanes {...base} />);
    expect(screen.getByRole("button", { name: "setlistView.lanes.split" })).toHaveProperty("disabled", true);
    act(() => useVideoStore.getState().selectVideoClip("v1", false));
    fireEvent.click(screen.getByRole("button", { name: "setlistView.lanes.split" }));
    expect(base.runShortcutAction).toHaveBeenCalledWith("edit.splitClip");
  });

  // C4: the lane only reads the strips the video feature loaded; zooming
  // never asks the backend again.
  it("thumbnails are not requested from the lane, not even when zooming", () => {
    render(<SongLanes {...props()} />);
    act(() => useSetlistStore.getState().setLanesZoom(4));
    act(() => useSetlistStore.getState().setLanesZoom(8));
    expect(api.getVideoThumbnails).not.toHaveBeenCalled();
  });

  // C1: add at the playhead / section start through the DAW's import (which
  // asks about extracting the audio), on the selected video track.
  it("«+ Video» picks files and imports the videos at the playhead or the section start", async () => {
    const video = bindings();
    const base = props(video);
    useTimelineUIStore.setState({ selectedTrackIds: ["lyrics"] });
    render(<SongLanes {...base} />);
    fireEvent.click(screen.getByRole("button", { name: /setlistView.video.add$/ }));
    const [, , actions] = (base.menus.openMenu as ReturnType<typeof vi.fn>).mock.calls.at(-1) as [
      unknown,
      string,
      Array<{ onSelect: () => void }>,
    ];
    await act(async () => actions[0].onSelect());
    expect(video.handlers.importVideoPaths).toHaveBeenLastCalledWith(
      ["C:/clips/fondo.mp4", "C:/clips/letra.mov"],
      { seconds: 47, trackId: "lyrics" },
    );
    await act(async () => actions[1].onSelect());
    expect(video.handlers.importVideoPaths).toHaveBeenLastCalledWith(expect.any(Array), { seconds: 40, trackId: "lyrics" });
  });

  it("on a phone «+ Video» picks from the gallery", async () => {
    mobile.value = true;
    const video = bindings();
    const base = props(video, { layout: "short" });
    render(<SongLanes {...base} />);
    fireEvent.click(screen.getByRole("button", { name: /setlistView.video.add$/ }));
    const [, , actions] = (base.menus.openMenu as ReturnType<typeof vi.fn>).mock.calls.at(-1) as [
      unknown,
      string,
      Array<{ onSelect: () => void }>,
    ];
    await act(async () => actions[0].onSelect());
    expect(video.handlers.addVideosFromDevice).toHaveBeenCalledWith({ seconds: 47, trackId: "bg" }, "gallery");
    expect(api.pickLibraryFiles).not.toHaveBeenCalled();
  });

  it("read-only video (a phone without its players): no add, no trims", () => {
    const { container } = render(<SongLanes {...props(bindings(true), { layout: "medium" })} />);
    expect(screen.queryByRole("button", { name: /setlistView.video.add$/ })).toBeNull();
    expect(box(container, "v1").querySelector(".lt-setlist-lane-trim")).toBeNull();
  });
});
