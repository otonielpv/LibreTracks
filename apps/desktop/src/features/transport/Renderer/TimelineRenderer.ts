import type { MutableRefObject } from "react";

import type { SongView, WaveformSummaryDto } from "../desktopApi";
import type { TimelineClipSummary, TimelineTrackSummary } from "../library/pendingAudioImports";
import { recordCanvasRender } from "../perf/perfMetrics";
import type { TimelineGrid } from "../timeline/timelineMath";

export type TrackSceneSnapshot = {
  width: number;
  height: number;
  trackHeight: number;
  song: SongView;
  visibleTracks: TimelineTrackSummary[];
  clipsByTrack: Record<string, TimelineClipSummary[]>;
  waveformCache: Record<string, WaveformSummaryDto>;
  pixelsPerSecond: number;
  zoomLevel: number;
  timelineGrid: TimelineGrid;
  selectedClipId: string | null;
  selectedClipIds: string[];
  clipPreviewSecondsRef: MutableRefObject<Record<string, number>>;
  /**
   * Per-clip destination track override during a vertical clip drag. When a
   * clip id maps to a track id here, it is painted on that lane instead of its
   * own bucket, giving a live "moving to another track" preview without a React
   * re-render.
   */
  clipPreviewTrackIdRef: MutableRefObject<Record<string, string>>;
  cameraX: number;
};

export type TimelineViewportMetrics = {
  scrollTop: number;
  height: number;
};

type TimelineRendererOptions = {
  getViewportMetrics?: () => TimelineViewportMetrics;
  renderBackground?: (
    context: CanvasRenderingContext2D,
    snapshot: TrackSceneSnapshot,
    viewport: TimelineViewportMetrics,
  ) => void;
  renderTracks: (
    context: CanvasRenderingContext2D,
    snapshot: TrackSceneSnapshot,
    viewport: TimelineViewportMetrics,
  ) => void;
  renderForeground?: (
    context: CanvasRenderingContext2D,
    snapshot: TrackSceneSnapshot,
    viewport: TimelineViewportMetrics,
  ) => void;
};

function isRenderableCanvasSize(value: number) {
  return Number.isFinite(value) && value > 0;
}

