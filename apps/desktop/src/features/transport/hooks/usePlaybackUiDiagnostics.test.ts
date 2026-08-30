import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePlaybackUiDiagnostics } from "./usePlaybackUiDiagnostics";

const reportUiDiagnosticState = vi.fn(
  async (_state: Record<string, unknown>) => {},
);
const getWaveformTileCacheDiagnostics = vi.fn(() => ({
  entries: 12,
  bytes: 3_145_728,
  visibleEntries: 8,
}));
const releaseNonVisibleWaveformTiles = vi.fn();

vi.mock("@libretracks/shared/desktopApi", () => ({
  isIOSApp: true,
  reportUiDiagnosticState: (state: Record<string, unknown>) =>
    reportUiDiagnosticState(state),
}));

vi.mock("../Renderer/drawTracks", () => ({
  getWaveformTileCacheDiagnostics: () =>
    getWaveformTileCacheDiagnostics(),
  releaseNonVisibleWaveformTiles: () => releaseNonVisibleWaveformTiles(),
}));

describe("usePlaybackUiDiagnostics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.querySelectorAll("canvas").forEach((canvas) => canvas.remove());
  });

  it("leaves periodic native breadcrumbs with follow-camera and canvas state", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 100;
    document.body.appendChild(canvas);
    const cameraXRef = { current: 120 };

    renderHook(() =>
      usePlaybackUiDiagnostics({
        playbackState: "playing",
        followPlayheadEnabled: true,
        viewMode: "daw",
        cameraXRef,
        positionSecondsRef: { current: 42 },
        pixelsPerSecondRef: { current: 80 },
        viewportWidthRef: { current: 700 },
        visibleTrackCount: 24,
        trackSceneHeight: 1440,
      }),
    );

    expect(reportUiDiagnosticState).toHaveBeenCalledTimes(1);
    expect(reportUiDiagnosticState.mock.calls[0][0]).toMatchObject({
      playbackState: "playing",
      followActive: true,
      cameraX: 120,
      waveformTileCache: {
        entries: 12,
        bytes: 3_145_728,
        visibleEntries: 8,
      },
      canvasBackingStores: { count: 1, estimatedBytes: 80_000 },
    });

    cameraXRef.current = 180;
    vi.advanceTimersByTime(5_000);
    expect(reportUiDiagnosticState).toHaveBeenCalledTimes(2);
    expect(reportUiDiagnosticState.mock.calls[1][0]).toMatchObject({
      cameraX: 180,
      cameraDeltaSinceLastHeartbeat: 60,
    });
  });

  it("releases only cached waveform history after an iOS memory warning", () => {
    renderHook(() =>
      usePlaybackUiDiagnostics({
        playbackState: "playing",
        followPlayheadEnabled: true,
        viewMode: "daw",
        cameraXRef: { current: 0 },
        positionSecondsRef: { current: 0 },
        pixelsPerSecondRef: { current: 80 },
        viewportWidthRef: { current: 700 },
        visibleTrackCount: 24,
        trackSceneHeight: 1440,
      }),
    );

    window.dispatchEvent(new Event("libretracks:ios-memory-warning"));

    expect(releaseNonVisibleWaveformTiles).toHaveBeenCalledOnce();
  });
});
