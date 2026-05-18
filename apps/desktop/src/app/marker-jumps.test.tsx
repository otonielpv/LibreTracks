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

describe("App / marker-jumps", () => {
  it("shows the marker context menu on right click", async () => {
    await renderApp();

    const introSection = await screen.findByRole("button", { name: /^Intro\b/i });
    await act(async () => {
      fireEvent.contextMenu(introSection, { clientX: 220, clientY: 120 });
    });

    const jumpNow = await screen.findByRole("button", { name: /jump to this marker/i });
    const context = jumpNow.closest(".lt-context-menu");
    expect(context).toBeTruthy();
    expect(within(context as HTMLElement).getByRole("button", { name: /jump to this marker/i })).toBeTruthy();
    expect(within(context as HTMLElement).getByRole("button", { name: /rename/i })).toBeTruthy();
    expect(within(context as HTMLElement).getByRole("button", { name: /delete/i })).toBeTruthy();
  });

  it("triggers marker jump with digit keys and cancels with escape", async () => {
    await renderApp();

    await chooseMarkerJumpMode(en.transport.jumpMode.nextMarker);

    await act(async () => {
      fireEvent.keyDown(window, { code: "Digit2", key: "2" });
    });

    await waitFor(() => {
      expect(useTransportStore.getState().playback?.pendingMarkerJump?.targetMarkerName).toBe("Bridge");
      expect(useTransportStore.getState().playback?.pendingMarkerJump?.trigger).toBe("next_marker");
    });

    await act(async () => {
      fireEvent.keyDown(window, { code: "Escape", key: "Escape" });
    });

    expect(await screen.findByText(textMatcher(en.transport.status.jumpCancelled))).toBeTruthy();
  });

  it("maps numpad 0 to the first marker", async () => {
    await renderApp();

    await chooseMarkerJumpMode(en.transport.jumpMode.nextMarker);

    await act(async () => {
      fireEvent.keyDown(window, { code: "Numpad0", key: "0" });
    });

    expect(await screen.findByText(jumpNextMarkerMatcher("Intro"))).toBeTruthy();
  });

  it("maps shift plus 0 to the first song region", async () => {
    await renderApp();

    await chooseSongJumpTrigger(en.transport.jumpMode.regionEnd);

    await act(async () => {
      fireEvent.keyDown(window, { code: "Digit0", key: "0", shiftKey: true });
    });

    await waitFor(() => {
      expect(useTransportStore.getState().playback?.pendingMarkerJump?.targetMarkerName).toBe("LibreTracks Session");
      expect(useTransportStore.getState().playback?.pendingMarkerJump?.trigger).toBe("region_end");
    });
  });

  it("maps shift plus numpad navigation keys to song regions", async () => {
    await renderApp();

    await chooseSongJumpTrigger(en.transport.jumpMode.regionEnd);

    await act(async () => {
      fireEvent.keyDown(window, {
        code: "Insert",
        key: "Insert",
        location: KeyboardEvent.DOM_KEY_LOCATION_NUMPAD,
        shiftKey: true,
      });
    });

    await waitFor(() => {
      expect(useTransportStore.getState().playback?.pendingMarkerJump?.targetMarkerName).toBe("LibreTracks Session");
      expect(useTransportStore.getState().playback?.pendingMarkerJump?.trigger).toBe("region_end");
    });
  });

  it("overwrites the armed marker on click and cancels when clicked again", async () => {
    await renderApp();

    await chooseMarkerJumpMode(en.transport.jumpMode.nextMarker);

    const introMarker = await screen.findByRole("button", { name: /^Intro\b/i });
    const bridgeMarker = await screen.findByRole("button", { name: /^Bridge\b/i });

    await act(async () => {
      fireEvent.click(introMarker);
    });

    expect(await screen.findByText(pendingJumpMatcher("Intro", en.transport.jumpMode.nextMarker))).toBeTruthy();

    await act(async () => {
      fireEvent.click(bridgeMarker);
    });

    expect(await screen.findByText(pendingJumpMatcher("Bridge", en.transport.jumpMode.nextMarker))).toBeTruthy();

    await act(async () => {
      fireEvent.click(bridgeMarker);
    });

    expect(
      await screen.findByText(textMatcher(interpolate(en.transport.status.jumpCancelledSection, { name: "Bridge" }))),
    ).toBeTruthy();
    expect(screen.queryByText(pendingJumpMatcher("Bridge", en.transport.jumpMode.nextMarker))).toBeNull();
  });

  it("warns when next marker jump is ignored because there are no markers ahead", async () => {
    const { container } = await renderApp();
    const shell = mockTimelineShellMetrics(container, 1500);
    mockRulerBounds(container);

    await act(async () => {
      fireEvent(window, new Event("resize"));
    });

    const ruler = container.querySelector(".lt-ruler-track") as HTMLElement;
    for (let index = 0; index < 6; index += 1) {
      await act(async () => {
        fireEvent.wheel(ruler, { deltaY: 100, clientX: 1180 });
      });
    }

    await act(async () => {
      fireEvent.mouseDown(ruler, { button: 0, clientX: 1180 });
      fireEvent.mouseMove(window, { button: 0, clientX: 1180 });
      fireEvent.mouseUp(window, { button: 0, clientX: 1180 });
    });

    expect((shell as HTMLDivElement).scrollLeft).toBeGreaterThanOrEqual(0);

    await chooseMarkerJumpMode(en.transport.jumpMode.nextMarker);

    const introMarker = await screen.findByRole("button", { name: /^Intro\b/i });
    await act(async () => {
      fireEvent.click(introMarker);
    });

    expect(await screen.findByText(textMatcher(en.transport.status.noMarkersAhead))).toBeTruthy();
    expect(screen.queryByText(textMatcher(en.transport.shell.pendingJump.split("{{markerName}}")[0].trim()))).toBeNull();
  });

});
