import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  createTrack: vi.fn(async () => ({ projectRevision: 1 })),
  deleteVideoClips: vi.fn(async () => ({ projectRevision: 2 })),
  duplicateVideoClips: vi.fn(async () => ({ projectRevision: 3 })),
  extractVideoAudio: vi.fn(async () => ({ projectRevision: 9 })),
  getSongView: vi.fn(),
  importVideoFiles: vi.fn(),
  moveVideoClip: vi.fn(async () => ({ projectRevision: 4 })),
  placeVideoClips: vi.fn(async () => ({ projectRevision: 5 })),
  splitVideoClips: vi.fn(async () => ({ projectRevision: 6 })),
  trimVideoClip: vi.fn(async () => ({ projectRevision: 7 })),
  updateVideoClip: vi.fn(async () => ({ projectRevision: 8 })),
}));
vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  ...api,
}));

import type { SongView, VideoClipSummary } from "../desktopApi";
import { createVideoClipHandlers } from "./videoClipHandlers";
import { applyVideoDrag } from "./useVideoClipHotspots";
import { INITIAL_VIDEO_STATE, useVideoStore } from "./videoStore";

function clip(overrides: Partial<VideoClipSummary> = {}): VideoClipSummary {
  return {
    id: "vc1",
    trackId: "v1",
    filePath: "D:/v.mp4",
    isMissing: false,
    timelineStartSeconds: 10,
    durationSeconds: 8,
    sourceStartSeconds: 2,
    sourceDurationSeconds: 8,
    fadeInSeconds: 1,
    fadeOutSeconds: null,
    fit: "cover",
    color: null,
    ...overrides,
  };
}

function setup(song: Partial<SongView> = { videoClips: [clip()] }) {
  const deps = {
    runAction: vi.fn(async (action: () => Promise<void>) => action()),
    applyPlaybackSnapshot: vi.fn(),
    setStatus: vi.fn(),
    translate: (key: string) => key,
    getSong: () => song as SongView,
    refreshVideoAssets: vi.fn(async () => undefined),
    reportSkipped: vi.fn(),
    onFirstVideoClip: vi.fn(),
    decideAudioExtraction: vi.fn(async () => true),
  };
  return { deps, handlers: createVideoClipHandlers(deps) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  useVideoStore.setState(INITIAL_VIDEO_STATE);
});