function prepareCanvas(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  if (typeof globalThis === "object" && "__vitest_worker__" in globalThis) {
    return false;
  }

  if (
    typeof navigator !== "undefined" &&
    typeof navigator.userAgent === "string" &&
    navigator.userAgent.toLowerCase().includes("jsdom")
  ) {
    return false;
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
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return true;
}

export class TimelineRenderer {
  private snapshot: TrackSceneSnapshot | null = null;

  private animationFrameId = 0;

  private disposed = false;

  private dirtyBackground = true;

  private dirtyTracks = true;

  private dirtyForeground = true;

  private lastViewportScrollTop = Number.NaN;

  private lastViewportHeight = Number.NaN;

  private lastPreviewClipState: Record<string, number> | null = null;
  private lastPreviewTrackState: Record<string, string> | null = null;

  // The background layer (which carries the vertical grid) is drawn at an
  // integer cameraX and nudged by the sub-pixel remainder via a compositor
  // transform — same crisp-AND-smooth trick as the ruler canvases. These track
  // when a redraw vs a cheap transform-only update is needed.
  private lastBackgroundRoundedCameraX = Number.NaN;
  private lastBackgroundSubpixelOffsetX = Number.NaN;

  constructor(
    private readonly backgroundCanvas: HTMLCanvasElement,
    private readonly backgroundContext: CanvasRenderingContext2D,
    private readonly tracksCanvas: HTMLCanvasElement,
    private readonly tracksContext: CanvasRenderingContext2D,
    private readonly foregroundCanvas: HTMLCanvasElement,
    private readonly foregroundContext: CanvasRenderingContext2D,
    private readonly options: TimelineRendererOptions,
  ) {
    this.animationFrameId = window.requestAnimationFrame(this.render);
  }

  updateState(nextSnapshot: TrackSceneSnapshot) {
    const previousSnapshot = this.snapshot;
    const cameraChanged = !previousSnapshot || previousSnapshot.cameraX !== nextSnapshot.cameraX;
    const zoomChanged = !previousSnapshot || previousSnapshot.zoomLevel !== nextSnapshot.zoomLevel;
    const sizeChanged =
      !previousSnapshot ||
      previousSnapshot.width !== nextSnapshot.width ||
      previousSnapshot.height !== nextSnapshot.height;
    const sceneChanged =
      !previousSnapshot ||
      previousSnapshot.song !== nextSnapshot.song ||
      previousSnapshot.visibleTracks !== nextSnapshot.visibleTracks ||
      previousSnapshot.clipsByTrack !== nextSnapshot.clipsByTrack ||
      previousSnapshot.waveformCache !== nextSnapshot.waveformCache ||
      previousSnapshot.trackHeight !== nextSnapshot.trackHeight ||
      previousSnapshot.timelineGrid !== nextSnapshot.timelineGrid ||
      previousSnapshot.selectedClipId !== nextSnapshot.selectedClipId ||
      previousSnapshot.selectedClipIds.join("|") !== nextSnapshot.selectedClipIds.join("|") ||
      previousSnapshot.pixelsPerSecond !== nextSnapshot.pixelsPerSecond;

    this.snapshot = nextSnapshot;

    if (zoomChanged || sizeChanged) {
      this.markAllDirty();
      return;
    }

    if (sceneChanged) {
      this.markAllDirty();
    }

    if (cameraChanged) {
      // Tracks/foreground redraw on any fractional camera move (their content —
      // clips, waveforms — resamples cleanly). The background grid instead only
      // needs a redraw when the INTEGER camera changes; between those, the
      // per-frame sub-pixel transform in render() carries its motion, keeping
      // the 1px grid lines crisp instead of stepping.
      this.dirtyTracks = true;
      this.dirtyForeground = true;
      if (
        Math.round(nextSnapshot.cameraX) !== this.lastBackgroundRoundedCameraX
      ) {
        this.dirtyBackground = true;
      }
    }
  }

  destroy() {
    this.disposed = true;
    window.cancelAnimationFrame(this.animationFrameId);
  }

  private markAllDirty() {
    this.dirtyBackground = true;
    this.dirtyTracks = true;
    this.dirtyForeground = true;
  }

  private getViewportMetrics(snapshot: TrackSceneSnapshot): TimelineViewportMetrics {
    return (
      this.options.getViewportMetrics?.() ?? {
        scrollTop: 0,
        height: snapshot.height,
      }
    );
  }

  private renderLayer(
    canvas: HTMLCanvasElement,
    context: CanvasRenderingContext2D,
    snapshot: TrackSceneSnapshot,
    render:
      | ((
          context: CanvasRenderingContext2D,
          snapshot: TrackSceneSnapshot,
          viewport: TimelineViewportMetrics,
        ) => void)
      | undefined,
    viewport: TimelineViewportMetrics,
  ) {
    if (!prepareCanvas(canvas, context, snapshot.width, snapshot.height)) {
      return;
    }

    context.clearRect(0, 0, snapshot.width, snapshot.height);
    render?.(context, snapshot, viewport);
  }

  private render = () => {
    if (this.disposed) {
      return;
    }

    const snapshot = this.snapshot;
    if (snapshot) {
      const viewport = this.getViewportMetrics(snapshot);
      const previewClipState = snapshot.clipPreviewSecondsRef.current;
      const previewTrackState = snapshot.clipPreviewTrackIdRef.current;
      const viewportChanged =
        viewport.scrollTop !== this.lastViewportScrollTop || viewport.height !== this.lastViewportHeight;

      if (
        viewportChanged ||
        previewClipState !== this.lastPreviewClipState ||
        previewTrackState !== this.lastPreviewTrackState
      ) {
        this.dirtyTracks = true;
        this.lastViewportScrollTop = viewport.scrollTop;
        this.lastViewportHeight = viewport.height;
        this.lastPreviewClipState = previewClipState;
        this.lastPreviewTrackState = previewTrackState;
      }

      if (isRenderableCanvasSize(snapshot.width) && isRenderableCanvasSize(snapshot.height)) {
        // Measure only frames where we actually paint at least one layer,
        // so we don't dilute the metric with cheap "all clean" rAF ticks.
        const willPaint =
          this.dirtyBackground || this.dirtyTracks || this.dirtyForeground;
        const paintStartedAt = willPaint ? performance.now() : 0;

        const roundedCameraX = Math.round(snapshot.cameraX);
        const backgroundSubpixelOffsetX = snapshot.cameraX - roundedCameraX;

        if (this.dirtyBackground) {
          // Draw the grid at the integer camera so 1px lines land on whole
          // pixels (crisp, no shimmer).
          this.renderLayer(
            this.backgroundCanvas,
            this.backgroundContext,
            { ...snapshot, cameraX: roundedCameraX },
            this.options.renderBackground,
            viewport,
          );
          this.dirtyBackground = false;
          this.lastBackgroundRoundedCameraX = roundedCameraX;
        }

        // Every frame: nudge the whole background canvas by the sub-pixel
        // remainder via a GPU-composited transform, so the crisp grid slides
        // smoothly with the fractional camera instead of stepping a pixel at a
        // time. Cheap — only touches style when the offset actually changes.
        if (this.lastBackgroundSubpixelOffsetX !== backgroundSubpixelOffsetX) {
          this.backgroundCanvas.style.transform = `translateX(${-backgroundSubpixelOffsetX}px)`;
          this.lastBackgroundSubpixelOffsetX = backgroundSubpixelOffsetX;
        }

        if (this.dirtyTracks) {
          this.renderLayer(
            this.tracksCanvas,
            this.tracksContext,
            snapshot,
            this.options.renderTracks,
            viewport,
          );
          this.dirtyTracks = false;
        }

        if (this.dirtyForeground) {
          this.renderLayer(
            this.foregroundCanvas,
            this.foregroundContext,
            snapshot,
            this.options.renderForeground,
            viewport,
          );
          this.dirtyForeground = false;
        }

        if (willPaint) {
          recordCanvasRender(performance.now() - paintStartedAt);
        }
      }
    }

    this.animationFrameId = window.requestAnimationFrame(this.render);
  };
}
