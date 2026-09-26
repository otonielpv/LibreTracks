import type { SongView, VideoClipSummary } from "../desktopApi";
import { secondsToScreenX } from "../timeline/timelineMath";
import {
  getThumbnailStrip,
  getVideoClipPreview,
  thumbnailIndexForMediaTime,
} from "../video/videoCanvasState";
import type { TrackSceneSnapshot } from "./TimelineRenderer";

/**
 * Paints one video track: each clip as a box filled with its thumbnail strip,
 * its fades, its name and, when the file is gone, a "missing" hatch.
 *
 * Thumbnails are drawn in the canvas, not as HTML over the lane: the lane area
 * has no camera wrapper, so overlays would have to chase the camera on rAF
 * (see the ruler-vs-lane coordinate note in docs/plans/video-output/00-DISENO.md).
 */

/** Teal: distinct from audio (track colour), MIDI (violet) and automation (pink). */
export const VIDEO_ACCENT = "#3fb8af";

const clipsByTrackCache = new WeakMap<SongView, Map<string, VideoClipSummary[]>>();

function videoClipsByTrack(song: SongView): Map<string, VideoClipSummary[]> {
  const cached = clipsByTrackCache.get(song);
  if (cached) return cached;
  const byTrack = new Map<string, VideoClipSummary[]>();
  for (const clip of song.videoClips ?? []) {
    const bucket = byTrack.get(clip.trackId);
    if (bucket) bucket.push(clip);
    else byTrack.set(clip.trackId, [clip]);
  }
  for (const clips of byTrack.values()) {
    clips.sort((left, right) => left.timelineStartSeconds - right.timelineStartSeconds);
  }
  clipsByTrackCache.set(song, byTrack);
  return byTrack;
}

export type VideoLaneStyle = {
  trackColor?: string | null;
  /** Hidden track (mute): drawn dimmed. */
  muted: boolean;
  /** Mobile: video is kept but not playable or editable. */
  readOnly: boolean;
  selectedClipIds: ReadonlySet<string>;
  missingLabel: string;
};

