import { useEffect, useRef, type MutableRefObject, type ReactNode } from "react";

import type {
  ClipSummary,
  PendingJumpSummary,
  SectionMarkerSummary,
  SongView,
  TrackSummary,
  WaveformSummaryDto,
} from "./desktopApi";
import type { TimelineGrid } from "./timelineMath";
import { clamp, secondsToScreenX } from "./timelineMath";

type RulerCanvasProps = {
  width: number;
  height: number;
  cameraXRef: MutableRefObject<number>;
  pixelsPerSecond: number;
  timelineGrid: TimelineGrid;
  markers: SectionMarkerSummary[];
  selectedMarkerId: string | null;
  pendingMarkerJump: PendingJumpSummary | null;
  playheadSecondsRef: MutableRefObject<number>;
  previewPlayheadSeconds: number | null;
  playheadColor: string;
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
  timelineGrid: TimelineGrid;
  selectedClipId: string | null;
  previewClipSeconds: Record<string, number>;
  playheadSecondsRef: MutableRefObject<number>;
  previewPlayheadSeconds: number | null;
  playheadColor: string;
};

type TrackSceneSnapshot = Omit<TrackCanvasProps, "cameraXRef">;

type WaveformBitmap = HTMLCanvasElement;

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
  if (grid.showBeatGridLines) {
    context.strokeStyle = "rgba(186, 202, 197, 0.14)";
    context.lineWidth = 1;
    context.beginPath();
    for (const mark of grid.beats) {
      const x = Math.round(secondsToScreenX(mark, cameraX, pixelsPerSecond)) + 0.5;
      if (x < 0 || x > width) {
        continue;
      }
      context.moveTo(x, 0);
      context.lineTo(x, height);
    }
    context.stroke();
  }

  context.strokeStyle = "rgba(186, 202, 197, 0.32)";
  context.lineWidth = 1;
  context.beginPath();
  for (const mark of grid.bars) {
    const x = Math.round(secondsToScreenX(mark, cameraX, pixelsPerSecond)) + 0.5;
    if (x < 0 || x > width) {
      continue;
    }
    context.moveTo(x, 0);
    context.lineTo(x, height);
  }
  context.stroke();
}

