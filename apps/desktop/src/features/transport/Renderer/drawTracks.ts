import type { ClipSummary, SongView, TrackSummary } from "../desktopApi";
import type { TrackSceneSnapshot, TimelineViewportMetrics } from "./TimelineRenderer";
import { clamp, secondsToScreenX } from "../timelineMath";
import { WaveformTileCache, WAVEFORM_TILE_WIDTH_PX } from "./WaveformTileCache";

const waveformTileCache = new WaveformTileCache();

export function drawTrackCanvasBackground(
  context: CanvasRenderingContext2D,
  snapshot: TrackSceneSnapshot,
) {
  context.fillStyle = "#0e0e0e";
  context.fillRect(0, 0, snapshot.width, snapshot.height);
}

function clipScreenBounds(
  clip: ClipSummary,
  startSeconds: number,
  cameraX: number,
  pixelsPerSecond: number,
) {
  return {
    left: secondsToScreenX(startSeconds, cameraX, pixelsPerSecond),
    width: clip.durationSeconds * pixelsPerSecond,
  };
}

function drawWaveformPlaceholder(
  context: CanvasRenderingContext2D,
  left: number,
  width: number,
  top: number,
  height: number,
) {
  context.save();
  context.beginPath();
  context.roundRect(left, top, width, height, 2);
  context.clip();

  context.fillStyle = "rgba(255, 255, 255, 0.12)";
  for (let offset = left - 24; offset < left + width + 24; offset += 18) {
    context.fillRect(offset, top + 6, 8, Math.max(4, height - 12));
  }

  context.strokeStyle = "rgba(36, 38, 36, 0.18)";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(left + 8, top + height * 0.5);
  context.lineTo(left + width - 8, top + height * 0.5);
  context.stroke();
  context.restore();
}

function resolveVisibleTrackWindow(
  trackCount: number,
  trackHeight: number,
  viewportScrollTop: number,
  viewportHeight: number,
) {
  const safeTrackHeight = Math.max(1, trackHeight);
  const safeScrollTop = Math.max(0, viewportScrollTop);
  const safeViewportHeight = Math.max(safeTrackHeight, viewportHeight || safeTrackHeight);
  const startIndex = clamp(Math.floor(safeScrollTop / safeTrackHeight) - 1, 0, trackCount);
  const endIndex = clamp(
    Math.ceil((safeScrollTop + safeViewportHeight) / safeTrackHeight) + 1,
    startIndex,
    trackCount,
  );

  return {
    startIndex,
    endIndex,
    startY: startIndex * safeTrackHeight,
    endY: endIndex * safeTrackHeight,
  };
}