describe("video clip handlers", () => {
  it("moves a clip, optionally to another video track", async () => {
    const { handlers, deps } = setup();
    handlers.moveClip("vc1", 12.5, "v2");
    await flush();
    expect(api.moveVideoClip).toHaveBeenCalledWith("vc1", 12.5, "v2");
    expect(deps.applyPlaybackSnapshot).toHaveBeenCalledWith({ projectRevision: 4 });
  });

  it("trims a clip to a view-time range", async () => {
    const { handlers } = setup();
    handlers.trimClip("vc1", 11, 16);
    await flush();
    expect(api.trimVideoClip).toHaveBeenCalledWith("vc1", 11, 16);
  });

  it("changes one property and keeps the others", async () => {
    const { handlers } = setup();
    handlers.setFit("vc1", "stretch");
    await flush();
    expect(api.updateVideoClip).toHaveBeenCalledWith("vc1", {
      fadeInSeconds: 1,
      fadeOutSeconds: null,
      fit: "stretch",
      color: null,
    });
    handlers.setFades("vc1", 0, 2);
    await flush();
    expect(api.updateVideoClip).toHaveBeenLastCalledWith("vc1", {
      fadeInSeconds: null,
      fadeOutSeconds: 2,
      fit: "cover",
      color: null,
    });
  });

  it("splits, duplicates and deletes the selected video clips only", async () => {
    const { handlers } = setup();
    expect(await handlers.splitSelectedAt(12)).toBe(false);
    expect(api.splitVideoClips).not.toHaveBeenCalled();

    useVideoStore.getState().setSelectedVideoClipIds(["vc1"]);
    expect(await handlers.splitSelectedAt(12)).toBe(true);
    expect(api.splitVideoClips).toHaveBeenCalledWith(["vc1"], 12);

    useVideoStore.getState().setSelectedVideoClipIds(["vc1"]);
    expect(handlers.duplicateSelected()).toBe(true);
    await flush();
    expect(api.duplicateVideoClips).toHaveBeenCalledWith(["vc1"]);

    expect(handlers.deleteSelected()).toBe(true);
    await flush();
    expect(api.deleteVideoClips).toHaveBeenCalledWith(["vc1"]);
    expect(useVideoStore.getState().selectedVideoClipIds).toEqual([]);
  });

  it("imports dropped videos and places them, announcing the first clip", async () => {
    const asset = {
      fileName: "v.mp4",
      filePath: "D:/v.mp4",
      isMissing: false,
      info: { durationSeconds: 6, width: 1, height: 1, fps: 30, codec: "h264", hasAudio: false },
      hasSlowSeeks: false,
    };
    api.importVideoFiles.mockResolvedValueOnce({ assets: [asset], skipped: [] });
    const { handlers, deps } = setup({ videoClips: [] });
    handlers.importVideoPaths(["D:/v.mp4"], { seconds: 3, trackId: "a1" });
    await flush();
    await flush();
    expect(api.placeVideoClips).toHaveBeenCalledWith(
      [{ filePath: "D:/v.mp4", durationSeconds: 6 }],
      3,
      "a1",
    );
    expect(deps.onFirstVideoClip).toHaveBeenCalledTimes(1);
  });

  it("does not announce a first clip when the song already has video", async () => {
    const asset = {
      fileName: "v.mp4",
      filePath: "D:/v.mp4",
      isMissing: false,
      info: { durationSeconds: 6, width: 1, height: 1, fps: 30, codec: "h264", hasAudio: false },
      hasSlowSeeks: false,
    };
    api.importVideoFiles.mockResolvedValueOnce({ assets: [asset], skipped: [] });
    const { handlers, deps } = setup();
    handlers.importVideoPaths(["D:/v.mp4"], { seconds: 30, trackId: "a1" });
    await flush();
    await flush();
    expect(api.placeVideoClips).toHaveBeenCalled();
    expect(deps.onFirstVideoClip).not.toHaveBeenCalled();
  });

  it("imports into the library only when there is no placement", async () => {
    api.importVideoFiles.mockResolvedValueOnce({
      assets: [],
      skipped: [{ fileName: "x.mp4", sourcePath: "x.mp4", reason: "códec no soportado" }],
    });
    const { handlers, deps } = setup();
    handlers.importVideoPaths(["x.mp4"], null);
    await flush();
    expect(api.placeVideoClips).not.toHaveBeenCalled();
    expect(deps.reportSkipped).toHaveBeenCalledWith([
      { fileName: "x.mp4", sourcePath: "x.mp4", reason: "códec no soportado" },
    ]);
  });
});

