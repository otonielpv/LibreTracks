import type { MutableRefObject } from "react";

import type { ClipSummary, SongView, TrackSummary, WaveformSummaryDto } from "../desktopApi";
import type { TimelineGrid } from "../timelineMath";

export type TrackSceneSnapshot = {
  width: number;
  height: number;
  trackHeight: number;
  song: SongView;
  visibleTracks: TrackSummary[];
  clipsByTrack: Record<string, ClipSummary[]>;
  waveformCache: Record<string, WaveformSummaryDto>;
  pixelsPerSecond: number;
  zoomLevel: number;
  timelineGrid: TimelineGrid;
  selectedClipId: string | null;
  clipPreviewSecondsRef: MutableRefObject<Record<string, number>>;
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
      this.dirtyTracks = true;
      this.dirtyForeground = true;
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
      const viewportChanged =
        viewport.scrollTop !== this.lastViewportScrollTop || viewport.height !== this.lastViewportHeight;

      if (viewportChanged || previewClipState !== this.lastPreviewClipState) {
        this.dirtyTracks = true;
        this.lastViewportScrollTop = viewport.scrollTop;
        this.lastViewportHeight = viewport.height;
        this.lastPreviewClipState = previewClipState;
      }

      if (isRenderableCanvasSize(snapshot.width) && isRenderableCanvasSize(snapshot.height)) {
        if (this.dirtyBackground) {
          this.renderLayer(
            this.backgroundCanvas,
            this.backgroundContext,
            snapshot,
            this.options.renderBackground,
            viewport,
          );
          this.dirtyBackground = false;
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
      }
    }

    this.animationFrameId = window.requestAnimationFrame(this.render);
  };
}