import { useEffect, useMemo, useRef, type MutableRefObject, type ReactNode, type RefObject } from "react";

import type {
  ClipSummary,
  PendingJumpSummary,
  SectionMarkerSummary,
  SongRegionSummary,
  SongView,
  TrackSummary,
  WaveformLodDto,
  WaveformSummaryDto,
} from "./desktopApi";
import type { TimelineGrid } from "./timelineMath";
import { clamp, screenXToSeconds, secondsToScreenX } from "./timelineMath";

type RulerCanvasProps = {
  width: number;
  height: number;
  cameraXRef: MutableRefObject<number>;
  pixelsPerSecond: number;
  livePixelsPerSecondRef: MutableRefObject<number>;
  timelineGrid: TimelineGrid;
  regions: SongRegionSummary[];
  markers: SectionMarkerSummary[];
  selectedRegionId: string | null;
  selectedMarkerId: string | null;
  pendingMarkerJump: PendingJumpSummary | null;
  playheadSecondsRef: MutableRefObject<number>;
  playheadDragRef: MutableRefObject<{ currentSeconds: number } | null>;
  children?: ReactNode;
};

type TrackCanvasProps = {
  width: number;
  height: number;
  trackHeight: number;
  song: SongView;
  visibleTracks: TrackSummary[];
  clipsByTrack: Record<string, ClipSummary[]>;
  waveformCache: Record<string, WaveformSummaryDto>;
  cameraXRef: MutableRefObject<number>;
  pixelsPerSecond: number;
  livePixelsPerSecondRef: MutableRefObject<number>;
  scrollViewportRef: RefObject<HTMLDivElement | null>;
  timelineGrid: TimelineGrid;
  selectedClipId: string | null;
  clipPreviewSecondsRef: MutableRefObject<Record<string, number>>;
};

type TrackSceneSnapshot = Omit<
  TrackCanvasProps,
  "cameraXRef" | "livePixelsPerSecondRef" | "scrollViewportRef"
>;

const TRACK_CLIP_TOP_PADDING = 1;
const TRACK_CLIP_BOTTOM_PADDING = 1;
const decodedWaveformLodCache = new WeakMap<WaveformLodDto, ResolvedWaveformLod>();

type ResolvedWaveformLod = {
  resolutionFrames: number;
  bucketCount: number;
  minPeaks: Float32Array;
  maxPeaks: Float32Array;
};

function isRenderableCanvasSize(value: number) {
  return Number.isFinite(value) && value > 0;
}

function setupCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
  if (typeof globalThis === "object" && "__vitest_worker__" in globalThis) {
    return null;
  }

  if (
    typeof navigator !== "undefined" &&
    typeof navigator.userAgent === "string" &&
    navigator.userAgent.toLowerCase().includes("jsdom")
  ) {
    return null;
  }

  const dpr = window.devicePixelRatio || 1;
  const displayWidth = Math.max(1, Math.round(width));
  const displayHeight = Math.max(1, Math.round(height));
  const nextWidth = Math.max(1, Math.round(displayWidth * dpr));
  const nextHeight = Math.max(1, Math.round(displayHeight * dpr));

  if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
    canvas.width = nextWidth;
    canvas.height = nextHeight;
  }

  canvas.style.width = `${displayWidth}px`;
  canvas.style.height = `${displayHeight}px`;

  let context: CanvasRenderingContext2D | null = null;
  try {
    context = canvas.getContext("2d");
  } catch {
    return null;
  }

  if (!context) {
    return null;
  }

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return context;
}

