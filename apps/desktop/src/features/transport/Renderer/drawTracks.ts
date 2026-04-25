import type { ClipSummary, SongView, TrackSummary, WaveformLodDto, WaveformSummaryDto } from "../desktopApi";
import type { TrackSceneSnapshot, TimelineViewportMetrics } from "./TimelineRenderer";
import { clamp, secondsToScreenX } from "../timelineMath";

const TRACK_CLIP_TOP_PADDING = 1;
const TRACK_CLIP_BOTTOM_PADDING = 1;
const decodedWaveformLodCache = new WeakMap<WaveformLodDto, ResolvedWaveformLod>();

type ResolvedWaveformLod = {
  resolutionFrames: number;
  bucketCount: number;
  minPeaks: Float32Array;
  maxPeaks: Float32Array;
};

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

function drawWaveformShape(
  context: CanvasRenderingContext2D,
  clip: ClipSummary,
  waveform: WaveformSummaryDto | undefined,
  pixelsPerSecond: number,
  canvasWidth: number,
  left: number,
  width: number,
  top: number,
  height: number,
) {
  const waveformLod = selectWaveformLod(waveform, pixelsPerSecond);
  const maxPeaks = waveformLod?.maxPeaks ?? new Float32Array(0);
  const minPeaks = waveformLod?.minPeaks ?? new Float32Array(0);
  if (!maxPeaks.length || !minPeaks.length || width < 2 || height < 2 || clip.sourceDurationSeconds <= 0) {
    return;
  }

  const visiblePixelStart = Math.max(0, -left);
  const visiblePixelEnd = Math.min(width, canvasWidth - left);
  if (visiblePixelStart >= visiblePixelEnd) {
    return;
  }

  const clipStartRatio = clamp(clip.sourceStartSeconds / clip.sourceDurationSeconds, 0, 1);
  const clipSpanRatio = clamp(clip.durationSeconds / clip.sourceDurationSeconds, 0, 1);
  const clipStartIndex = Math.max(0, Math.floor(clipStartRatio * maxPeaks.length));
  const clipEndIndex = Math.min(
    maxPeaks.length,
    Math.max(clipStartIndex + 1, Math.ceil((clipStartRatio + clipSpanRatio) * maxPeaks.length)),
  );
  const clipSampleCount = clipEndIndex - clipStartIndex;
  if (clipSampleCount <= 0) {
    return;
  }

  const startIndex = Math.max(
    clipStartIndex,
    clipStartIndex + Math.floor((visiblePixelStart / width) * clipSampleCount),
  );
  const endIndex = Math.min(
    clipEndIndex,
    Math.max(startIndex + 1, clipStartIndex + Math.ceil((visiblePixelEnd / width) * clipSampleCount)),
  );
  if (startIndex >= endIndex || startIndex >= minPeaks.length) {
    return;
  }

  context.save();
  context.fillStyle = waveform?.isPreview ? "rgba(20, 20, 20, 0.34)" : "rgba(20, 20, 20, 0.72)";
  context.lineJoin = "round";
  context.lineCap = "round";
  context.beginPath();
  const xDenominator = Math.max(1, clipSampleCount - 1);
  const pxPerBucket = width / xDenominator;
  const shouldUseSteppedPeaks = pxPerBucket > 5;
  let previousTopY = 0;

  for (let index = startIndex; index < endIndex; index += 1) {
    const x = left + ((index - clipStartIndex) / xDenominator) * width;
    const y = top + height * 0.5 - clamp(maxPeaks[index], -1, 1) * height * 0.42;
    if (index === startIndex) {
      context.moveTo(x, y);
      previousTopY = y;
    } else {
      if (shouldUseSteppedPeaks) {
        context.lineTo(x, previousTopY);
      }
      context.lineTo(x, y);
      previousTopY = y;
    }
  }

  let previousBottomY = 0;
  for (let index = endIndex - 1; index >= startIndex; index -= 1) {
    const x = left + ((index - clipStartIndex) / xDenominator) * width;
    const y = top + height * 0.5 - clamp(minPeaks[index], -1, 1) * height * 0.42;
    if (index === endIndex - 1) {
      previousBottomY = y;
    } else if (shouldUseSteppedPeaks) {
      context.lineTo(x, previousBottomY);
    }
    context.lineTo(x, y);
    previousBottomY = y;
  }

  context.closePath();
  context.fill();
  context.restore();
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

function decodeBase64ToBytes(base64: string) {
  if (typeof atob === "function") {
    const decoded = atob(base64);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) {
      bytes[index] = decoded.charCodeAt(index);
    }

    return bytes;
  }

  return new Uint8Array(0);
}