function fileNameOf(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

/** The part of the clip that is on screen, in media seconds, sampled once per
 * thumbnail tile. Exported for tests. */
export function thumbnailTilesForClip(args: {
  clipLeft: number;
  clipRight: number;
  viewportWidth: number;
  tileWidth: number;
  startSeconds: number;
  durationSeconds: number;
  sourceStartSeconds: number;
  sourceDurationSeconds: number;
  pixelsPerSecond: number;
}): { x: number; mediaSeconds: number }[] {
  const tiles: { x: number; mediaSeconds: number }[] = [];
  if (args.tileWidth <= 0 || args.durationSeconds <= 0) return tiles;
  // Tiles are anchored to the clip's left edge so they don't shimmer while
  // the camera moves; only those intersecting the viewport are returned.
  const firstIndex = Math.max(0, Math.floor((0 - args.clipLeft) / args.tileWidth));
  const mediaPerViewSecond = args.sourceDurationSeconds / args.durationSeconds;
  for (let index = firstIndex; ; index += 1) {
    const x = args.clipLeft + index * args.tileWidth;
    if (x >= args.clipRight || x >= args.viewportWidth) break;
    const viewSecondsIntoClip = (index * args.tileWidth) / args.pixelsPerSecond;
    tiles.push({
      x,
      mediaSeconds: args.sourceStartSeconds + viewSecondsIntoClip * mediaPerViewSecond,
    });
  }
  return tiles;
}

export function drawVideoLane(
  context: CanvasRenderingContext2D,
  snapshot: TrackSceneSnapshot,
  trackTop: number,
  trackId: string,
  rowHeight: number,
  style: VideoLaneStyle,
) {
  const clips = videoClipsByTrack(snapshot.song).get(trackId) ?? [];
  if (clips.length === 0) return;

  const pixelsPerSecond = snapshot.zoomLevel;
  const top = trackTop + 2;
  const height = Math.max(4, rowHeight - 4);
  const labelHeight = Math.min(16, Math.max(10, height * 0.28));

  context.save();
  if (style.muted || style.readOnly) {
    context.globalAlpha = 0.45;
  }
  context.font = '600 10px "Space Grotesk", sans-serif';
  context.textBaseline = "middle";

  for (const clip of clips) {
    const preview = getVideoClipPreview(clip.id);
    const startSeconds = preview?.startSeconds ?? clip.timelineStartSeconds;
    const durationSeconds = preview?.durationSeconds ?? clip.durationSeconds;
    const sourceStartSeconds = preview?.sourceStartSeconds ?? clip.sourceStartSeconds;
    const sourceDurationSeconds = preview
      ? clip.sourceDurationSeconds * (preview.durationSeconds / Math.max(1e-6, clip.durationSeconds))
      : clip.sourceDurationSeconds;
    const fadeIn = preview?.fadeInSeconds ?? clip.fadeInSeconds ?? 0;
    const fadeOut = preview?.fadeOutSeconds ?? clip.fadeOutSeconds ?? 0;

    const left = secondsToScreenX(startSeconds, snapshot.cameraX, pixelsPerSecond);
    const right = secondsToScreenX(
      startSeconds + durationSeconds,
      snapshot.cameraX,
      pixelsPerSecond,
    );
    if (right < 0 || left > snapshot.width) continue;

    const accent = clip.color ?? style.trackColor ?? VIDEO_ACCENT;
    const width = Math.max(2, right - left);

    // Body.
    context.save();
    context.beginPath();
    context.roundRect(left, top, width, height, 3);
    context.clip();
    context.fillStyle = "#101418";
    context.fillRect(left, top, width, height);

    // Thumbnails, or a neutral stripe pattern until they arrive.
    const strip = clip.isMissing ? null : getThumbnailStrip(clip.filePath);
    const imageTop = top + labelHeight;
    const imageHeight = Math.max(0, height - labelHeight);
    if (strip && strip.images.length > 0 && strip.width > 0 && strip.height > 0 && imageHeight > 4) {
      const tileWidth = Math.max(8, (imageHeight * strip.width) / strip.height);
      const tiles = thumbnailTilesForClip({
        clipLeft: left,
        clipRight: right,
        viewportWidth: snapshot.width,
        tileWidth,
        startSeconds,
        durationSeconds,
        sourceStartSeconds,
        sourceDurationSeconds,
        pixelsPerSecond,
      });
      for (const tile of tiles) {
        const image =
          strip.images[
            thumbnailIndexForMediaTime(tile.mediaSeconds, strip.intervalSeconds, strip.images.length)
          ];
        if (image?.complete && image.naturalWidth > 0) {
          context.drawImage(image, tile.x, imageTop, tileWidth, imageHeight);
        }
      }
    } else if (imageHeight > 4) {
      context.strokeStyle = "rgba(255, 255, 255, 0.06)";
      context.lineWidth = 6;
      const step = 14;
      const firstX = left - ((left % step) + step) % step - imageHeight;
      context.beginPath();
      for (let x = firstX; x < right; x += step) {
        context.moveTo(x, imageTop + imageHeight);
        context.lineTo(x + imageHeight, imageTop);
      }
      context.stroke();
    }

    // Fades: the faded part darkens towards the clip edge, and a line shows
    // the ramp like on audio clips.
    const drawFade = (fadeSeconds: number, atStart: boolean) => {
      if (fadeSeconds <= 0) return;
      const fadeWidth = Math.min(width, fadeSeconds * pixelsPerSecond);
      const edge = atStart ? left : right;
      const inner = atStart ? left + fadeWidth : right - fadeWidth;
      context.fillStyle = "rgba(0, 0, 0, 0.5)";
      context.beginPath();
      context.moveTo(edge, top);
      context.lineTo(inner, top);
      context.lineTo(edge, top + height);
      context.closePath();
      context.fill();
      context.strokeStyle = accent;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(edge, top + height);
      context.lineTo(inner, top);
      context.stroke();
    };
    drawFade(fadeIn, true);
    drawFade(fadeOut, false);

    // Name band.
    context.fillStyle = accent;
    context.globalAlpha *= 0.9;
    context.fillRect(left, top, width, labelHeight);
    context.globalAlpha /= 0.9;
    const name = fileNameOf(clip.filePath);
    const textLeft = Math.max(left, 0) + 5;
    const available = right - textLeft - 4;
    if (available > 12) {
      context.fillStyle = "#07120f";
      context.save();
      context.beginPath();
      context.rect(textLeft, top, available, labelHeight);
      context.clip();
      const label = clip.isMissing ? `${style.missingLabel} · ${name}` : name;
      context.fillText(label, textLeft, top + labelHeight / 2 + 0.5);
      context.restore();
    }

    if (clip.isMissing) {
      context.strokeStyle = "rgba(255, 90, 90, 0.55)";
      context.lineWidth = 2;
      context.beginPath();
      for (let x = left - height; x < right; x += 10) {
        context.moveTo(x, top + height);
        context.lineTo(x + height, top);
      }
      context.stroke();
    }
    context.restore();

    // Outline (and selection) outside the clip path so it is not cut.
    context.lineWidth = style.selectedClipIds.has(clip.id) ? 2 : 1;
    context.strokeStyle = style.selectedClipIds.has(clip.id) ? "#ffffff" : accent;
    context.beginPath();
    context.roundRect(left + 0.5, top + 0.5, width - 1, height - 1, 3);
    context.stroke();
  }
  context.restore();
}
