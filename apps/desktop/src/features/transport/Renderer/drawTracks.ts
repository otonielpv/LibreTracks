import type { SongView } from "../desktopApi";
import { getPendingClipLabel, type TimelineClipSummary, type TimelineTrackSummary } from "../pendingAudioImports";
import { clipDisplayName } from "../helpers";
import type { TrackSceneSnapshot, TimelineViewportMetrics } from "./TimelineRenderer";
import { clamp, secondsToScreenX } from "../timelineMath";
import {
  getWaveformRenderPixelsPerSecond,
  WaveformTileCache,
  WAVEFORM_TILE_WIDTH_PX,
} from "./WaveformTileCache";

const waveformTileCache = new WaveformTileCache();

export function drawTrackCanvasBackground(
  context: CanvasRenderingContext2D,
  snapshot: TrackSceneSnapshot,
) {
  context.fillStyle = "#0e0e0e";
  context.fillRect(0, 0, snapshot.width, snapshot.height);
}

function clipScreenBounds(
  clip: TimelineClipSummary,
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
  label = "ANALYZING WAVEFORM...",
) {
  context.save();
  context.beginPath();
  context.roundRect(left, top, width, height, 2);
  context.clip();

  // Solid background
  context.fillStyle = "rgba(229, 226, 225, 0.12)";
  context.fillRect(left, top, width, height);

  context.fillStyle = "rgba(20, 20, 20, 0.85)";
  context.font = '700 11px "Space Grotesk", sans-serif';
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label.toUpperCase(), left + width / 2, top + height / 2);

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

  // Vertical clip-drag preview: a clip can be temporarily painted on a lane
  // other than its own bucket. Resolve destination lane indices up front so the
  // per-clip loop can shift `clipTop` to the target row.
  const previewTrackIdByClip = snapshot.clipPreviewTrackIdRef.current;
  const trackIndexById = new Map<string, number>();
  for (let i = 0; i < snapshot.visibleTracks.length; i += 1) {
    trackIndexById.set(snapshot.visibleTracks[i].id, i);
  }

  for (let trackIndex = visibleTrackStart; trackIndex < visibleTrackEnd; trackIndex += 1) {
    const track = snapshot.visibleTracks[trackIndex];
    const trackTop = trackIndex * snapshot.trackHeight;
    const childCount = snapshot.song.tracks.filter((candidate) => candidate.parentTrackId === track.id).length;

    if (track.kind === "folder") {
      context.fillStyle = track.color ? `${track.color}33` : "rgba(32, 31, 31, 0.78)";
      context.fillRect(
        8,
        trackTop,
        Math.max(0, snapshot.width - 16),
        snapshot.trackHeight,
      );
      context.fillStyle = track.color ?? "#bacac5";
      context.font = '600 10px "Space Grotesk", sans-serif';
      context.textBaseline = "middle";
      context.fillText(
        childCount ? `${childCount} tracks dentro del folder` : "Folder track",
        20,
        trackTop + snapshot.trackHeight / 2,
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
      // While dragging vertically, paint the clip on its destination lane.
      const previewTrackId = previewTrackIdByClip[clip.id];
      const previewTrackIndex =
        previewTrackId !== undefined ? trackIndexById.get(previewTrackId) : undefined;
      const clipTop =
        previewTrackIndex !== undefined
          ? previewTrackIndex * snapshot.trackHeight
          : trackTop;
      const clipHeight = snapshot.trackHeight;
      const isSelected =
        snapshot.selectedClipId === clip.id || snapshot.selectedClipIds.includes(clip.id);

      context.fillStyle = clip.color ?? track.color ?? "rgba(210, 212, 209, 0.92)";
      context.strokeStyle =
        isSelected ? "rgba(87, 241, 219, 0.9)" : "rgba(12, 12, 12, 0.28)";
      context.lineWidth = isSelected ? 1.5 : 1;
      context.beginPath();
      context.roundRect(clippedLeft, clipTop, visibleWidth, clipHeight, 2);
      context.fill();
      context.stroke();

      const pendingLabel =
        clip.isPending ||
        clip.waveformStatus === "pending" ||
        clip.waveformStatus === "analyzing" ||
        clip.waveformStatus === "failed"
          ? getPendingClipLabel(
              clip.pendingStatus ?? (clip.waveformStatus === "failed" ? "failed" : "analyzing"),
            )
          : null;
      const waveform = snapshot.waveformCache[clip.waveformKey];
      if (pendingLabel) {
        drawWaveformPlaceholder(context, clippedLeft, visibleWidth, clipTop, clipHeight, pendingLabel);
      } else if (waveform) {
        context.save();
        context.beginPath();
        context.roundRect(clippedLeft, clipTop, visibleWidth, clipHeight, 2);
        context.clip();
        const visiblePixelStart = Math.max(0, -left);
        const visiblePixelEnd = Math.min(width, snapshot.width - left);
        const renderPixelsPerSecond = getWaveformRenderPixelsPerSecond(snapshot.zoomLevel);
        const renderScale = snapshot.zoomLevel / renderPixelsPerSecond;
        const renderClipPixelWidth = Math.max(1, clip.durationSeconds * renderPixelsPerSecond);
        const visibleRenderPixelStart = visiblePixelStart / renderScale;
        const visibleRenderPixelEnd = visiblePixelEnd / renderScale;
        const startTileIndex = Math.max(0, Math.floor(visibleRenderPixelStart / WAVEFORM_TILE_WIDTH_PX));
        const endTileIndex = Math.max(
          startTileIndex,
          Math.ceil(visibleRenderPixelEnd / WAVEFORM_TILE_WIDTH_PX) - 1,
        );

        for (let tileIndex = startTileIndex; tileIndex <= endTileIndex; tileIndex += 1) {
          const tile = waveformTileCache.getTile({
            clip,
            waveform,
            pixelsPerSecond: renderPixelsPerSecond,
            clipPixelWidth: renderClipPixelWidth,
            tileIndex,
          });
          if (!tile) {
            continue;
          }

          context.drawImage(
            tile.canvas,
            left + tile.tileStartPixel * renderScale,
            clipTop,
            tile.tileWidth * renderScale,
            clipHeight,
          );
        }
        context.restore();
        if (clip.color || track.color) {
          context.save();
          context.beginPath();
          context.roundRect(clippedLeft, clipTop, visibleWidth, clipHeight, 2);
          context.clip();
          context.fillStyle = `${clip.color ?? track.color}30`;
          context.fillRect(clippedLeft, clipTop, visibleWidth, clipHeight);
          context.restore();
        }
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
        context.fillText(clipDisplayName(clip), clippedLeft + 12, clipTop + 13);
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

export function buildTrackStructureSignature(song: SongView, visibleTracks: TimelineTrackSummary[]) {
  const trackStructureSignature = song.tracks
    .map((track) =>
      [track.id, track.kind, track.parentTrackId ?? "root", track.color ?? ""].join(":"),
    )
    .join("|");
  const visibleTrackOrderSignature = visibleTracks.map((track) => track.id).join("|");
  return `${trackStructureSignature}#visible=${visibleTrackOrderSignature}`;
}