export function drawTrackClipsLayer(
  context: CanvasRenderingContext2D,
  snapshot: TrackSceneSnapshot,
  viewport: TimelineViewportMetrics,
) {
  const { startIndex: visibleTrackStart, endIndex: visibleTrackEnd, startY, endY } =
    resolveVisibleTrackWindow(
      snapshot.visibleTracks.length,
      snapshot.trackHeight,
      viewport.scrollTop,
      viewport.height,
    );

  context.save();
  context.clearRect(0, 0, snapshot.width, snapshot.height);

  for (let trackIndex = visibleTrackStart; trackIndex < visibleTrackEnd; trackIndex += 1) {
    const track = snapshot.visibleTracks[trackIndex];
    const trackTop = trackIndex * snapshot.trackHeight;
    const childCount = snapshot.song.tracks.filter((candidate) => candidate.parentTrackId === track.id).length;

    if (track.kind === "folder") {
      context.fillStyle = "rgba(32, 31, 31, 0.78)";
      context.fillRect(
        8,
        trackTop,
        Math.max(0, snapshot.width - 16),
        snapshot.trackHeight,
      );
      context.fillStyle = "#bacac5";
      context.font = '600 10px "Space Grotesk", sans-serif';
      context.textBaseline = "middle";
      context.fillText(
        childCount ? `${childCount} tracks dentro del folder` : "Folder track",
        20,
        trackTop + snapshot.trackHeight / 2 - 4,
      );
      continue;
    }

    const trackClips = snapshot.clipsByTrack[track.id] ?? [];
    for (const clip of trackClips) {
      const previewStartSeconds = snapshot.clipPreviewSecondsRef.current[clip.id] ?? clip.timelineStartSeconds;
      const { left, width } = clipScreenBounds(
        clip,
        previewStartSeconds,
        snapshot.cameraX,
        snapshot.zoomLevel,
      );
      const right = left + width;

      if (right < 0 || left > snapshot.width || width <= 1) {
        continue;
      }

      const clippedLeft = clamp(left, 0, snapshot.width);
      const clippedRight = clamp(right, 0, snapshot.width);
      const visibleWidth = Math.max(2, clippedRight - clippedLeft);
      const clipTop = trackTop;
      const clipHeight = snapshot.trackHeight;

      context.fillStyle = "rgba(210, 212, 209, 0.92)";
      context.strokeStyle =
        snapshot.selectedClipId === clip.id ? "rgba(87, 241, 219, 0.9)" : "rgba(12, 12, 12, 0.28)";
      context.lineWidth = snapshot.selectedClipId === clip.id ? 1.5 : 1;
      context.beginPath();
      context.roundRect(clippedLeft, clipTop, visibleWidth, clipHeight, 2);
      context.fill();
      context.stroke();

      const waveform = snapshot.waveformCache[clip.waveformKey];
      if (waveform) {
        context.save();
        context.beginPath();
        context.roundRect(clippedLeft, clipTop, visibleWidth, clipHeight, 2);
        context.clip();
        const visiblePixelStart = Math.max(0, -left);
        const visiblePixelEnd = Math.min(width, snapshot.width - left);
        const startTileIndex = Math.max(0, Math.floor(visiblePixelStart / WAVEFORM_TILE_WIDTH_PX));
        const endTileIndex = Math.max(
          startTileIndex,
          Math.ceil(visiblePixelEnd / WAVEFORM_TILE_WIDTH_PX) - 1,
        );

        for (let tileIndex = startTileIndex; tileIndex <= endTileIndex; tileIndex += 1) {
          const tile = waveformTileCache.getTile({
            clip,
            waveform,
            pixelsPerSecond: snapshot.zoomLevel,
            clipPixelWidth: width,
            tileIndex,
          });
          if (!tile) {
            continue;
          }

          context.drawImage(
            tile.canvas,
            left + tile.tileStartPixel,
            clipTop,
            tile.tileWidth,
            clipHeight,
          );
        }
        context.restore();
      } else {
        drawWaveformPlaceholder(context, clippedLeft, visibleWidth, clipTop, clipHeight);
      }

      if (visibleWidth >= 52) {
        context.save();
        context.beginPath();
        context.rect(clippedLeft, clipTop, visibleWidth, clipHeight);
        context.clip();
        context.fillStyle = "rgba(255, 255, 255, 0.34)";
        context.beginPath();
        context.roundRect(clippedLeft + 6, clipTop + 4, Math.min(visibleWidth - 12, 96), 18, 2);
        context.fill();
        context.fillStyle = "rgba(36, 38, 36, 0.95)";
        context.font = '600 10px "Space Grotesk", sans-serif';
        context.textBaseline = "middle";
        context.fillText(clip.trackName, clippedLeft + 12, clipTop + 13);
        context.restore();
      }
    }
  }

  context.strokeStyle = "rgba(229, 226, 225, 0.05)";
  context.lineWidth = 1;
  for (let index = visibleTrackStart + 1; index <= visibleTrackEnd; index += 1) {
    const y = Math.round(index * snapshot.trackHeight) + 0.5;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(snapshot.width, y);
    context.stroke();
  }
  context.restore();
}

export function buildTrackStructureSignature(song: SongView, visibleTracks: TrackSummary[]) {
  const trackStructureSignature = song.tracks
    .map((track) => [track.id, track.kind, track.parentTrackId ?? "root"].join(":"))
    .join("|");
  const visibleTrackOrderSignature = visibleTracks.map((track) => track.id).join("|");
  return `${trackStructureSignature}#visible=${visibleTrackOrderSignature}`;
}
