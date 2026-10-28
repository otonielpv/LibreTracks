import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assignFolderCover, MAX_COVER_FILE_BYTES, normalizeCoverImage, pickCoverFile } from "./songCover";
import { placeLibraryFolderOnTimeline, type LibraryFolderDropDeps } from "../library/libraryFolderDrop";

const api = vi.hoisted(() => ({
  findSongCoverImages: vi.fn(), setSongRegionCover: vi.fn(), isTauriApp: true,
  createSongRegion: vi.fn(), getSongView: vi.fn(), updateSongRegion: vi.fn(),
}));
vi.mock("../desktopApi", () => api);

const drawImage = vi.fn();
const toDataURL = vi.fn(() => "data:image/jpeg;base64,/9j/2Q==");
beforeEach(() => {
  vi.clearAllMocks();
  api.findSongCoverImages.mockResolvedValue([]);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ fillRect: vi.fn(), drawImage } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(toDataURL);
  vi.stubGlobal("Image", class {
    naturalWidth = 1600;
    naturalHeight = 800;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(value: string) { queueMicrotask(() => value === "broken" ? this.onerror?.() : this.onload?.()); }
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

describe("song covers", () => {
  it("converts and bounds the image without changing its aspect ratio", async () => {
    expect(await normalizeCoverImage("image")).toBe("data:image/jpeg;base64,/9j/2Q==");
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 384, 192);
    expect(toDataURL).toHaveBeenCalledWith("image/jpeg", 0.82);
  });

  it("rejects oversized and damaged files", async () => {
    const file = new File([new Uint8Array(MAX_COVER_FILE_BYTES + 1)], "cover.png");
    await expect(normalizeCoverImage(file)).rejects.toThrow("8 MB");
    await expect(normalizeCoverImage("broken")).rejects.toThrow("Invalid cover");
  });

  it("tries the next candidate when the preferred image is damaged", async () => {
    api.findSongCoverImages.mockResolvedValue(["broken", "valid"]);
    api.setSongRegionCover.mockResolvedValue({ projectRevision: 3 });
    expect(await assignFolderCover("song", ["/music/Song/drums.wav"], "Song")).toEqual({ projectRevision: 3 });
    expect(api.findSongCoverImages).toHaveBeenCalledWith(["/music/Song/drums.wav"], "Song");
    expect(api.setSongRegionCover).toHaveBeenCalledWith("song", "data:image/jpeg;base64,/9j/2Q==");
  });

  it("does not assign a cover when there are no images", async () => {
    expect(await assignFolderCover("song", ["drums.wav"], "Song")).toBeNull();
    expect(api.setSongRegionCover).not.toHaveBeenCalled();
  });

  it("a library folder creates a named song and assigns its cover before refreshing", async () => {
    api.getSongView.mockResolvedValue({ regions: [{ id: "song", startSeconds: 0, endSeconds: 60 }] });
    api.createSongRegion.mockResolvedValue({ projectRevision: 1 });
    api.updateSongRegion.mockResolvedValue({ projectRevision: 2 });
    api.findSongCoverImages.mockResolvedValue(["valid"]);
    api.setSongRegionCover.mockResolvedValue({ projectRevision: 3 });
    const deps: LibraryFolderDropDeps = {
      t: (key) => key,
      getSong: () => null,
      resolveAsset: (filePath, durationSeconds) => ({ filePath, durationSeconds, fileName: "drums.wav", isMissing: false }),
      placeAssets: vi.fn(async () => {}),
      applyPlaybackSnapshot: vi.fn(),
      refreshSongView: vi.fn(async () => {}),
      setStatus: vi.fn(),
    };
    await placeLibraryFolderOnTimeline(deps, {
      payload: [{ file_path: "/music/Song/drums.wav", durationSeconds: 60 }],
      folderName: "Song", timelineStartSeconds: 0, layout: "vertical",
    });
    expect(api.updateSongRegion).toHaveBeenCalledWith("song", "Song", 0, 60);
    expect(api.findSongCoverImages).toHaveBeenCalledWith(["/music/Song/drums.wav"], "Song");
    expect(deps.applyPlaybackSnapshot).toHaveBeenLastCalledWith({ projectRevision: 3 });
    expect(deps.refreshSongView).toHaveBeenCalledWith({ sync: true });
  });

  it("cleans up the picker on selection or cancellation", () => {
    const selected = vi.fn();
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    pickCoverFile(selected);
    const input = document.querySelector("input")!;
    const file = new File(["image"], "cover.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));
    expect(selected).toHaveBeenCalledWith(file);
    expect(document.querySelector("input")).toBeNull();
    pickCoverFile(selected);
    document.querySelector("input")!.dispatchEvent(new Event("cancel"));
    expect(document.querySelector("input")).toBeNull();
  });
});