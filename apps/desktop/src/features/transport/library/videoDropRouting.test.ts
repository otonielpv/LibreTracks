import { describe, expect, it, vi } from "vitest";

import { classifyDroppedPaths, isAcceptedDroppedFileName } from "./dragDrop";
import {
  divertVideoPaths,
  routeCompactDroppedVideos,
  routeDomDroppedVideos,
  routeDroppedVideos,
} from "./videoDropRouting";
import type { SongView } from "../desktopApi";

describe("video drop classification", () => {
  it("classifies a video-only drop as video", () => {
    expect(classifyDroppedPaths(["C:/v/intro.mp4", "D:/x/Coro.MOV"])).toEqual({
      kind: "video",
      videoPaths: ["C:/v/intro.mp4", "D:/x/Coro.MOV"],
    });
  });

  it("keeps audio and video apart in a mixed media drop", () => {
    expect(classifyDroppedPaths(["a.wav", "v.mkv"])).toEqual({
      kind: "audio",
      audioPaths: ["a.wav"],
      videoPaths: ["v.mkv"],
    });
  });

  it("still rejects a video dropped together with an unsupported file", () => {
    expect(classifyDroppedPaths(["v.mp4", "notes.txt"]).kind).toBe("unsupported");
  });

  it("accepts video file names at the drop entry point", () => {
    expect(isAcceptedDroppedFileName("clip.webm")).toBe(true);
    expect(isAcceptedDroppedFileName("clip.txt")).toBe(false);
  });
});

describe("video drop routing", () => {
  const sink = () => ({
    importVideoPaths: vi.fn(),
    setStatus: vi.fn(),
    t: (key: string) => key,
  });

  it("sends a video-only drop to the video feature with its placement", () => {
    const target = sink();
    const handled = routeDroppedVideos(
      target,
      { kind: "video", videoPaths: ["v.mp4"] },
      { seconds: 4, trackId: "t1" },
    );
    expect(handled).toBe(true);
    expect(target.importVideoPaths).toHaveBeenCalledWith(["v.mp4"], {
      seconds: 4,
      trackId: "t1",
    });
  });

  it("routes the videos of a mixed drop and leaves the audio to the audio importer", () => {
    const target = sink();
    const handled = routeDroppedVideos(
      target,
      { kind: "audio", audioPaths: ["a.wav"], videoPaths: ["v.mp4"] },
      { seconds: 0, trackId: null },
    );
    expect(handled).toBe(false);
    expect(target.importVideoPaths).toHaveBeenCalledWith(["v.mp4"], { seconds: 0, trackId: null });
  });

  it("never lets a video reach the audio importer from the library dialog", () => {
    const target = sink();
    expect(divertVideoPaths(target, ["a.wav", "v.mp4", "b.flac"], null)).toEqual([
      "a.wav",
      "b.flac",
    ]);
    expect(target.importVideoPaths).toHaveBeenCalledWith(["v.mp4"], null);
  });

  it("explains why where video is unavailable (mobile)", () => {
    const target = { setStatus: vi.fn(), t: (key: string) => key };
    routeDroppedVideos(target, { kind: "video", videoPaths: ["v.mp4"] }, { seconds: 0, trackId: null });
    expect(target.setStatus).toHaveBeenCalledWith("transport.video.desktopOnly");
  });
});

describe("DOM and compact video drops", () => {
  const sink = () => ({ importVideoPaths: vi.fn(), setStatus: vi.fn(), t: (key: string) => key });

  it("DOM files without a path are left to the native drop event", () => {
    const target = sink();
    const video = new File([new Uint8Array([1])], "Letras.mp4");
    expect(routeDomDroppedVideos(target, [video], 12)).toBe(false);
    expect(target.importVideoPaths).not.toHaveBeenCalled();
    expect(target.setStatus).not.toHaveBeenCalled();
  });

  it("DOM files with a path import at the drop position", () => {
    const target = sink();
    const video = Object.assign(new File([new Uint8Array([1])], "Letras.mp4"), { path: "D:/v/Letras.mp4" });
    expect(routeDomDroppedVideos(target, [video], 12)).toBe(true);
    expect(target.importVideoPaths).toHaveBeenCalledWith(["D:/v/Letras.mp4"], { seconds: 12, trackId: null });
    // Nothing to do without videos.
    expect(routeDomDroppedVideos(target, [], 12)).toBe(true);
  });

  it("videos dropped on a compact song column land at the song start", () => {
    const target = sink();
    const song = { regions: [{ id: "r2", startSeconds: 40 }] } as unknown as SongView;
    const handled = routeCompactDroppedVideos(target, classifyDroppedPaths(["D:/v/a.mp4"]), song, "r2");
    expect(handled).toBe(true);
    expect(target.importVideoPaths).toHaveBeenCalledWith(["D:/v/a.mp4"], { seconds: 40, trackId: null });
    expect(routeCompactDroppedVideos(target, classifyDroppedPaths(["a.wav"]), song, "r2")).toBe(false);
  });
});
