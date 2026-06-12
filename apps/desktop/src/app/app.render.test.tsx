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

});
