import type { VideoThumbnailStrip } from "../desktopApi";

/**
 * What the canvas needs about video that is not in the song: decoded
 * thumbnails and the in-flight drag preview.
 *
 * Deliberately module state, not React state: the timeline repaints at 60 fps
 * from refs (docs/REDESIGN_transport_refs_to_stores.md) and a drag must not
 * re-render the transport panel. Writers flag a repaint; the renderer's work
 * hook consumes the flag (`consumeVideoRepaint`).
 */

export type LoadedThumbnailStrip = {
  intervalSeconds: number;
  width: number;
  height: number;
  images: HTMLImageElement[];
};

const strips = new Map<string, LoadedThumbnailStrip>();
let repaintRequested = false;

export function videoPathKey(filePath: string): string {
  return filePath.replace(/\\/g, "/").toLowerCase();
}

export function requestVideoRepaint() {
  repaintRequested = true;
}

/** True once per requested repaint. Wired into the renderer's work hook. */
export function consumeVideoRepaint(): boolean {
  const requested = repaintRequested;
  repaintRequested = false;
  return requested;
}

export function getThumbnailStrip(filePath: string): LoadedThumbnailStrip | null {
  return strips.get(videoPathKey(filePath)) ?? null;
}

export function hasThumbnailStrip(filePath: string): boolean {
  return strips.has(videoPathKey(filePath));
}

/** Decode a strip's JPEGs. The canvas draws whichever images have loaded and
 * each one that finishes asks for a repaint. */
export function storeThumbnailStrip(strip: VideoThumbnailStrip) {
  const images = strip.frames.map((base64) => {
    const image = new Image();
    image.onload = requestVideoRepaint;
    image.src = `data:image/jpeg;base64,${base64}`;
    return image;
  });
  strips.set(videoPathKey(strip.filePath), {
    intervalSeconds: strip.intervalSeconds,
    width: strip.width,
    height: strip.height,
    images,
  });
  requestVideoRepaint();
}

export function forgetThumbnailStrip(filePath: string) {
  strips.delete(videoPathKey(filePath));
  requestVideoRepaint();
}

export function forgetAllThumbnailStrips() {
  strips.clear();
  requestVideoRepaint();
}

/** Index of the thumbnail showing `mediaSeconds`. Mirrors
 * `libretracks_video::thumbs::frame_index_for_media_time`. */
export function thumbnailIndexForMediaTime(
  mediaSeconds: number,
  intervalSeconds: number,
  count: number,
): number {
  if (count <= 0 || !Number.isFinite(mediaSeconds) || intervalSeconds <= 0) {
    return 0;
  }
  return Math.min(count - 1, Math.floor(Math.max(0, mediaSeconds) / intervalSeconds));
}

/** Geometry a clip is being dragged to, painted instead of the stored one. */
export type VideoClipPreview = {
  startSeconds: number;
  durationSeconds: number;
  sourceStartSeconds: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
};

const previews = new Map<string, VideoClipPreview>();

export function setVideoClipPreview(clipId: string, preview: VideoClipPreview | null) {
  if (preview) {
    previews.set(clipId, preview);
  } else {
    previews.delete(clipId);
  }
  requestVideoRepaint();
}

export function getVideoClipPreview(clipId: string): VideoClipPreview | null {
  return previews.get(clipId) ?? null;
}

/** Test hook: start every test from a clean slate. */
export function resetVideoCanvasState() {
  strips.clear();
  previews.clear();
  repaintRequested = false;
}
