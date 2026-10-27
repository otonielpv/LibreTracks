import { fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SongView, TrackSummary, VideoClipSummary } from "@libretracks/shared/models";

import { resetFrameGateForTests } from "../frameGate";
import type { TimelineMenus } from "../menus/timelineMenus";
import type { VideoLaneBindings } from "../video/VideoClipHotspots";
import { useVideoStore } from "../video/videoStore";
import { useTimelineUIStore } from "../uiStore";
import { SetlistVideoPanel, songVideoClips } from "./SetlistVideoPanel";
import { testRegion } from "./testBindings";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.name ? `${key}:${String(options.name)}` : key,
  }),
}));

const mobile = vi.hoisted(() => ({ value: false }));
const picked = vi.hoisted(() => ({ paths: ["C:/v/intro.mp4", "C:/a/drums.wav"] }));
vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  get isMobileApp() {
    return mobile.value;
  },
  pickLibraryFiles: vi.fn(async () => picked.paths),
}));

const region = testRegion("r", { name: "Canción", startSeconds: 0, endSeconds: 60 });
const clip = (id: string, at: number, trackId = "v1"): VideoClipSummary =>
  ({ id, trackId, filePath: `C:/v/${id}.mp4`, isMissing: false, timelineStartSeconds: at, durationSeconds: 10, sourceStartSeconds: 0, sourceDurationSeconds: 10 }) as VideoClipSummary;
const song = {
  bpm: 120,
  timeSignature: "4/4",
  tempoMarkers: [],
  timeSignatureMarkers: [],
  regions: [region],
  clips: [],
  sectionMarkers: [{ id: "c", name: "Coro", kind: "chorus", startSeconds: 20 }],
  videoClips: [clip("late", 30), clip("first", 4), clip("other-song", 90)],
} as unknown as SongView;
const videoTrack = { id: "v1", name: "Fondos", kind: "video" } as TrackSummary;

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

function video(): VideoLaneBindings {
  return {
    readOnly: false,
    onContextMenu: vi.fn(),
    handlers: {
      moveClip: vi.fn(),
      trimClip: vi.fn(),
      setFades: vi.fn(),
      duplicateClips: vi.fn(),
      addVideosFromDevice: vi.fn(),
      importVideoPaths: vi.fn(),
      addVideoTrack: vi.fn(),
    } as unknown as VideoLaneBindings["handlers"],
  };
}

function panel(bindings: VideoLaneBindings | undefined, menus = { openMenu: vi.fn(), trackContextMenu: vi.fn(() => [{ label: "common.rename" }]) }) {
  render(
    <SetlistVideoPanel
      song={song}
      region={region}
      tracks={[videoTrack]}
      layout="short"
      menus={menus as unknown as TimelineMenus}
      positionSecondsRef={{ current: 12 }}
      waveformSummaries={{}}
      onSeek={vi.fn()}
      runShortcutAction={vi.fn()}
      video={bindings}
    />,
  );
  return menus;
}

