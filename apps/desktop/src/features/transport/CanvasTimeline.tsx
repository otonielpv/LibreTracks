import { useEffect, useMemo, useRef, type MutableRefObject, type ReactNode, type RefObject } from "react";

import type {
  ClipSummary,
  PendingJumpSummary,
  SectionMarkerSummary,
  SongRegionSummary,
  TempoMarkerSummary,
  SongView,
  TrackSummary,
  WaveformSummaryDto,
} from "./desktopApi";
import { InputManager } from "./Renderer/InputManager";
import {
  drawGridLines,
  drawRulerBackgroundLayer,
} from "./Renderer/drawBackground";
import { drawRulerForegroundLayer } from "./Renderer/drawForeground";
import {
  buildTrackStructureSignature,
  drawTrackCanvasBackground,
  drawTrackClipsLayer,
} from "./Renderer/drawTracks";
import {
  TimelineRenderer,
  type TimelineViewportMetrics,
  type TrackSceneSnapshot,
} from "./Renderer/TimelineRenderer";
import { BASE_PIXELS_PER_SECOND, type TimelineGrid } from "./timelineMath";
import { secondsToScreenX } from "./timelineMath";

type RulerCanvasProps = {
  width: number;
  height: number;
  trackHeight: number;
  cameraXRef: MutableRefObject<number>;
  pixelsPerSecond: number;
  livePixelsPerSecondRef: MutableRefObject<number>;
  timelineGrid: TimelineGrid;
  regions: SongRegionSummary[];
  markers: SectionMarkerSummary[];
  tempoMarkers: TempoMarkerSummary[];
  selectedRegionId: string | null;
  selectedMarkerId: string | null;
  pendingMarkerJump: PendingJumpSummary | null;
  playheadSecondsRef: MutableRefObject<number>;
  playheadDragRef: MutableRefObject<{ currentSeconds: number } | null>;
  interactionContainerRef: RefObject<HTMLDivElement | null>;
  canNativeZoom: boolean;
  onNativeCameraXPreview: (cameraX: number) => number;
  onNativeCameraXCommit: (cameraX: number) => void;
  onNativeZoomPreview: (nextZoomLevel: number, anchorViewportX: number) => {
    cameraX: number;
    zoomLevel: number;
  } | null;
  onNativeZoomCommit: (view: { cameraX: number; zoomLevel: number }) => void;
  onNativeTrackHeightChange: (trackHeight: number) => void;
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
  interactionContainerRef: RefObject<HTMLDivElement | null>;
  timelineGrid: TimelineGrid;
  selectedClipId: string | null;
  clipPreviewSecondsRef: MutableRefObject<Record<string, number>>;
  trackHeightForInput: number;
  canNativeZoom: boolean;
  onNativeCameraXPreview: (cameraX: number) => number;
  onNativeCameraXCommit: (cameraX: number) => void;
  onNativeZoomPreview: (nextZoomLevel: number, anchorViewportX: number) => {
    cameraX: number;
    zoomLevel: number;
  } | null;
  onNativeZoomCommit: (view: { cameraX: number; zoomLevel: number }) => void;
  onNativeTrackHeightChange: (trackHeight: number) => void;
};

function isRenderableCanvasSize(value: number) {
  return Number.isFinite(value) && value > 0;
}

function shouldSkipCanvas2D() {
  return (
    (typeof globalThis === "object" && "__vitest_worker__" in globalThis) ||
    (typeof navigator !== "undefined" &&
      typeof navigator.userAgent === "string" &&
      navigator.userAgent.toLowerCase().includes("jsdom"))
  );
}

function setupCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
  if (shouldSkipCanvas2D()) {
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

function safeGetCanvasContext(canvas: HTMLCanvasElement) {
  if (shouldSkipCanvas2D()) {
    return null;
  }

  try {
    return canvas.getContext("2d");
  } catch {
    return null;
  }
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


export function TimelineRulerCanvas({
  width,
  height,
  trackHeight,
  cameraXRef,
  pixelsPerSecond,
  livePixelsPerSecondRef,
  timelineGrid,
  regions,
  markers,
  tempoMarkers,
  selectedRegionId,
  selectedMarkerId,
  pendingMarkerJump,
  playheadSecondsRef,
  playheadDragRef,
  interactionContainerRef,
  canNativeZoom,
  onNativeCameraXPreview,
  onNativeCameraXCommit,
  onNativeZoomPreview,
  onNativeZoomCommit,
  onNativeTrackHeightChange,
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
    tempoMarkers,
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
    tempoMarkers,
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

  const tempoMarkersSignature = useMemo(
    () => tempoMarkers.map((m) => `${m.id}:${m.startSeconds}:${m.bpm}`).join("|"),
    [tempoMarkers],
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
    tempoMarkersSignature,
    pendingJumpSignature,
    pixelsPerSecond,
    selectedRegionId,
    selectedMarkerId,
    timelineGrid,
    width,
  ]);

  useEffect(() => {
    const container = interactionContainerRef.current;
    if (!container) {
      return;
    }

    const inputManager = new InputManager({
      container,
      getState: () => ({
        cameraX: cameraXRef.current,
        zoomLevel: livePixelsPerSecondRef.current / BASE_PIXELS_PER_SECOND,
        trackHeight,
        canZoom: canNativeZoom,
      }),
      dragThresholdPx: 6,
      panCommitDelayMs: 100,
      zoomCommitDelayMs: 100,
      zoomMultiplier: 1.2,
      trackHeightStep: 8,
      trackHeightMin: 68,
      trackHeightMax: 148,
      onPreviewCameraX: onNativeCameraXPreview,
      onCommitCameraX: onNativeCameraXCommit,
      onPreviewZoom: onNativeZoomPreview,
      onCommitZoom: onNativeZoomCommit,
      onTrackHeightChange: onNativeTrackHeightChange,
    });

    return () => {
      inputManager.destroy();
    };
  }, [
    canNativeZoom,
    cameraXRef,
    interactionContainerRef,
    livePixelsPerSecondRef,
    onNativeCameraXCommit,
    onNativeCameraXPreview,
    onNativeTrackHeightChange,
    onNativeZoomCommit,
    onNativeZoomPreview,
    trackHeight,
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
    let lastOverlayCurrentMarkerId: string | null = null;
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
            drawRulerBackgroundLayer(baseContext, {
              width: snapshot.width,
              height: snapshot.height,
              cameraX,
              pixelsPerSecond: livePixelsPerSecond,
              timelineGrid: snapshot.timelineGrid,
              regions: snapshot.regions,
              selectedRegionId: snapshot.selectedRegionId,
            });
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
            lastOverlayCurrentMarkerId !== currentMarkerId ||
            lastOverlayPulseFrame !== pulseFrame;

          if (shouldRedrawOverlay) {
            overlayContext.clearRect(0, 0, snapshot.width, snapshot.height);

            const pulseAlpha = 0.72 + Math.sin(performance.now() / 160) * 0.18;
            drawRulerForegroundLayer(overlayContext, {
              width: snapshot.width,
              height: snapshot.height,
              cameraX,
              pixelsPerSecond: livePixelsPerSecond,
              markers: snapshot.markers,
              tempoMarkers: snapshot.tempoMarkers,
              pendingMarkerJump: snapshot.pendingMarkerJump,
              selectedMarkerId: snapshot.selectedMarkerId,
              currentMarkerId,
              pulseAlpha,
            });

            lastOverlaySceneVersion = sceneVersionRef.current;
            lastOverlayCameraX = cameraX;
            lastOverlayPixelsPerSecond = livePixelsPerSecond;
            lastOverlayCurrentMarkerId = currentMarkerId;
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
  interactionContainerRef,
  timelineGrid,
  selectedClipId,
  clipPreviewSecondsRef,
  trackHeightForInput,
  canNativeZoom,
  onNativeCameraXPreview,
  onNativeCameraXCommit,
  onNativeZoomPreview,
  onNativeZoomCommit,
  onNativeTrackHeightChange,
}: TrackCanvasProps) {
  const backgroundCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const tracksCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const foregroundCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<TimelineRenderer | null>(null);
  const snapshotRef = useRef<TrackSceneSnapshot>({
    width,
    height,
    trackHeight,
    song,
    visibleTracks,
    clipsByTrack,
    waveformCache,
    pixelsPerSecond,
    zoomLevel: livePixelsPerSecondRef.current,
    timelineGrid,
    selectedClipId,
    clipPreviewSecondsRef,
    cameraX: cameraXRef.current,
  });
  const trackStructureSignature = useMemo(
    () => buildTrackStructureSignature(song, visibleTracks),
    [song.tracks, visibleTracks],
  );
  const clipSceneSignature = useMemo(() => buildClipSceneSignature(clipsByTrack), [clipsByTrack]);
  const waveformCacheSignature = useMemo(
    () => buildWaveformCacheSignature(waveformCache),
    [waveformCache],
  );

  useEffect(() => {
    const container = interactionContainerRef.current;
    if (!container) {
      return;
    }

    const inputManager = new InputManager({
      container,
      getState: () => ({
        cameraX: cameraXRef.current,
        zoomLevel: livePixelsPerSecondRef.current / BASE_PIXELS_PER_SECOND,
        trackHeight: trackHeightForInput,
        canZoom: canNativeZoom,
      }),
      dragThresholdPx: 6,
      panCommitDelayMs: 100,
      zoomCommitDelayMs: 100,
      zoomMultiplier: 1.2,
      trackHeightStep: 8,
      trackHeightMin: 68,
      trackHeightMax: 148,
      onPreviewCameraX: onNativeCameraXPreview,
      onCommitCameraX: onNativeCameraXCommit,
      onPreviewZoom: onNativeZoomPreview,
      onCommitZoom: onNativeZoomCommit,
      onTrackHeightChange: onNativeTrackHeightChange,
    });

    return () => {
      inputManager.destroy();
    };
  }, [
    canNativeZoom,
    cameraXRef,
    interactionContainerRef,
    livePixelsPerSecondRef,
    onNativeCameraXCommit,
    onNativeCameraXPreview,
    onNativeTrackHeightChange,
    onNativeZoomCommit,
    onNativeZoomPreview,
    trackHeightForInput,
  ]);

  snapshotRef.current = {
    width,
    height,
    trackHeight,
    song,
    visibleTracks,
    clipsByTrack,
    waveformCache,
    pixelsPerSecond,
    zoomLevel: livePixelsPerSecondRef.current,
    timelineGrid,
    selectedClipId,
    clipPreviewSecondsRef,
    cameraX: cameraXRef.current,
  };

  useEffect(() => {
    const backgroundCanvas = backgroundCanvasRef.current;
    const tracksCanvas = tracksCanvasRef.current;
    const foregroundCanvas = foregroundCanvasRef.current;
    if (!backgroundCanvas || !tracksCanvas || !foregroundCanvas) {
      return;
    }

    const backgroundContext = safeGetCanvasContext(backgroundCanvas);
    const tracksContext = safeGetCanvasContext(tracksCanvas);
    const foregroundContext = safeGetCanvasContext(foregroundCanvas);
    if (!backgroundContext || !tracksContext || !foregroundContext) {
      return;
    }

    const renderer = new TimelineRenderer(
      backgroundCanvas,
      backgroundContext,
      tracksCanvas,
      tracksContext,
      foregroundCanvas,
      foregroundContext,
      {
        getViewportMetrics: (): TimelineViewportMetrics => ({
          scrollTop: scrollViewportRef.current?.scrollTop ?? 0,
          height: scrollViewportRef.current?.clientHeight ?? snapshotRef.current.height,
        }),
        renderBackground: (context, snapshot) => {
          drawTrackCanvasBackground(context, snapshot);
          drawGridLines(
            context,
            snapshot.timelineGrid,
            snapshot.width,
            snapshot.height,
            snapshot.cameraX,
            snapshot.zoomLevel,
          );
        },
        renderTracks: (context, snapshot, viewport) => {
          drawTrackClipsLayer(context, snapshot, viewport);
        },
      },
    );
    rendererRef.current = renderer;
    renderer.updateState(snapshotRef.current);

    return () => {
      renderer.destroy();
      if (rendererRef.current === renderer) {
        rendererRef.current = null;
      }
    };
  }, [scrollViewportRef]);

  useEffect(() => {
    snapshotRef.current = {
      ...snapshotRef.current,
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
    rendererRef.current?.updateState(snapshotRef.current);
  }, [
    clipPreviewSecondsRef,
    clipSceneSignature,
    height,
    pixelsPerSecond,
    selectedClipId,
    song,
    timelineGrid,
    trackHeight,
    trackStructureSignature,
    visibleTracks,
    waveformCache,
    waveformCacheSignature,
    width,
    clipsByTrack,
  ]);

  useEffect(() => {
    let animationFrameId = 0;
    let lastCameraX = Number.NaN;
    let lastZoomLevel = Number.NaN;

    const syncRendererState = () => {
      const cameraX = cameraXRef.current;
      const zoomLevel = livePixelsPerSecondRef.current;
      if (cameraX !== lastCameraX || zoomLevel !== lastZoomLevel) {
        snapshotRef.current = {
          ...snapshotRef.current,
          cameraX,
          zoomLevel,
        };
        rendererRef.current?.updateState(snapshotRef.current);
        lastCameraX = cameraX;
        lastZoomLevel = zoomLevel;
      }

      animationFrameId = window.requestAnimationFrame(syncRendererState);
    };

    animationFrameId = window.requestAnimationFrame(syncRendererState);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [cameraXRef, livePixelsPerSecondRef]);

  return (
    <div className="lt-track-canvas-layer" style={{ width, height }}>
      <canvas className="lt-track-canvas-background" ref={backgroundCanvasRef} aria-hidden="true" />
      <canvas className="lt-track-canvas" ref={tracksCanvasRef} aria-hidden="true" />
      <canvas className="lt-track-canvas-overlay" ref={foregroundCanvasRef} aria-hidden="true" />
    </div>
  );
}
