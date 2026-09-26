import { fireEvent, render, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Mobile build: video is kept in the document but read-only.
vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  isMobileApp: true,
  getVideoMediaStatus: vi.fn(async () => ({ supportedPlatform: false, available: false })),
  listVideoAssets: vi.fn(async () => []),
  getVideoThumbnails: vi.fn(async () => null),
  listenToVideoThumbnailsReady: vi.fn(async () => () => {}),
}));

import "../../../shared/i18n";
import type { SongView, VideoClipSummary } from "../desktopApi";
import { useVideoFeature } from "./useVideoFeature";
import { VideoClipHotspots } from "./VideoClipHotspots";
import type { VideoClipHandlers } from "./videoClipHandlers";
import { useVideoStore } from "./videoStore";

const clip: VideoClipSummary = {
  id: "vc1",
  trackId: "v1",
  filePath: "D:/v.mp4",
  isMissing: false,
  timelineStartSeconds: 1,
  durationSeconds: 4,
  sourceStartSeconds: 0,
  sourceDurationSeconds: 4,
};
const song = { videoClips: [clip] } as unknown as SongView;

describe("video on mobile", () => {
  it("offers no video creation, import or edit entry points", () => {
    const { result } = renderHook(() =>
      useVideoFeature({
        song,
        runAction: async (action) => action(),
        applyPlaybackSnapshot: () => undefined,
        setStatus: () => undefined,
        t: (key) => key,
        getPlayheadSeconds: () => 0,
        openClipMenu: () => undefined,
      }),
    );
    // No importer (drops are refused with the desktop-only reason), no
    // handlers (so timelineMenus shows no "Add video track"), no shortcuts.
    expect(result.current.importVideoPaths).toBeUndefined();
    expect(result.current.handlers).toBeUndefined();
    expect(result.current.keyboardEdits).toBeUndefined();
    expect(result.current.lanes.readOnly).toBe(true);
  });

  it("does not let video clips be dragged, trimmed or faded", () => {
    const handlers = {
      moveClip: vi.fn(),
      trimClip: vi.fn(),
      setFades: vi.fn(),
    } as unknown as VideoClipHandlers;
    const { container } = render(
      <VideoClipHotspots
        trackId="v1"
        song={song}
        rowHeight={60}
        camera={{
          cameraXRef: { current: 0 },
          livePixelsPerSecondRef: { current: 20 },
          pixelsPerSecond: 20,
        }}
        lane={{ handlers, readOnly: true, onContextMenu: () => undefined }}
      />,
    );
    const hotspot = container.querySelector(".lt-video-clip-hotspot")!;
    expect(hotspot.classList.contains("is-read-only")).toBe(true);
    expect(container.querySelector(".lt-video-trim")).toBeNull();
    expect(container.querySelector(".lt-video-fade")).toBeNull();

    fireEvent.pointerDown(hotspot, { button: 0, pointerId: 1, clientX: 20 });
    fireEvent.pointerMove(hotspot, { pointerId: 1, clientX: 200 });
    fireEvent.pointerUp(hotspot, { pointerId: 1, clientX: 200 });
    expect(handlers.moveClip).not.toHaveBeenCalled();
    expect(useVideoStore.getState().selectedVideoClipIds).toEqual([]);
  });
});