describe("video drag geometry", () => {
  it("moves without going before zero", () => {
    expect(applyVideoDrag(clip(), "move", 3, null).startSeconds).toBe(13);
    expect(applyVideoDrag(clip(), "move", -50, null).startSeconds).toBe(0);
  });

  it("trims the start and moves the media window with it, not before the first frame", () => {
    const trimmed = applyVideoDrag(clip(), "trimStart", 1.5, null);
    expect(trimmed.startSeconds).toBe(11.5);
    expect(trimmed.sourceStartSeconds).toBe(3.5);
    expect(trimmed.durationSeconds).toBe(6.5);
    // The file starts 2 s before the clip: that is as far left as it goes.
    const clamped = applyVideoDrag(clip(), "trimStart", -5, null);
    expect(clamped.startSeconds).toBe(8);
    expect(clamped.sourceStartSeconds).toBe(0);
  });

  it("trims the end, bounded by the file length when known", () => {
    expect(applyVideoDrag(clip(), "trimEnd", 4, null).durationSeconds).toBe(12);
    // 20 s file, trimmed from 2 s: at most 18 s of it fit in the clip.
    expect(applyVideoDrag(clip(), "trimEnd", 40, 20).durationSeconds).toBe(18);
    expect(applyVideoDrag(clip(), "trimEnd", -40, null).durationSeconds).toBeCloseTo(0.05);
  });

  it("keeps fades inside the clip", () => {
    expect(applyVideoDrag(clip(), "fadeIn", 2, null).fadeInSeconds).toBe(3);
    expect(applyVideoDrag(clip(), "fadeIn", 50, null).fadeInSeconds).toBe(8);
    expect(applyVideoDrag(clip(), "fadeOut", -2, null).fadeOutSeconds).toBe(2);
    expect(applyVideoDrag(clip(), "fadeOut", -50, null).fadeOutSeconds).toBe(7);
  });

  describe("audio of a video (paso 11)", () => {
    const withAudio = (hasAudio: boolean, filePath = "D:/v.mp4") => ({
      fileName: "v.mp4",
      filePath,
      isMissing: false,
      info: { durationSeconds: 6, width: 1, height: 1, fps: 30, codec: "h264", hasAudio },
      hasSlowSeeks: false,
    });

    it("offers to extract the audio of the placed videos that have sound, then extracts it", async () => {
      api.importVideoFiles.mockResolvedValueOnce({
        assets: [withAudio(true), withAudio(false, "D:/mute.mp4")],
        skipped: [],
      });
      api.getSongView.mockResolvedValueOnce({
        videoClips: [
          clip(),
          clip({ id: "new1", filePath: "D:/v.mp4" }),
          clip({ id: "new2", filePath: "D:/mute.mp4" }),
        ],
      });
      const { handlers, deps } = setup();
      handlers.importVideoPaths(["D:/v.mp4", "D:/mute.mp4"], { seconds: 30, trackId: null });
      for (let i = 0; i < 6; i += 1) await flush();

      expect(deps.decideAudioExtraction).toHaveBeenCalledWith(1);
      expect(api.extractVideoAudio).toHaveBeenCalledTimes(1);
      expect(api.extractVideoAudio).toHaveBeenCalledWith("new1");
      expect(deps.applyPlaybackSnapshot).toHaveBeenLastCalledWith({ projectRevision: 9 });
      expect(useVideoStore.getState().audioExtractions).toEqual({});
    });

    it("does not ask for videos without sound", async () => {
      api.importVideoFiles.mockResolvedValueOnce({ assets: [withAudio(false)], skipped: [] });
      const { handlers, deps } = setup();
      handlers.importVideoPaths(["D:/v.mp4"], { seconds: 30, trackId: null });
      for (let i = 0; i < 6; i += 1) await flush();
      expect(api.getSongView).not.toHaveBeenCalled();
      expect(deps.decideAudioExtraction).not.toHaveBeenCalled();
      expect(api.extractVideoAudio).not.toHaveBeenCalled();
    });

    it("a 'no' extracts nothing", async () => {
      api.importVideoFiles.mockResolvedValueOnce({ assets: [withAudio(true)], skipped: [] });
      api.getSongView.mockResolvedValueOnce({ videoClips: [clip(), clip({ id: "new1" })] });
      const { handlers, deps } = setup();
      deps.decideAudioExtraction.mockResolvedValueOnce(false);
      handlers.importVideoPaths(["D:/v.mp4"], { seconds: 30, trackId: null });
      for (let i = 0; i < 6; i += 1) await flush();
      expect(deps.decideAudioExtraction).toHaveBeenCalledWith(1);
      expect(api.extractVideoAudio).not.toHaveBeenCalled();
    });

    it("the clip menu entry is only for clips whose video has sound", () => {
      const { handlers } = setup();
      useVideoStore.getState().setAssets([withAudio(true), withAudio(false, "D:/mute.mp4")]);
      expect(handlers.clipHasAudio(clip())).toBe(true);
      expect(handlers.clipHasAudio(clip({ filePath: "D:/mute.mp4" }))).toBe(false);
      expect(handlers.clipHasAudio(clip({ filePath: "D:/unknown.mp4" }))).toBe(false);
    });
  });
});