function drawPlayhead(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  cameraX: number,
  pixelsPerSecond: number,
  playheadSeconds: number,
  color: string,
  includeHandle: boolean,
) {
  const x = secondsToScreenX(playheadSeconds, cameraX, pixelsPerSecond);
  context.clearRect(0, 0, width, height);

  if (x < -12 || x > width + 12) {
    return;
  }

  const snappedX = Math.round(x) + 0.5;

  context.strokeStyle = color;
  context.lineWidth = 1;
  context.shadowColor = color;
  context.shadowBlur = 8;
  context.beginPath();
  context.moveTo(snappedX, 0);
  context.lineTo(snappedX, height);
  context.stroke();
  context.shadowBlur = 0;

  if (!includeHandle) {
    return;
  }

  context.fillStyle = color;
  context.beginPath();
  context.moveTo(snappedX - 5, 0);
  context.lineTo(snappedX + 5, 0);
  context.lineTo(snappedX, 7);
  context.closePath();
  context.fill();
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

function cropWaveform(
  clip: ClipSummary,
  waveform: WaveformSummaryDto | undefined,
  visibleStartRatio = 0,
  visibleEndRatio = 1,
) {
  const maxPeaks = waveform?.maxPeaks ?? [];
  const minPeaks = waveform?.minPeaks?.length ? waveform.minPeaks : maxPeaks.map((peak) => -peak);
  if (!maxPeaks.length || clip.sourceDurationSeconds <= 0) {
    return {
      min: [] as number[],
      max: [] as number[],
    };
  }

  const clipStartRatio = clamp(clip.sourceStartSeconds / clip.sourceDurationSeconds, 0, 1);
  const clipSpanRatio = clamp(clip.durationSeconds / clip.sourceDurationSeconds, 0, 1);
  const startRatio = clamp(clipStartRatio + clipSpanRatio * visibleStartRatio, 0, 1);
  const endRatio = clamp(clipStartRatio + clipSpanRatio * visibleEndRatio, 0, 1);
  const startIndex = Math.floor(startRatio * maxPeaks.length);
  const endIndex = Math.max(startIndex + 1, Math.ceil(endRatio * maxPeaks.length));

  return {
    min: minPeaks.slice(startIndex, endIndex),
    max: maxPeaks.slice(startIndex, endIndex),
  };
}

function drawWaveformShape(
  context: CanvasRenderingContext2D,
  clip: ClipSummary,
  waveform: WaveformSummaryDto | undefined,
  left: number,
  width: number,
  top: number,
  height: number,
) {
  const { min, max } = cropWaveform(clip, waveform, 0, 1);
  if (!max.length || !min.length || width < 2 || height < 2) {
    return;
  }

  context.fillStyle = "rgba(20, 20, 20, 0.72)";
  context.beginPath();

  for (let index = 0; index < max.length; index += 1) {
    const x = left + (index / Math.max(1, max.length - 1)) * width;
    const y = top + height * 0.5 - clamp(max[index], -1, 1) * height * 0.42;
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }

  for (let index = min.length - 1; index >= 0; index -= 1) {
    const x = left + (index / Math.max(1, min.length - 1)) * width;
    const y = top + height * 0.5 - clamp(min[index], -1, 1) * height * 0.42;
    context.lineTo(x, y);
  }

  context.closePath();
  context.fill();
}

function createWaveformBitmap(width: number, height: number) {
  if (typeof document === "undefined") {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function getWaveformBitmapKey(
  clip: ClipSummary,
  waveform: WaveformSummaryDto | undefined,
  pixelsPerSecond: number,
  clipHeight: number,
) {
  return [
    clip.id,
    clip.waveformKey,
    waveform?.version ?? "missing",
    clip.timelineStartSeconds.toFixed(4),
    clip.durationSeconds.toFixed(4),
    clip.sourceStartSeconds.toFixed(4),
    clip.sourceDurationSeconds.toFixed(4),
    pixelsPerSecond.toFixed(4),
    Math.round(clipHeight),
  ].join("|");
}

function getOrCreateWaveformBitmap(
  cache: Map<string, WaveformBitmap>,
  clip: ClipSummary,
  waveform: WaveformSummaryDto | undefined,
  pixelsPerSecond: number,
  clipHeight: number,
) {
  const cacheKey = getWaveformBitmapKey(clip, waveform, pixelsPerSecond, clipHeight);
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const clipWidth = Math.max(2, Math.round(clip.durationSeconds * pixelsPerSecond));
  const bitmapHeight = Math.max(2, Math.round(clipHeight));
  const bitmap = createWaveformBitmap(clipWidth, bitmapHeight);
  if (!bitmap) {
    return null;
  }

  const context = bitmap.getContext("2d");
  if (!context) {
    return null;
  }

  context.clearRect(0, 0, clipWidth, bitmapHeight);
  drawWaveformShape(context, clip, waveform, 0, clipWidth, 0, bitmapHeight);
  cache.set(cacheKey, bitmap);
  return bitmap;
}

function drawTrackScene(
  context: CanvasRenderingContext2D,
  snapshot: TrackSceneSnapshot,
  cameraX: number,
  waveformBitmapCache: Map<string, WaveformBitmap>,
) {
  context.clearRect(0, 0, snapshot.width, snapshot.height);
  context.fillStyle = "#0e0e0e";
  context.fillRect(0, 0, snapshot.width, snapshot.height);

  context.strokeStyle = "rgba(229, 226, 225, 0.05)";
  context.lineWidth = 1;
  for (let index = 0; index <= snapshot.visibleTracks.length; index += 1) {
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
    snapshot.pixelsPerSecond,
  );

  snapshot.visibleTracks.forEach((track, trackIndex) => {
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
      return;
    }

    const trackClips = snapshot.clipsByTrack[track.id] ?? [];
    for (const clip of trackClips) {
      const previewStartSeconds = snapshot.previewClipSeconds[clip.id] ?? clip.timelineStartSeconds;
      const { left, width: clipWidth } = clipScreenBounds(
        clip,
        previewStartSeconds,
        cameraX,
        snapshot.pixelsPerSecond,
      );
      const right = left + clipWidth;

      if (right < 0 || left > snapshot.width || clipWidth <= 1) {
        continue;
      }

      const clippedLeft = clamp(left, 0, snapshot.width);
      const clippedRight = clamp(right, 0, snapshot.width);
      const visibleWidth = Math.max(2, clippedRight - clippedLeft);
      const clipTop = trackTop + 8;
      const clipHeight = snapshot.trackHeight - 18;

      context.fillStyle = "rgba(210, 212, 209, 0.92)";
      context.strokeStyle =
        snapshot.selectedClipId === clip.id ? "rgba(87, 241, 219, 0.9)" : "rgba(12, 12, 12, 0.28)";
      context.lineWidth = snapshot.selectedClipId === clip.id ? 1.5 : 1;
      context.beginPath();
      context.roundRect(clippedLeft, clipTop, visibleWidth, clipHeight, 2);
      context.fill();
      context.stroke();

      const waveformBitmap = getOrCreateWaveformBitmap(
        waveformBitmapCache,
        clip,
        snapshot.waveformCache[clip.waveformKey],
        snapshot.pixelsPerSecond,
        clipHeight,
      );

      if (waveformBitmap) {
        const sourceLeftRatio = clipWidth > 0 ? clamp((clippedLeft - left) / clipWidth, 0, 1) : 0;
        const sourceRightRatio = clipWidth > 0 ? clamp((clippedRight - left) / clipWidth, 0, 1) : 1;
        const sourceLeft = sourceLeftRatio * waveformBitmap.width;
        const sourceWidth = Math.max(1, (sourceRightRatio - sourceLeftRatio) * waveformBitmap.width);

        context.save();
        context.beginPath();
        context.roundRect(clippedLeft, clipTop, visibleWidth, clipHeight, 2);
        context.clip();
        context.drawImage(
          waveformBitmap,
          sourceLeft,
          0,
          sourceWidth,
          waveformBitmap.height,
          clippedLeft,
          clipTop,
          visibleWidth,
          clipHeight,
        );
        context.restore();
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
  });
}

export function TimelineRulerCanvas({
  width,
  height,
  cameraXRef,
  pixelsPerSecond,
  timelineGrid,
  markers,
  selectedMarkerId,
  pendingMarkerJump,
  playheadSecondsRef,
  previewPlayheadSeconds,
  playheadColor,
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
    markers,
    selectedMarkerId,
    pendingMarkerJump,
    previewPlayheadSeconds,
    playheadColor,
  });
  const sceneVersionRef = useRef(0);

  snapshotRef.current = {
    width,
    height,
    pixelsPerSecond,
    timelineGrid,
    markers,
    selectedMarkerId,
    pendingMarkerJump,
    previewPlayheadSeconds,
    playheadColor,
  };

  useEffect(() => {
    sceneVersionRef.current += 1;
  }, [
    height,
    markers,
    pendingMarkerJump,
    pixelsPerSecond,
    previewPlayheadSeconds,
    playheadColor,
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
    let lastOverlayTransformCameraX = Number.NaN;

    const render = () => {
      const snapshot = snapshotRef.current;
      const cameraX = cameraXRef.current;

      if (lastBaseSceneVersion !== sceneVersionRef.current || lastBaseCameraX !== cameraX) {
        const baseContext = setupCanvas(baseCanvas, snapshot.width, snapshot.height);
        if (baseContext) {
          baseContext.clearRect(0, 0, snapshot.width, snapshot.height);
          baseContext.fillStyle = "#2a2a2a";
          baseContext.fillRect(0, 0, snapshot.width, snapshot.height);
          drawGridLines(
            baseContext,
            snapshot.timelineGrid,
            snapshot.width,
            snapshot.height,
            cameraX,
            snapshot.pixelsPerSecond,
          );
        }

        lastBaseSceneVersion = sceneVersionRef.current;
        lastBaseCameraX = cameraX;
      }

      if (overlayContentRef.current && lastOverlayTransformCameraX !== cameraX) {
        overlayContentRef.current.style.transform = `translate3d(${-cameraX}px, 0, 0)`;
        lastOverlayTransformCameraX = cameraX;
      }

      const overlayContext = setupCanvas(overlayCanvas, snapshot.width, snapshot.height);
      if (overlayContext) {
        overlayContext.clearRect(0, 0, snapshot.width, snapshot.height);

        if (snapshot.pendingMarkerJump) {
          drawPendingExecutionLine(
            overlayContext,
            snapshot.width,
            snapshot.height,
            cameraX,
            snapshot.pixelsPerSecond,
            snapshot.pendingMarkerJump.executeAtSeconds,
          );
        }

        const pulseAlpha = 0.72 + Math.sin(performance.now() / 160) * 0.18;
        const currentMarkerId = snapshot.markers
          .filter((marker) => playheadSecondsRef.current >= marker.startSeconds)
          .at(-1)?.id ?? null;

        for (const marker of snapshot.markers) {
          drawRulerMarker(
            overlayContext,
            marker,
            snapshot.width,
            snapshot.height,
            cameraX,
            snapshot.pixelsPerSecond,
            {
              isSelected: snapshot.selectedMarkerId === marker.id,
              isArmed: snapshot.pendingMarkerJump?.targetMarkerId === marker.id,
              isCurrent: currentMarkerId === marker.id,
              pulseAlpha,
            },
          );
        }

      }

      animationFrameId = window.requestAnimationFrame(render);
    };

    animationFrameId = window.requestAnimationFrame(render);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [cameraXRef, playheadSecondsRef]);

  return (
    <>
      <canvas className="lt-ruler-canvas" ref={baseCanvasRef} aria-hidden="true" />
      <canvas className="lt-ruler-canvas-overlay" ref={overlayCanvasRef} aria-hidden="true" />
      <div className="lt-ruler-overlay" ref={overlayContentRef}>
        {children}
      </div>
    </>
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
  timelineGrid,
  selectedClipId,
  previewClipSeconds,
  playheadSecondsRef,
  previewPlayheadSeconds,
  playheadColor,
}: TrackCanvasProps) {
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const waveformBitmapCacheRef = useRef<Map<string, WaveformBitmap>>(new Map());
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
    previewClipSeconds,
    playheadSecondsRef,
    previewPlayheadSeconds,
    playheadColor,
  });
  const sceneVersionRef = useRef(0);

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
    previewClipSeconds,
    playheadSecondsRef,
    previewPlayheadSeconds,
    playheadColor,
  };

  useEffect(() => {
    sceneVersionRef.current += 1;
  }, [
    clipsByTrack,
    height,
    pixelsPerSecond,
    previewClipSeconds,
    selectedClipId,
    song,
    timelineGrid,
    trackHeight,
    visibleTracks,
    waveformCache,
    width,
  ]);

  useEffect(() => {
    waveformBitmapCacheRef.current.clear();
    sceneVersionRef.current += 1;
  }, [pixelsPerSecond, song.projectRevision, trackHeight]);

  useEffect(() => {
    const baseCanvas = baseCanvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    if (!baseCanvas || !overlayCanvas) {
      return;
    }

    let animationFrameId = 0;
    let lastBaseSceneVersion = -1;
    let lastBaseCameraX = Number.NaN;

    const render = () => {
      const snapshot = snapshotRef.current;
      const cameraX = cameraXRef.current;

      if (lastBaseSceneVersion !== sceneVersionRef.current || lastBaseCameraX !== cameraX) {
        const baseContext = setupCanvas(baseCanvas, snapshot.width, snapshot.height);
        if (baseContext) {
          drawTrackScene(baseContext, snapshot, cameraX, waveformBitmapCacheRef.current);
        }

        lastBaseSceneVersion = sceneVersionRef.current;
        lastBaseCameraX = cameraX;
      }

      const overlayContext = setupCanvas(overlayCanvas, snapshot.width, snapshot.height);
      if (overlayContext) {
        drawPlayhead(
          overlayContext,
          snapshot.width,
          snapshot.height,
          cameraX,
          snapshot.pixelsPerSecond,
          snapshot.previewPlayheadSeconds ?? playheadSecondsRef.current,
          snapshot.playheadColor,
          false,
        );
      }

      animationFrameId = window.requestAnimationFrame(render);
    };

    animationFrameId = window.requestAnimationFrame(render);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [cameraXRef, playheadSecondsRef]);

  return (
    <div className="lt-track-canvas-layer" style={{ width, height }}>
      <canvas className="lt-track-canvas" ref={baseCanvasRef} aria-hidden="true" />
      <canvas className="lt-track-canvas-overlay" ref={overlayCanvasRef} aria-hidden="true" />
    </div>
  );
}
