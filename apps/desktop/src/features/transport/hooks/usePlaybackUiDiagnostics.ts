import { useEffect } from "react";

import {
  isIOSApp,
  reportUiDiagnosticState,
} from "@libretracks/shared/desktopApi";

import { getWaveformTileCacheDiagnostics } from "../Renderer/drawTracks";

const HEARTBEAT_INTERVAL_MS = 5_000;

type NumberRef = { current: number };

export type PlaybackUiDiagnosticsOptions = {
  playbackState: string;
  followPlayheadEnabled: boolean;
  viewMode: string;
  cameraXRef: NumberRef;
  positionSecondsRef: NumberRef;
  pixelsPerSecondRef: NumberRef;
  viewportWidthRef: NumberRef;
  visibleTrackCount: number;
  trackSceneHeight: number;
};

function canvasBackingStoreSnapshot() {
  const canvases = [...document.querySelectorAll<HTMLCanvasElement>("canvas")];
  let estimatedBytes = 0;
  let maxWidth = 0;
  let maxHeight = 0;
  for (const canvas of canvases) {
    estimatedBytes += canvas.width * canvas.height * 4;
    maxWidth = Math.max(maxWidth, canvas.width);
    maxHeight = Math.max(maxHeight, canvas.height);
  }
  return { count: canvases.length, estimatedBytes, maxWidth, maxHeight };
}

function jsHeapSnapshot() {
  const memory = (performance as Performance & {
    memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number };
  }).memory;
  return memory
    ? {
        usedBytes: memory.usedJSHeapSize ?? null,
        totalBytes: memory.totalJSHeapSize ?? null,
      }
    : null;
}

/**
 * Leaves a small state snapshot in the native process while iOS is playing.
 * If WKWebView is killed, Swift can still append this snapshot to errors.log.
 */
export function usePlaybackUiDiagnostics({
  playbackState,
  followPlayheadEnabled,
  viewMode,
  cameraXRef,
  positionSecondsRef,
  pixelsPerSecondRef,
  viewportWidthRef,
  visibleTrackCount,
  trackSceneHeight,
}: PlaybackUiDiagnosticsOptions) {
  useEffect(() => {
    if (!isIOSApp) {
      return;
    }

    let lastCameraX = cameraXRef.current;
    const startedAt = Date.now();
    const report = () => {
      const cameraX = cameraXRef.current;
      const tileCache = getWaveformTileCacheDiagnostics();
      void reportUiDiagnosticState({
        capturedAt: new Date().toISOString(),
        playbackState,
        viewMode,
        followPlayheadEnabled,
        followActive:
          playbackState === "playing" &&
          followPlayheadEnabled &&
          viewMode === "daw",
        playingForMs:
          playbackState === "playing" ? Date.now() - startedAt : 0,
        positionSeconds: positionSecondsRef.current,
        cameraX,
        cameraDeltaSinceLastHeartbeat: cameraX - lastCameraX,
        pixelsPerSecond: pixelsPerSecondRef.current,
        viewportWidth: viewportWidthRef.current,
        visibleTrackCount,
        trackSceneHeight,
        visibilityState: document.visibilityState,
        devicePixelRatio: window.devicePixelRatio || 1,
        waveformTileCache: tileCache,
        canvasBackingStores: canvasBackingStoreSnapshot(),
        jsHeap: jsHeapSnapshot(),
      });
      lastCameraX = cameraX;
    };

    report();
    if (playbackState !== "playing") {
      return;
    }
    const intervalId = window.setInterval(report, HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [
    cameraXRef,
    followPlayheadEnabled,
    pixelsPerSecondRef,
    playbackState,
    positionSecondsRef,
    trackSceneHeight,
    viewportWidthRef,
    viewMode,
    visibleTrackCount,
  ]);
}