function drawGridLines(
  context: CanvasRenderingContext2D,
  grid: TimelineGrid,
  width: number,
  height: number,
  cameraX: number,
  pixelsPerSecond: number,
) {
  if (grid.bars.length === 0 && grid.beats.length === 0) {
    return;
  }

  const visibleStartSeconds = Math.max(0, screenXToSeconds(0, cameraX, pixelsPerSecond));
  const visibleEndSeconds = screenXToSeconds(width, cameraX, pixelsPerSecond);
  const beatPath = grid.showBeatGridLines ? new Path2D() : null;
  const barPath = new Path2D();

  for (const seconds of grid.beats) {
    const x = Math.round(secondsToScreenX(seconds, cameraX, pixelsPerSecond)) + 0.5;
    if (seconds < visibleStartSeconds || seconds > visibleEndSeconds || x < 0 || x > width) {
      continue;
    }

    if (beatPath) {
      beatPath.moveTo(x, 0);
      beatPath.lineTo(x, height);
    }
  }

  for (const seconds of grid.bars) {
    const x = Math.round(secondsToScreenX(seconds, cameraX, pixelsPerSecond)) + 0.5;
    if (seconds < visibleStartSeconds || seconds > visibleEndSeconds || x < 0 || x > width) {
      continue;
    }

    barPath.moveTo(x, 0);
    barPath.lineTo(x, height);
  }

  if (beatPath) {
    context.strokeStyle = "rgba(186, 202, 197, 0.14)";
    context.lineWidth = 1;
    context.stroke(beatPath);
  }

  context.strokeStyle = "rgba(186, 202, 197, 0.32)";
  context.lineWidth = 1;
  context.stroke(barPath);
}

function drawPendingExecutionLine(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  cameraX: number,
  pixelsPerSecond: number,
  executeAtSeconds: number,
) {
  const x = secondsToScreenX(executeAtSeconds, cameraX, pixelsPerSecond);
  if (x < -12 || x > width + 12) {
    return;
  }

  const snappedX = Math.round(x) + 0.5;
  context.save();
  context.strokeStyle = "rgba(255, 226, 171, 0.88)";
  context.fillStyle = "rgba(255, 226, 171, 0.92)";
  context.lineWidth = 1.5;
  context.setLineDash([6, 4]);
  context.beginPath();
  context.moveTo(snappedX, 0);
  context.lineTo(snappedX, height);
  context.stroke();
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(snappedX - 5, 0);
  context.lineTo(snappedX + 5, 0);
  context.lineTo(snappedX, 8);
  context.closePath();
  context.fill();
  context.restore();
}

function drawRulerMarker(
  context: CanvasRenderingContext2D,
  marker: SectionMarkerSummary,
  width: number,
  height: number,
  cameraX: number,
  pixelsPerSecond: number,
  options: {
    isSelected: boolean;
    isArmed: boolean;
    isCurrent: boolean;
    pulseAlpha: number;
  },
) {
  const x = secondsToScreenX(marker.startSeconds, cameraX, pixelsPerSecond);
  const label = marker.digit == null ? marker.name : `${marker.digit}. ${marker.name}`;

  context.font = '600 10px "Space Grotesk", sans-serif';
  const labelWidth = Math.max(30, Math.ceil(context.measureText(label).width) + 12);
  const labelHeight = 16;
  const snappedX = Math.round(x) + 0.5;
  const stemTop = 23;
  const stemBottom = height - 10;
  const alignRight = snappedX > width - labelWidth - 12;
  const flagLeft = alignRight ? snappedX - labelWidth - 8 : snappedX + 2;
  const flagRight = flagLeft + labelWidth;
  const flagTop = 20;
  const flagBottom = flagTop + labelHeight;

  if (flagRight < -20 || flagLeft > width + 20) {
    return;
  }

  const strokeStyle = options.isArmed
    ? `rgba(87, 241, 219, ${options.pulseAlpha})`
    : options.isSelected
      ? "rgba(255, 226, 171, 0.9)"
      : options.isCurrent
        ? "rgba(229, 226, 225, 0.88)"
        : "rgba(186, 202, 197, 0.48)";
  const fillStyle = options.isArmed
    ? `rgba(87, 241, 219, ${0.22 + options.pulseAlpha * 0.22})`
    : options.isSelected
      ? "rgba(255, 226, 171, 0.18)"
      : options.isCurrent
        ? "rgba(229, 226, 225, 0.16)"
        : "rgba(186, 202, 197, 0.12)";
  const textStyle = options.isArmed
    ? "#57f1db"
    : options.isSelected
      ? "#ffe2ab"
      : options.isCurrent
        ? "#e5e2e1"
        : "#bacac5";

  context.save();
  context.strokeStyle = strokeStyle;
  context.fillStyle = fillStyle;
  context.lineWidth = options.isArmed ? 1.8 : 1.2;
  if (options.isArmed) {
    context.shadowColor = "rgba(87, 241, 219, 0.55)";
    context.shadowBlur = 10;
  }

  context.beginPath();
  context.moveTo(snappedX, stemTop + 1);
  context.lineTo(snappedX, stemBottom);
  context.stroke();

  context.beginPath();
  if (alignRight) {
    context.moveTo(snappedX, flagTop + 1);
    context.lineTo(flagRight, flagTop + 1);
    context.lineTo(flagRight, flagBottom - 1);
    context.lineTo(flagLeft + 7, flagBottom - 1);
    context.lineTo(snappedX, flagTop + labelHeight * 0.55);
  } else {
    context.moveTo(snappedX, flagTop + 1);
    context.lineTo(flagRight - 7, flagTop + 1);
    context.lineTo(flagRight, flagTop + labelHeight * 0.5);
    context.lineTo(flagRight - 7, flagBottom - 1);
    context.lineTo(snappedX, flagBottom - 1);
  }
  context.closePath();
  context.fill();
  context.stroke();

  context.shadowBlur = 0;
  context.fillStyle = textStyle;
  context.textBaseline = "middle";
  context.fillText(label, flagLeft + 6, flagTop + labelHeight / 2 + 0.5);

  context.fillStyle = textStyle;
  context.beginPath();
  context.moveTo(snappedX - 4, stemBottom);
  context.lineTo(snappedX + 4, stemBottom);
  context.lineTo(snappedX, stemBottom + 6);
  context.closePath();
  context.fill();
  context.restore();
}