beforeEach(() => {
  mobile.value = false;
  resetFrameGateForTests();
  useVideoStore.getState().clearVideoSelection();
  useTimelineUIStore.setState({ snapEnabled: true });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => vi.restoreAllMocks());

// The phone report: there was no way to add video from the phone.
describe("Edit → Video", () => {
  it("shows section marks and clips in time order; a tap selects and the menu stays available", () => {
    expect(songVideoClips(song, region).map((entry) => entry.id)).toEqual(["first", "late"]);
    const bindings = video();
    panel(bindings);
    const bars = Array.from(document.querySelectorAll<HTMLElement>(".lt-setlist-scrub-video"));
    expect(bars.map((bar) => bar.textContent)).toEqual(["moviefirst.mp4", "movielate.mp4"]);
    expect(document.querySelector(".lt-setlist-scrub-section-guide")?.textContent).toBe("Coro");
    const body = bars[1].querySelector(".lt-setlist-scrub-video-body")!;
    fireEvent.click(body);
    expect(useVideoStore.getState().selectedVideoClipIds).toEqual(["late"]);
    fireEvent.contextMenu(body);
    expect(bindings.onContextMenu).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "late" }));
  });

  it("moves a selected clip by dragging it on the waveform", () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return this.classList?.contains("lt-setlist-scrub-viewport") ? 600 : 0;
      },
    });
    try {
      const bindings = video();
      panel(bindings);
      const body = document.querySelector<HTMLElement>('[data-video-clip-id="first"] .lt-setlist-scrub-video-body')!;
      fireEvent.pointerDown(body, { button: 0, pointerId: 1, clientX: 100 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 175, shiftKey: true });
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 175 });
      expect(bindings.handlers.moveClip).toHaveBeenCalledWith("first", 6, null);
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "clientWidth", original);
      else Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    }
  });

  it("draws two waveform buckets per rendered pixel for extra detail", () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return this.classList?.contains("lt-setlist-scrub-viewport") ? 600 : 0;
      },
    });
    const context = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: "",
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    try {
      panel(video());
      const canvas = document.querySelector<HTMLCanvasElement>(".lt-setlist-scrub-canvas")!;
      expect(context.fillRect).toHaveBeenCalledTimes(canvas.width * 2);
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "clientWidth", original);
      else Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    }
  });

  it("adjusts a fade with its handle and duplicates from the clip list", () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return this.classList?.contains("lt-setlist-scrub-viewport") ? 600 : 0;
      },
    });
    try {
      const bindings = video();
      panel(bindings);
      const body = document.querySelector<HTMLElement>('[data-video-clip-id="first"] .lt-setlist-scrub-video-body')!;
      fireEvent.click(body);
      const fadeHandle = document.querySelector<HTMLElement>(
        '[data-video-clip-id="first"] .lt-setlist-scrub-video-handle.is-fade-in',
      )!;
      fireEvent.pointerDown(fadeHandle, { button: 0, pointerId: 2, clientX: 0 });
      fireEvent.pointerMove(window, { pointerId: 2, clientX: 75 });
      fireEvent.pointerUp(window, { pointerId: 2, clientX: 75 });
      expect(bindings.handlers.setFades).toHaveBeenCalledWith("first", 2, 0);

      fireEvent.click(screen.getByRole("button", { name: "setlistView.video.duplicate:first.mp4" }));
      expect(bindings.handlers.duplicateClips).toHaveBeenCalledWith(["first"]);
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "clientWidth", original);
      else Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    }
  });

  it("phone: «Video here» offers gallery or files and adds at the line on the song's video track", () => {
    mobile.value = true;
    const bindings = video();
    const menus = panel(bindings);
    fireEvent.click(screen.getByRole("button", { name: "setlistView.video.addHere" }));
    const [, , actions] = menus.openMenu.mock.calls[0] as unknown as [unknown, string, Array<{ label: string; onSelect: () => void }>];
    expect(actions.map((action) => action.label)).toEqual(["transport.video.addFromGallery", "transport.video.addFromFiles"]);
    actions[1].onSelect();
    expect(bindings.handlers.addVideosFromDevice).toHaveBeenCalledWith({ seconds: 12, trackId: "v1" }, "files");
  });

  it("desktop: the file picker, videos only, at the line", async () => {
    const bindings = video();
    panel(bindings);
    fireEvent.click(screen.getByRole("button", { name: "setlistView.video.addHere" }));
    await vi.waitFor(() =>
      expect(bindings.handlers.importVideoPaths).toHaveBeenCalledWith(["C:/v/intro.mp4"], { seconds: 12, trackId: "v1" }),
    );
  });

  it("the track row: its DAW menu and «add video track»", () => {
    const bindings = video();
    const menus = panel(bindings);
    fireEvent.click(screen.getByRole("button", { name: "setlistView.sections.menu:Fondos" }));
    expect(menus.openMenu).toHaveBeenCalledWith(expect.anything(), "Fondos", [{ label: "common.rename" }]);
    fireEvent.click(screen.getByRole("button", { name: "transport.video.addTrack" }));
    expect(bindings.handlers.addVideoTrack).toHaveBeenCalledWith("v1");
  });

  it("without the video feature: no add buttons, a note", () => {
    panel(undefined);
    expect(screen.queryByRole("button", { name: "setlistView.video.addHere" })).toBeNull();
    expect(screen.getByText("setlistView.video.unavailable")).toBeTruthy();
  });
});
