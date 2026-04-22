import { useEffect, useLayoutEffect, useRef, type MutableRefObject, type ReactNode } from "react";

import type {
  ClipSummary,
  SongView,
  TrackSummary,
  WaveformSummaryDto,
} from "./desktopApi";
import type { TimelineGrid } from "./timelineMath";
import { clamp, secondsToScreenX } from "./timelineMath";

type TimeSelection = {
  startSeconds: number;
  endSeconds: number;
} | null;

type RulerCanvasProps = {
  width: number;
  height: number;
  cameraX: number;
  pixelsPerSecond: number;
  timelineGrid: TimelineGrid;
  selection: TimeSelection;
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
  cameraX: number;
  pixelsPerSecond: number;
  timelineGrid: TimelineGrid;
  selectedClipId: string | null;
  previewClipSeconds: Record<string, number>;
  playheadSecondsRef: MutableRefObject<number>;
  previewPlayheadSeconds: number | null;
  playheadColor: string;
};

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

function drawWaveform(
  context: CanvasRenderingContext2D,
  clip: ClipSummary,
  waveform: WaveformSummaryDto | undefined,
  left: number,
  width: number,
  top: number,
  height: number,
  visibleStartRatio = 0,
  visibleEndRatio = 1,
) {
  const { min, max } = cropWaveform(clip, waveform, visibleStartRatio, visibleEndRatio);
  if (!max.length || !min.length || width < 4) {
    return;
  }

  context.save();
  context.beginPath();
  context.rect(left, top, width, height);
  context.clip();

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
  context.restore();
}