function drawRulerRegion(
  context: CanvasRenderingContext2D,
  region: SongRegionSummary,
  width: number,
  cameraX: number,
  pixelsPerSecond: number,
  isSelected: boolean,
) {
  const left = secondsToScreenX(region.startSeconds, cameraX, pixelsPerSecond);
  const regionWidth = (region.endSeconds - region.startSeconds) * pixelsPerSecond;
  const right = left + regionWidth;
  if (right < -8 || left > width + 8 || regionWidth <= 0) {
    return;
  }

  const blockLeft = Math.max(-8, left);
  const blockWidth = Math.max(12, Math.min(width + 8, right) - blockLeft);
  const blockTop = 3;
  const blockHeight = 18;

  context.save();
  context.fillStyle = isSelected ? "rgba(255, 226, 171, 0.28)" : "rgba(255, 226, 171, 0.14)";
  context.strokeStyle = isSelected ? "rgba(255, 226, 171, 0.72)" : "rgba(255, 226, 171, 0.32)";
  context.lineWidth = 1;
  context.beginPath();
  context.roundRect(blockLeft, blockTop, blockWidth, blockHeight, 6);
  context.fill();
  context.stroke();

  context.beginPath();
  context.rect(blockLeft + 6, blockTop, Math.max(0, blockWidth - 12), blockHeight);
  context.clip();
  context.fillStyle = isSelected ? "#fff4d6" : "rgba(255, 244, 214, 0.92)";
  context.font = '700 10px "Space Grotesk", sans-serif';
  context.textBaseline = "middle";
  context.fillText(region.name, blockLeft + 7, blockTop + blockHeight / 2 + 0.5);
  context.restore();
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
    Math.max(
      startIndex + 1,
      clipStartIndex + Math.ceil((visiblePixelEnd / width) * clipSampleCount),
    ),
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

function decodeFloat32Peaks(base64: string | undefined, expectedCount: number) {
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

function selectWaveformLod(
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

function buildTrackStructureSignature(song: SongView, visibleTracks: TrackSummary[]) {
  const trackStructureSignature = song.tracks
    .map((track) => [track.id, track.kind, track.parentTrackId ?? "root"].join(":"))
    .join("|");
  const visibleTrackOrderSignature = visibleTracks.map((track) => track.id).join("|");
  return `${trackStructureSignature}#visible=${visibleTrackOrderSignature}`;
}

function formatClipSignatureNumber(value: number | null | undefined) {
  return (typeof value === "number" && Number.isFinite(value) ? value : 0).toFixed(6);
}

function buildClipSceneSignature(clipsByTrack: Record<string, ClipSummary[]>) {
  return Object.keys(clipsByTrack)
    .sort()
    .map((trackId) =>
      `${trackId}:${(clipsByTrack[trackId] ?? [])
        .map((clip) =>
          [
            clip.id,
            clip.trackId,
            clip.waveformKey,
            formatClipSignatureNumber(clip.timelineStartSeconds),
            formatClipSignatureNumber(clip.sourceStartSeconds),
            formatClipSignatureNumber(clip.sourceDurationSeconds),
            formatClipSignatureNumber(clip.durationSeconds),
          ].join(":"),
        )
        .join("|")}`,
    )
    .join("#");
}

function buildWaveformCacheSignature(waveformCache: Record<string, WaveformSummaryDto>) {
  return Object.entries(waveformCache)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(
      ([waveformKey, summary]) =>
        `${waveformKey}:${summary.version}:${summary.sampleRate}:${summary.lods
          .map((lod) => {
            const rawMin = lod.minPeaks?.[0]?.toFixed(4) ?? lod.minPeaksBase64?.slice(0, 12) ?? "0";
            const rawMax = lod.maxPeaks?.[0]?.toFixed(4) ?? lod.maxPeaksBase64?.slice(0, 12) ?? "0";
            return `${lod.resolutionFrames}:${lod.bucketCount}:${rawMin}:${rawMax}`;
          })
          .join(",")}:${summary.isPreview ? "preview" : "ready"}`,
    )
    .join("|");
}

function drawTrackScene(
  context: CanvasRenderingContext2D,
  snapshot: TrackSceneSnapshot,
  cameraX: number,
  pixelsPerSecond: number,
  viewportScrollTop: number,
  viewportHeight: number,
) {
  const { startIndex: visibleTrackStart, endIndex: visibleTrackEnd, startY, endY } =
    resolveVisibleTrackWindow(
      snapshot.visibleTracks.length,
      snapshot.trackHeight,
      viewportScrollTop,
      viewportHeight,
    );
  const visibleHeight = Math.max(1, endY - startY);

  context.save();
  context.beginPath();
  context.rect(0, startY, snapshot.width, visibleHeight);
  context.clip();
  context.clearRect(0, startY, snapshot.width, visibleHeight);
  context.fillStyle = "#0e0e0e";
  context.fillRect(0, startY, snapshot.width, visibleHeight);

  context.strokeStyle = "rgba(229, 226, 225, 0.05)";
  context.lineWidth = 1;
  for (let index = visibleTrackStart + 1; index <= visibleTrackEnd; index += 1) {
    const y = Math.round(index * snapshot.trackHeight) + 0.5;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(snapshot.width, y);
    context.stroke();
  }

  drawGridLines(
    context,
    snapshot.timelineGrid,
    snapshot.width,
    snapshot.height,
    cameraX,
    pixelsPerSecond,
  );

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
      const previewStartSeconds =
        snapshot.clipPreviewSecondsRef.current[clip.id] ?? clip.timelineStartSeconds;
      const { left, width: clipWidth } = clipScreenBounds(
        clip,
        previewStartSeconds,
        cameraX,
        pixelsPerSecond,
      );
      const right = left + clipWidth;

      if (right < 0 || left > snapshot.width || clipWidth <= 1) {
        continue;
      }

      const clippedLeft = clamp(left, 0, snapshot.width);
      const clippedRight = clamp(right, 0, snapshot.width);
      const visibleWidth = Math.max(2, clippedRight - clippedLeft);
      const clipTop = trackTop + TRACK_CLIP_TOP_PADDING;
      const clipHeight = Math.max(
        12,
        snapshot.trackHeight - TRACK_CLIP_TOP_PADDING - TRACK_CLIP_BOTTOM_PADDING,
      );

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
          pixelsPerSecond,
          snapshot.width,
          left,
          clipWidth,
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

  // Redraw row separators on top of clips so the visual lane grid stays aligned with track headers.
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

export function TimelineRulerCanvas({
  width,
  height,
  cameraXRef,
  pixelsPerSecond,
  livePixelsPerSecondRef,
  timelineGrid,
  regions,
  markers,
  selectedRegionId,
  selectedMarkerId,
  pendingMarkerJump,
  playheadSecondsRef,
  playheadDragRef,
  children,
}: RulerCanvasProps) {
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayContentRef = useRef<HTMLDivElement | null>(null);
  const snapshotRef = useRef({
    width,
    height,
    pixelsPerSecond,
    timelineGrid,
    regions,
    markers,
    selectedRegionId,
    selectedMarkerId,
    pendingMarkerJump,
    playheadDragRef,
  });
  const sceneVersionRef = useRef(0);

  snapshotRef.current = {
    width,
    height,
    pixelsPerSecond,
    timelineGrid,
    regions,
    markers,
    selectedRegionId,
    selectedMarkerId,
    pendingMarkerJump,
    playheadDragRef,
  };

  const regionsSignature = useMemo(
    () => regions.map((region) => `${region.id}:${region.name}:${region.startSeconds}:${region.endSeconds}`).join("|"),
    [regions],
  );

  const markersSignature = useMemo(
    () => markers.map((m) => `${m.id}:${m.startSeconds}`).join("|"),
    [markers],
  );

  const pendingJumpSignature = pendingMarkerJump
    ? `${pendingMarkerJump.targetMarkerId}:${pendingMarkerJump.executeAtSeconds}`
    : "";

  useEffect(() => {
    sceneVersionRef.current += 1;
  }, [
    height,
    regionsSignature,
    markersSignature,
    pendingJumpSignature,
    pixelsPerSecond,
    selectedRegionId,
    selectedMarkerId,
    timelineGrid,
    width,
  ]);

  useEffect(() => {
    const baseCanvas = baseCanvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    if (!baseCanvas || !overlayCanvas) {
      return;
    }

    let animationFrameId = 0;
    let lastBaseSceneVersion = -1;
    let lastBaseCameraX = Number.NaN;
    let lastBasePixelsPerSecond = Number.NaN;
    let lastOverlaySceneVersion = -1;
    let lastOverlayCameraX = Number.NaN;
    let lastOverlayPixelsPerSecond = Number.NaN;
    let lastOverlayTransformCameraX = Number.NaN;
    let lastOverlayTransformScaleX = Number.NaN;
    let lastOverlayPlayheadSeconds = Number.NaN;
    let lastOverlayPulseFrame = -1;

    const render = () => {
      const snapshot = snapshotRef.current;
      if (!isRenderableCanvasSize(snapshot.width) || !isRenderableCanvasSize(snapshot.height)) {
        animationFrameId = window.requestAnimationFrame(render);
        return;
      }

      const cameraX = cameraXRef.current;
      const livePixelsPerSecond = livePixelsPerSecondRef.current;

      try {
        if (
          lastBaseSceneVersion !== sceneVersionRef.current ||
          lastBaseCameraX !== cameraX ||
          lastBasePixelsPerSecond !== livePixelsPerSecond
        ) {
          const baseContext = setupCanvas(baseCanvas, snapshot.width, snapshot.height);
          if (baseContext) {
            baseContext.clearRect(0, 0, snapshot.width, snapshot.height);
            baseContext.fillStyle = "#2a2a2a";
            baseContext.fillRect(0, 0, snapshot.width, snapshot.height);
            for (const region of snapshot.regions) {
              drawRulerRegion(
                baseContext,
                region,
                snapshot.width,
                cameraX,
                livePixelsPerSecond,
                snapshot.selectedRegionId === region.id,
              );
            }
            drawGridLines(
              baseContext,
              snapshot.timelineGrid,
              snapshot.width,
              snapshot.height,
              cameraX,
              livePixelsPerSecond,
            );
          }

          lastBaseSceneVersion = sceneVersionRef.current;
          lastBaseCameraX = cameraX;
          lastBasePixelsPerSecond = livePixelsPerSecond;
        }

        if (overlayContentRef.current) {
          const overlayScaleX =
            snapshot.pixelsPerSecond > 0 ? livePixelsPerSecond / snapshot.pixelsPerSecond : 1;

          if (
            lastOverlayTransformCameraX !== cameraX ||
            lastOverlayTransformScaleX !== overlayScaleX
          ) {
            overlayContentRef.current.style.left = `${-cameraX}px`;
            overlayContentRef.current.style.transform = `scaleX(${overlayScaleX})`;
            overlayContentRef.current.style.transformOrigin = "0 0";
            overlayContentRef.current.style.setProperty(
              "--lt-ruler-mark-scale-x",
              `${overlayScaleX !== 0 ? 1 / overlayScaleX : 1}`,
            );
            lastOverlayTransformCameraX = cameraX;
            lastOverlayTransformScaleX = overlayScaleX;
          }
        }

        const overlayContext = setupCanvas(overlayCanvas, snapshot.width, snapshot.height);
        if (overlayContext) {
          const playheadSeconds =
            snapshot.playheadDragRef.current?.currentSeconds ?? playheadSecondsRef.current;
          const pulseFrame = snapshot.pendingMarkerJump ? Math.floor(performance.now() / 32) : 0;
          const currentMarkerId = snapshot.markers
            .filter((marker) => playheadSeconds >= marker.startSeconds)
            .at(-1)?.id ?? null;
          const shouldRedrawOverlay =
            lastOverlaySceneVersion !== sceneVersionRef.current ||
            lastOverlayCameraX !== cameraX ||
            lastOverlayPixelsPerSecond !== livePixelsPerSecond ||
            lastOverlayPlayheadSeconds !== playheadSeconds ||
            lastOverlayPulseFrame !== pulseFrame;

          if (shouldRedrawOverlay) {
            overlayContext.clearRect(0, 0, snapshot.width, snapshot.height);

            if (snapshot.pendingMarkerJump) {
              drawPendingExecutionLine(
                overlayContext,
                snapshot.width,
                snapshot.height,
                cameraX,
                livePixelsPerSecond,
                snapshot.pendingMarkerJump.executeAtSeconds,
              );
            }

            const pulseAlpha = 0.72 + Math.sin(performance.now() / 160) * 0.18;

            for (const marker of snapshot.markers) {
              drawRulerMarker(
                overlayContext,
                marker,
                snapshot.width,
                snapshot.height,
                cameraX,
                livePixelsPerSecond,
                {
                  isSelected: snapshot.selectedMarkerId === marker.id,
                  isArmed: snapshot.pendingMarkerJump?.targetMarkerId === marker.id,
                  isCurrent: currentMarkerId === marker.id,
                  pulseAlpha,
                },
              );
            }

            lastOverlaySceneVersion = sceneVersionRef.current;
            lastOverlayCameraX = cameraX;
            lastOverlayPixelsPerSecond = livePixelsPerSecond;
            lastOverlayPlayheadSeconds = playheadSeconds;
            lastOverlayPulseFrame = pulseFrame;
          }
        }
      } catch (error) {
        console.error("TimelineRulerCanvas render failed", error);
      }

      animationFrameId = window.requestAnimationFrame(render);
    };

    animationFrameId = window.requestAnimationFrame(render);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [cameraXRef, livePixelsPerSecondRef, playheadSecondsRef]);

  return (
    <div
      className="lt-ruler-canvas-layer"
      style={{
        width: isRenderableCanvasSize(width) ? width : 1,
        height: isRenderableCanvasSize(height) ? height : 1,
      }}
    >
      <canvas className="lt-ruler-canvas" ref={baseCanvasRef} aria-hidden="true" />
      <canvas className="lt-ruler-canvas-overlay" ref={overlayCanvasRef} aria-hidden="true" />
      <div className="lt-ruler-overlay">
        <div
          ref={overlayContentRef}
          style={{
            position: "absolute",
            inset: 0,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export function TimelineTrackCanvas({
  width,
  height,
  trackHeight,
  song,
  visibleTracks,
  clipsByTrack,
  waveformCache,
  cameraXRef,
  pixelsPerSecond,
  livePixelsPerSecondRef,
  scrollViewportRef,
  timelineGrid,
  selectedClipId,
  clipPreviewSecondsRef,
}: TrackCanvasProps) {
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const snapshotRef = useRef<TrackSceneSnapshot>({
    width,
    height,
    trackHeight,
    song,
    visibleTracks,
    clipsByTrack,
    waveformCache,
    pixelsPerSecond,
    timelineGrid,
    selectedClipId,
    clipPreviewSecondsRef,
  });
  const sceneVersionRef = useRef(0);
  const trackStructureSignature = useMemo(
    () => buildTrackStructureSignature(song, visibleTracks),
    [song.tracks, visibleTracks],
  );
  const clipSceneSignature = useMemo(() => buildClipSceneSignature(clipsByTrack), [clipsByTrack]);
  const waveformCacheSignature = useMemo(
    () => buildWaveformCacheSignature(waveformCache),
    [waveformCache],
  );

  snapshotRef.current = {
    width,
    height,
    trackHeight,
    song,
    visibleTracks,
    clipsByTrack,
    waveformCache,
    pixelsPerSecond,
    timelineGrid,
    selectedClipId,
    clipPreviewSecondsRef,
  };

  useEffect(() => {
    sceneVersionRef.current += 1;
  }, [
    clipSceneSignature,
    height,
    pixelsPerSecond,
    selectedClipId,
    trackStructureSignature,
    timelineGrid,
    trackHeight,
    waveformCacheSignature,
    width,
  ]);

  useEffect(() => {
    const baseCanvas = baseCanvasRef.current;
    if (!baseCanvas) {
      return;
    }

    let animationFrameId = 0;
    let lastBaseSceneVersion = -1;
    let lastBaseCameraX = Number.NaN;
    let lastBasePixelsPerSecond = Number.NaN;
    let lastViewportScrollTop = Number.NaN;
    let lastViewportHeight = Number.NaN;
    let lastPreviewClipState = clipPreviewSecondsRef.current;

    const render = () => {
      const snapshot = snapshotRef.current;
      const cameraX = cameraXRef.current;
      const livePixelsPerSecond = livePixelsPerSecondRef.current;
      const scrollViewport = scrollViewportRef.current;
      const viewportScrollTop = scrollViewport?.scrollTop ?? 0;
      const viewportHeight = scrollViewport?.clientHeight ?? snapshot.height;

      if (
        lastBaseSceneVersion !== sceneVersionRef.current ||
        lastBaseCameraX !== cameraX ||
        lastBasePixelsPerSecond !== livePixelsPerSecond ||
        lastViewportScrollTop !== viewportScrollTop ||
        lastViewportHeight !== viewportHeight ||
        lastPreviewClipState !== snapshot.clipPreviewSecondsRef.current
      ) {
        const baseContext = setupCanvas(baseCanvas, snapshot.width, snapshot.height);
        if (baseContext) {
          drawTrackScene(
            baseContext,
            snapshot,
            cameraX,
            livePixelsPerSecond,
            viewportScrollTop,
            viewportHeight,
          );
        }

        lastBaseSceneVersion = sceneVersionRef.current;
        lastBaseCameraX = cameraX;
        lastBasePixelsPerSecond = livePixelsPerSecond;
        lastViewportScrollTop = viewportScrollTop;
        lastViewportHeight = viewportHeight;
        lastPreviewClipState = snapshot.clipPreviewSecondsRef.current;
      }

      animationFrameId = window.requestAnimationFrame(render);
    };

    animationFrameId = window.requestAnimationFrame(render);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [cameraXRef, livePixelsPerSecondRef]);

  return (
    <div className="lt-track-canvas-layer" style={{ width, height }}>
      <canvas className="lt-track-canvas" ref={baseCanvasRef} aria-hidden="true" />
    </div>
  );
}
