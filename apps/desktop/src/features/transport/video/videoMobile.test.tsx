import { fireEvent, render, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mobile build (plan video-mobile, paso 09): video plays on phones too, and
// what decides whether it can be edited is the backend's capability.
vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  isMobileApp: true,
  getVideoMediaStatus: vi.fn(async () => ({ supportedPlatform: true, available: false })),
  listVideoAssets: vi.fn(async () => []),
  getVideoThumbnails: vi.fn(async () => null),
  listenToVideoThumbnailsReady: vi.fn(async () => () => {}),
}));

import "../../../shared/i18n";
import type { SongView, VideoClipSummary, VideoLibraryStatus } from "../desktopApi";
import { useVideoFeature } from "./useVideoFeature";
import { VideoClipHotspots } from "./VideoClipHotspots";
import type { VideoClipHandlers } from "./videoClipHandlers";
import { INITIAL_VIDEO_STATE, useVideoStore } from "./videoStore";

const clip: VideoClipSummary = {
  id: "vc1",
  trackId: "v1",
  filePath: "video/v.mp4",
  isMissing: false,
  timelineStartSeconds: 1,
  durationSeconds: 4,
  sourceStartSeconds: 0,
  sourceDurationSeconds: 10,
};
const song = { videoClips: [clip] } as unknown as SongView;

function backend(available: boolean): VideoLibraryStatus {
  return {
    supportedPlatform: true,
    available,
    reason: available ? null : "VideoOutputBridge no está en esta build",
    libraryPath: null,
    clientApiVersion: null,
  };
}

function feature() {
  return renderHook(() =>
    useVideoFeature({
      song,
      runAction: async (action) => action(),
      applyPlaybackSnapshot: () => undefined,
      setStatus: () => undefined,
      t: (key) => key,
      getPlayheadSeconds: () => 0,
      openClipMenu: () => undefined,
    }),
  ).result;
}

/** A finger on the hit target: jsdom has no PointerEvent, so a MouseEvent
 * carries the pointer fields (project_jsdom_no_pointer_event). */
function finger(target: Element, type: string, clientX: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY: 10 });
  Object.defineProperty(event, "pointerId", { value: 7 });
  Object.defineProperty(event, "pointerType", { value: "touch" });
  fireEvent(target, event);
}

function drag(target: Element, fromX: number, toX: number) {
  finger(target, "pointerdown", fromX);
  finger(target, "pointermove", (fromX + toX) / 2);
  finger(target, "pointermove", toX);
  finger(target, "pointerup", toX);
}

function lane(readOnly: boolean) {
  const handlers = {
    moveClip: vi.fn(),
    trimClip: vi.fn(),
    setFades: vi.fn(),
  } as unknown as VideoClipHandlers;
  const view = render(
    <VideoClipHotspots
      trackId="v1"
      song={song}
      rowHeight={60}
      camera={{
        cameraXRef: { current: 0 },
        livePixelsPerSecondRef: { current: 20 },
        pixelsPerSecond: 20,
      }}
      lane={{ handlers, readOnly, onContextMenu: () => undefined }}
    />,
  );
  return { handlers, container: view.container };
}

beforeEach(() => {
  useVideoStore.setState(INITIAL_VIDEO_STATE);
});

describe("video on a phone whose players could not start", () => {
  it("shows the track read-only: no editing entry points", () => {
    useVideoStore.getState().setMediaStatus(backend(false));
    const result = feature();
    expect(result.current.handlers).toBeUndefined();
    expect(result.current.keyboardEdits).toBeUndefined();
    expect(result.current.lanes.readOnly).toBe(true);
    expect(result.current.importVideoPaths).toBeUndefined();
    expect(useVideoStore.getState().addFromDevice).toBeNull();
  });

  it("does not let its clips be dragged, trimmed or faded", () => {
    const { handlers, container } = lane(true);
    const hotspot = container.querySelector(".lt-video-clip-hotspot")!;
    expect(hotspot.classList.contains("is-read-only")).toBe(true);
    expect(container.querySelector(".lt-video-trim")).toBeNull();
    expect(container.querySelector(".lt-video-fade")).toBeNull();
    drag(hotspot, 20, 200);
    expect(handlers.moveClip).not.toHaveBeenCalled();
    expect(useVideoStore.getState().selectedVideoClipIds).toEqual([]);
  });
});

describe("video on a phone with its players", () => {
  it("offers the same editing as the desktop, plus adding from the device", () => {
    useVideoStore.getState().setMediaStatus(backend(true));
    const result = feature();
    expect(result.current.handlers).toBeDefined();
    expect(result.current.keyboardEdits).toBeDefined();
    expect(result.current.lanes.readOnly).toBe(false);
    // No files dropped from the OS on a phone: videos are copied in instead.
    expect(result.current.importVideoPaths).toBeUndefined();
    expect(useVideoStore.getState().addFromDevice).toBeTypeOf("function");
  });

  /** Paso 09 C2: the clip gestures with a finger. */
  it("moves a clip with a finger", () => {
    const { handlers, container } = lane(false);
    drag(container.querySelector(".lt-video-clip-hotspot")!, 40, 80);
    // 40 px at 20 px/s = 2 s later.
    expect(handlers.moveClip).toHaveBeenCalledWith("vc1", 3, null);
  });

  it("trims a clip by its edge with a finger", () => {
    const { handlers, container } = lane(false);
    drag(container.querySelector(".lt-video-trim.is-start")!, 20, 40);
    expect(handlers.trimClip).toHaveBeenCalledWith("vc1", 2, 5);
  });

  it("sets a fade with a finger", () => {
    const { handlers, container } = lane(false);
    drag(container.querySelector(".lt-video-fade.is-in")!, 20, 40);
    expect(handlers.setFades).toHaveBeenCalledWith("vc1", 1, 0);
  });

  it("selects a clip on a plain tap, and marks it for the fade handles", () => {
    const { container } = lane(false);
    const hotspot = container.querySelector(".lt-video-clip-hotspot")!;
    finger(hotspot, "pointerdown", 30);
    finger(hotspot, "pointerup", 31);
    expect(useVideoStore.getState().selectedVideoClipIds).toEqual(["vc1"]);
    expect(container.querySelector(".lt-video-clip-hotspot")!.classList.contains("is-selected")).toBe(true);
  });
});
