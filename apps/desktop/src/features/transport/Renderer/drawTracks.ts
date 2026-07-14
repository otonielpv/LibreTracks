import type { SongView } from "../desktopApi";
import { getPendingClipLabel, type TimelineClipSummary, type TimelineTrackSummary } from "../library/pendingAudioImports";
import { clipDisplayName } from "../helpers";
// The canvas renderer is not a React component, so it reads from the i18n
// singleton directly (whose .t always reflects the current language) rather
// than threading `t` through every snapshot construction site.
import i18n from "../../../shared/i18n";
import type { TrackSceneSnapshot, TimelineViewportMetrics } from "./TimelineRenderer";
import { clamp, secondsToScreenX } from "../timeline/timelineMath";
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

/**
 * Paint the automation cues as diamonds along the synthetic automation track's
 * row. Mirrors the old ruler-lane look (drawRulerAutomationCue) but anchored to
 * the track's `top`/`trackHeight` instead of a fixed header lane.
 */
/** Truncate `text` with an ellipsis so it fits within `maxTextWidth` px. Returns
 * null when not even a single char + ellipsis fits (caller then hides the label,
 * Ableton-style: the diamond stays, the text drops). */
function fitLabel(
  context: CanvasRenderingContext2D,
  text: string,
  maxTextWidth: number,
): string | null {
  if (context.measureText(text).width <= maxTextWidth) {
    return text;
  }
  const ellipsis = "…";
  if (context.measureText(ellipsis).width > maxTextWidth) {
    return null;
  }
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (context.measureText(text.slice(0, mid) + ellipsis).width <= maxTextWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo > 0 ? text.slice(0, lo) + ellipsis : null;
}

export function drawAutomationLane(
  context: CanvasRenderingContext2D,
  snapshot: TrackSceneSnapshot,
  trackTop: number,
) {
  const laneHeight = snapshot.trackHeight;
  const centerY = trackTop + laneHeight / 2;

  // Ableton-style collision handling: a cue's label may only extend up to the
  // next cue's diamond. Sort by time so each cue knows where its neighbour is.
  const cues = [...(snapshot.song.automationCues ?? [])].sort(
    (left, right) => left.atSeconds - right.atSeconds,
  );

  const LABEL_PADDING_X = 8;
  const LABEL_GAP = 10; // min px between this label's end and the next diamond
  const DIAMOND_HALF = 6;

  context.font = '700 10px "Space Grotesk", sans-serif';

  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    const x = secondsToScreenX(cue.atSeconds, snapshot.cameraX, snapshot.zoomLevel);
    const snappedX = Math.round(x) + 0.5;

    // The diamond always draws (the anchor never disappears). Cull only when the
    // diamond itself is well off-screen.
    if (snappedX < -DIAMOND_HALF - 2 || snappedX > snapshot.width + DIAMOND_HALF + 2) {
      continue;
    }

    const strokeStyle = cue.enabled
      ? "rgba(255, 122, 182, 0.85)"
      : "rgba(186, 202, 197, 0.34)";
    const fillStyle = cue.enabled
      ? "rgba(255, 122, 182, 0.16)"
      : "rgba(186, 202, 197, 0.08)";
    const textStyle = cue.enabled ? "#ff9bcc" : "rgba(186, 202, 197, 0.62)";

    context.save();
    context.strokeStyle = strokeStyle;
    context.fillStyle = fillStyle;
    context.lineWidth = 1.2;

    // Full-height stem.
    context.beginPath();
    context.moveTo(snappedX, trackTop + 3);
    context.lineTo(snappedX, trackTop + laneHeight - 3);
    context.stroke();

    // Diamond marker.
    context.beginPath();
    context.moveTo(snappedX, centerY - 6);
    context.lineTo(snappedX + 6, centerY);
    context.lineTo(snappedX, centerY + 6);
    context.lineTo(snappedX - 6, centerY);
    context.closePath();
    context.fill();
    context.stroke();

    // Label summarizes the job: the cue name plus a count when it has more than
    // a single action (e.g. "Salto a Coro  ·  +2"). Truncated to the room before
    // the next cue's diamond; if nothing fits, only the diamond remains.
    const actions = cue.actions ?? [];
    const extraCount = Math.max(0, actions.length - 1);
    const countSuffix = extraCount > 0 ? `  ·  +${extraCount}` : "";
    const baseLabel = `→ ${cue.name.replace(/^Salto a\s+/i, "")}`;
    const fullLabel = cue.enabled
      ? `${baseLabel}${countSuffix}`
      : `${baseLabel}${countSuffix} (off)`;

    const labelStart = snappedX + DIAMOND_HALF + 2;
    // Right boundary = next cue's diamond (minus a gap), or the canvas edge.
    const nextCue = cues[index + 1];
    const nextX = nextCue
      ? secondsToScreenX(nextCue.atSeconds, snapshot.cameraX, snapshot.zoomLevel)
      : Number.POSITIVE_INFINITY;
    const rightBoundary = Math.min(
      snapshot.width - 4,
      Number.isFinite(nextX) ? nextX - DIAMOND_HALF - LABEL_GAP : snapshot.width - 4,
    );
    const availableTextWidth = rightBoundary - labelStart - LABEL_PADDING_X * 2;

    const fitted =
      availableTextWidth > 8
        ? fitLabel(context, fullLabel, availableTextWidth)
        : null;

    if (fitted) {
      const textWidth = context.measureText(fitted).width;
      const pillWidth = textWidth + LABEL_PADDING_X * 2;
      context.beginPath();
      context.roundRect(labelStart, centerY - 7.5, pillWidth, 15, 4);
      context.fill();
      context.stroke();
      context.fillStyle = textStyle;
      context.textBaseline = "middle";
      context.fillText(fitted, labelStart + LABEL_PADDING_X, centerY + 0.5);
    }
    context.restore();
  }
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

    if (track.isAutomation) {
      drawAutomationLane(context, snapshot, trackTop);
      continue;
    }

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
              (key) => i18n.t(key),
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
