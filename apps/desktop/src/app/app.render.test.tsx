import { vi } from "vitest";

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  en,
  App,
  emitWaveformReadyForTest,
  testDesktopApiMock,
  useTransportStore,
  TIMELINE_DEFAULT_TRACK_HEIGHT,
  interpolate,
  textMatcher,
  clipAddedMatcher,
  trackCreatedMatcher,
  trackDeletedMatcher,
  jumpNextMarkerMatcher,
  pendingJumpMatcher,
  chooseMarkerJumpMode,
  chooseSongJumpTrigger,
  disablePointerEventSupport,
  emitNativeDropEvent,
  getExternalDropGuide,
  getLibraryAssetRow,
  createExternalFileDataTransfer,
  createTestFile,
  attachNativePath,
  renderApp,
  openLibraryPanel,
  mockRulerBounds,
  mockTimelineShellMetrics,
  mockLaneBounds,
  mockTrackListBounds,
  mockTimelinePaneBounds,
  getTrackHeader,
  getTrackLaneRow,
  getLibraryAssetButton,
  mockTrackRowDragGeometry,
  setMockNativeWebviewPosition
} from "../test/testUtils";

describe("App / app.render", () => {
  it("renders the timeline-centric DAW shell", async () => {
    const { container } = await renderApp();

    expect(screen.getByText("LIBRETRACKS")).toBeTruthy();
    expect(screen.getByRole("button", { name: textMatcher(en.timelineTopbar.play) })).toBeTruthy();
    expect(screen.getByRole("button", { name: textMatcher(en.timelineTopbar.pause) })).toBeTruthy();
    expect(screen.getByRole("button", { name: textMatcher(en.timelineTopbar.stop) })).toBeTruthy();
    expect(screen.getByRole("button", { name: textMatcher(en.timelineToolbar.enableFollowPlayhead) })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /browser/i })).toBeNull();
    expect(screen.queryByLabelText(textMatcher(en.library.panelAria))).toBeNull();
    expect(container.querySelector(".lt-ruler-canvas-layer")).toBeTruthy();
  });

  it("opens Live View from the timeline toolbar and returns to the DAW", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    const { container } = await renderApp();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: textMatcher(en.liveView.open) }),
      );
    });

    expect(screen.getByRole("main", { name: textMatcher(en.liveView.title) })).toBeTruthy();
    expect(container.querySelectorAll(".lt-live-cue-row")).toHaveLength(4);
    expect(container.querySelector(".lt-ruler-canvas-layer")).toBeNull();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: textMatcher(en.liveView.openDaw) }),
      );
    });

    expect(container.querySelector(".lt-ruler-canvas-layer")).toBeTruthy();
  });

  it("cycles DAW, Compact and Live views with Tab", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    const { container } = await renderApp();

    fireEvent.keyDown(window, { code: "Tab", key: "Tab" });
    expect(container.querySelector(".lt-compact-view")).toBeTruthy();

    fireEvent.keyDown(window, { code: "Tab", key: "Tab" });
    expect(
      screen.getByRole("main", { name: textMatcher(en.liveView.title) }),
    ).toBeTruthy();

    fireEvent.keyDown(window, { code: "Tab", key: "Tab" });
    expect(container.querySelector(".lt-ruler-canvas-layer")).toBeTruthy();
  });

  it("cycles Live, Compact and DAW views with Shift+Tab", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    const { container } = await renderApp();

    fireEvent.keyDown(window, {
      code: "Tab",
      key: "Tab",
      shiftKey: true,
    });
    expect(
      screen.getByRole("main", { name: textMatcher(en.liveView.title) }),
    ).toBeTruthy();

    fireEvent.keyDown(window, {
      code: "Tab",
      key: "Tab",
      shiftKey: true,
    });
    expect(container.querySelector(".lt-compact-view")).toBeTruthy();

    fireEvent.keyDown(window, {
      code: "Tab",
      key: "Tab",
      shiftKey: true,
    });
    expect(container.querySelector(".lt-ruler-canvas-layer")).toBeTruthy();
  });

  it("lets the tempo input hold a two-decimal BPM without snapping it", async () => {
    // Regression: the input had step=0.1, and on a number input `step` defines
    // the grid of valid values — so a typed 130.55 was snapped to 130.6 by the
    // browser before the commit handler ever saw it. Tempo is f64 end to end.
    await renderApp();

    const bpmInput = screen.getByLabelText(
      textMatcher(en.timelineTopbar.songBpmAria),
    ) as HTMLInputElement;

    expect(bpmInput.step).toBe("any");

    await act(async () => {
      fireEvent.change(bpmInput, { target: { value: "130.55" } });
    });

    expect(bpmInput.value).toBe("130.55");
    expect(bpmInput.validity.stepMismatch).toBe(false);
  });

  it("supports transport shortcuts from the keyboard", async () => {
    await renderApp();

    await act(async () => {
      fireEvent.keyDown(window, { code: "Space", key: " " });
    });

    expect(await screen.findByText(textMatcher(en.transport.status.playbackStarted))).toBeTruthy();
    expect(await screen.findByText("playing")).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(window, { code: "Space", key: " " });
    });

    expect(await screen.findByText(textMatcher(en.transport.status.playbackPaused))).toBeTruthy();
    expect(await screen.findByText("paused")).toBeTruthy();
  });

  it("stops playback with Shift+Space", async () => {
    await renderApp();

    await act(async () => {
      fireEvent.keyDown(window, { code: "Space", key: " " });
    });
    expect(await screen.findByText("playing")).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(window, { code: "Space", key: " ", shiftKey: true });
    });

    expect(await screen.findByText(textMatcher(en.transport.status.playbackStopped))).toBeTruthy();
    expect(await screen.findByText("stopped")).toBeTruthy();
  });

  it("jumps to the start with the Home key", async () => {
    await renderApp();

    await act(async () => {
      fireEvent.keyDown(window, { code: "Home", key: "Home" });
    });

    expect(await screen.findByText(textMatcher(en.transport.status.movedToStart))).toBeTruthy();
  });

});