export function TimelineRulerCanvas({
  width,
  height,
  cameraX,
  pixelsPerSecond,
  timelineGrid,
  selection,
  playheadSecondsRef,
  previewPlayheadSeconds,
  playheadColor,
  children,
}: RulerCanvasProps) {
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useLayoutEffect(() => {
    const canvas = baseCanvasRef.current;
    if (!canvas) {
      return;
    }

    const context = setupCanvas(canvas, width, height);
    if (!context) {
      return;
    }

    context.clearRect(0, 0, width, height);
    context.fillStyle = "#2a2a2a";
    context.fillRect(0, 0, width, height);
    drawGridLines(context, timelineGrid, width, height, cameraX, pixelsPerSecond);
  }, [cameraX, height, pixelsPerSecond, timelineGrid, width]);

  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) {
      return;
    }

    let animationFrameId = 0;

    const render = () => {
      const context = setupCanvas(canvas, width, height);
      if (!context) {
        return;
      }

      context.clearRect(0, 0, width, height);

      if (selection) {
        const left = secondsToScreenX(selection.startSeconds, cameraX, pixelsPerSecond);
        const selectionWidth =
          (selection.endSeconds - selection.startSeconds) * pixelsPerSecond;
        context.fillStyle = "rgba(87, 241, 219, 0.12)";
        context.fillRect(left, 0, selectionWidth, height);
      }

      drawPlayhead(
        context,
        width,
        height,
        cameraX,
        pixelsPerSecond,
        previewPlayheadSeconds ?? playheadSecondsRef.current,
        playheadColor,
        true,
      );

      if (previewPlayheadSeconds === null) {
        animationFrameId = window.requestAnimationFrame(render);
      }
    };

    render();

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [
    cameraX,
    height,
    pixelsPerSecond,
    playheadColor,
    playheadSecondsRef,
    previewPlayheadSeconds,
    selection,
    width,
  ]);

  return (
    <>
      <canvas className="lt-ruler-canvas" ref={baseCanvasRef} aria-hidden="true" />
      <canvas className="lt-ruler-canvas-overlay" ref={overlayCanvasRef} aria-hidden="true" />
      <div className="lt-ruler-overlay">{children}</div>
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
  cameraX,
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

  useLayoutEffect(() => {
    const canvas = baseCanvasRef.current;
    if (!canvas) {
      return;
    }

    const context = setupCanvas(canvas, width, height);
    if (!context) {
      return;
    }

    context.clearRect(0, 0, width, height);
    context.fillStyle = "#0e0e0e";
    context.fillRect(0, 0, width, height);

    context.strokeStyle = "rgba(229, 226, 225, 0.05)";
    context.lineWidth = 1;
    for (let index = 0; index <= visibleTracks.length; index += 1) {
      const y = Math.round(index * trackHeight) + 0.5;
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }

    drawGridLines(context, timelineGrid, width, height, cameraX, pixelsPerSecond);

    visibleTracks.forEach((track, trackIndex) => {
      const trackTop = trackIndex * trackHeight;
      const childCount = song.tracks.filter((candidate) => candidate.parentTrackId === track.id).length;

      if (track.kind === "folder") {
        context.fillStyle = "rgba(32, 31, 31, 0.78)";
        context.fillRect(8, trackTop + 8, Math.max(0, width - 16), trackHeight - 16);
        context.fillStyle = "#bacac5";
        context.font = '600 10px "Space Grotesk", sans-serif';
        context.textBaseline = "middle";
        context.fillText(
          childCount ? `${childCount} tracks dentro del folder` : "Folder track",
          20,
          trackTop + trackHeight / 2,
        );
        return;
      }

      const trackClips = clipsByTrack[track.id] ?? [];
      for (const clip of trackClips) {
        const previewStartSeconds = previewClipSeconds[clip.id] ?? clip.timelineStartSeconds;
        const { left, width: clipWidth } = clipScreenBounds(
          clip,
          previewStartSeconds,
          cameraX,
          pixelsPerSecond,
        );
        const right = left + clipWidth;

        if (right < 0 || left > width || clipWidth <= 1) {
          continue;
        }

        const clippedLeft = clamp(left, 0, width);
        const clippedRight = clamp(right, 0, width);
        const visibleWidth = Math.max(2, clippedRight - clippedLeft);
        const visibleStartRatio = clipWidth > 0 ? clamp((clippedLeft - left) / clipWidth, 0, 1) : 0;
        const visibleEndRatio = clipWidth > 0 ? clamp((clippedRight - left) / clipWidth, 0, 1) : 1;
        const clipTop = trackTop + 8;
        const clipHeight = trackHeight - 18;

        context.fillStyle = "rgba(210, 212, 209, 0.92)";
        context.strokeStyle =
          selectedClipId === clip.id ? "rgba(87, 241, 219, 0.9)" : "rgba(12, 12, 12, 0.28)";
        context.lineWidth = selectedClipId === clip.id ? 1.5 : 1;
        context.beginPath();
        context.roundRect(clippedLeft, clipTop, visibleWidth, clipHeight, 2);
        context.fill();
        context.stroke();

        drawWaveform(
          context,
          clip,
          waveformCache[clip.waveformKey],
          clippedLeft,
          visibleWidth,
          clipTop,
          clipHeight,
          visibleStartRatio,
          visibleEndRatio,
        );

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
  }, [
    cameraX,
    clipsByTrack,
    height,
    pixelsPerSecond,
    previewClipSeconds,
    selectedClipId,
    song.tracks,
    timelineGrid,
    trackHeight,
    visibleTracks,
    waveformCache,
    width,
  ]);

  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) {
      return;
    }

    let animationFrameId = 0;

    const render = () => {
      const context = setupCanvas(canvas, width, height);
      if (!context) {
        return;
      }

      drawPlayhead(
        context,
        width,
        height,
        cameraX,
        pixelsPerSecond,
        previewPlayheadSeconds ?? playheadSecondsRef.current,
        playheadColor,
        false,
      );

      if (previewPlayheadSeconds === null) {
        animationFrameId = window.requestAnimationFrame(render);
      }
    };

    render();

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [
    cameraX,
    height,
    pixelsPerSecond,
    playheadColor,
    playheadSecondsRef,
    previewPlayheadSeconds,
    width,
  ]);

  return (
    <div className="lt-track-canvas-layer" style={{ width, height }}>
      <canvas className="lt-track-canvas" ref={baseCanvasRef} aria-hidden="true" />
      <canvas className="lt-track-canvas-overlay" ref={overlayCanvasRef} aria-hidden="true" />
    </div>
  );
}