export function decodeFloat32Peaks(base64: string | undefined, expectedCount: number) {
  if (!base64 || expectedCount <= 0) {
    return new Float32Array(0);
  }

  const bytes = decodeBase64ToBytes(base64);
  const availableCount = Math.min(expectedCount, Math.floor(bytes.byteLength / 4));
  const values = new Float32Array(availableCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let index = 0; index < availableCount; index += 1) {
    values[index] = view.getFloat32(index * 4, true);
  }

  return values;
}

function resolveWaveformLod(lod: WaveformLodDto): ResolvedWaveformLod {
  const cached = decodedWaveformLodCache.get(lod);
  if (cached) {
    return cached;
  }

  const resolved = {
    resolutionFrames: lod.resolutionFrames,
    bucketCount: lod.bucketCount,
    minPeaks: lod.minPeaks
      ? Float32Array.from(lod.minPeaks)
      : decodeFloat32Peaks(lod.minPeaksBase64, lod.bucketCount),
    maxPeaks: lod.maxPeaks
      ? Float32Array.from(lod.maxPeaks)
      : decodeFloat32Peaks(lod.maxPeaksBase64, lod.bucketCount),
  };
  decodedWaveformLodCache.set(lod, resolved);
  return resolved;
}

export function selectWaveformLod(
  waveform: WaveformSummaryDto | undefined,
  pixelsPerSecond: number,
): ResolvedWaveformLod | null {
  if (!waveform?.lods.length) {
    return null;
  }

  const framesPerPixel =
    waveform.sampleRate > 0 && pixelsPerSecond > 0
      ? waveform.sampleRate / pixelsPerSecond
      : waveform.lods[0].resolutionFrames;
  let selectedLod = waveform.lods[0];

  for (const lod of waveform.lods) {
    if (lod.resolutionFrames <= framesPerPixel) {
      selectedLod = lod;
      continue;
    }

    break;
  }

  return resolveWaveformLod(selectedLod);
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
  const visibleHeight = Math.max(1, endY - startY);

  context.save();
  context.beginPath();
  context.rect(0, startY, snapshot.width, visibleHeight);
  context.clip();
  context.clearRect(0, startY, snapshot.width, visibleHeight);

  for (let trackIndex = visibleTrackStart; trackIndex < visibleTrackEnd; trackIndex += 1) {
    const track = snapshot.visibleTracks[trackIndex];
    const trackTop = trackIndex * snapshot.trackHeight;
    const childCount = snapshot.song.tracks.filter((candidate) => candidate.parentTrackId === track.id).length;

    if (track.kind === "folder") {
      context.fillStyle = "rgba(32, 31, 31, 0.78)";
      context.fillRect(8, trackTop + 8, Math.max(0, snapshot.width - 16), snapshot.trackHeight - 16);
      context.fillStyle = "#bacac5";
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
      const clipTop = trackTop + TRACK_CLIP_TOP_PADDING;
      const clipHeight = Math.max(12, snapshot.trackHeight - TRACK_CLIP_TOP_PADDING - TRACK_CLIP_BOTTOM_PADDING);

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
        drawWaveformShape(
          context,
          clip,
          waveform,
          snapshot.zoomLevel,
          snapshot.width,
          left,
          width,
          clipTop,
          clipHeight,
        );
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