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

describe("App / timeline-tracks", () => {
  it("keeps folder tracks integrated in the same timeline box", async () => {
    await renderApp();

    expect(screen.getByText("Rhythm")).toBeTruthy();
    expect(screen.getByText("Guide")).toBeTruthy();
    expect(
      screen.getByRole("slider", {
        name: textMatcher(interpolate(en.trackHeader.volumeAria, { name: "Rhythm" })),
      }),
    ).toBeTruthy();
    expect(screen.getByRole("slider", { name: textMatcher(interpolate(en.trackHeader.volumeAria, { name: "Drums" })) })).toBeTruthy();
  });

  it("opens the global track-list context menu in an empty project and creates the first track", async () => {
    const desktopApi = await import("../features/transport/desktopApi");
    await desktopApi.createSong();

    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("Narration");
    const { container } = await renderApp();

    expect(screen.getByLabelText(textMatcher(en.transport.shell.emptyArrangementDropzone))).toBeTruthy();

    const trackList = container.querySelector(".lt-track-list") as HTMLElement | null;
    expect(trackList).toBeTruthy();

    await act(async () => {
      fireEvent.contextMenu(trackList as HTMLElement, { clientX: 160, clientY: 240 });
    });

    expect(await screen.findByRole("button", { name: /add audio track/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /add folder track/i })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /add audio track/i }));
    });

    expect(promptSpy).toHaveBeenCalledWith(en.transport.prompt.trackName, en.transport.defaults.audioTrackName);
    expect(await screen.findByText(trackCreatedMatcher("Narration"))).toBeTruthy();
    expect(screen.getByText("Narration")).toBeTruthy();
  });

  it("pans the timeline by dragging over an empty lane", async () => {
    const { container } = await renderApp();
    const shell = mockTimelineShellMetrics(container, 1500);
    const firstLane = container.querySelector(".lt-track-lane") as HTMLElement | null;
    expect(firstLane).toBeTruthy();

    Object.defineProperty(shell, "scrollLeft", {
      configurable: true,
      writable: true,
      value: 120,
    });

    await act(async () => {
      fireEvent.mouseDown(firstLane as HTMLElement, { button: 0, clientX: 300 });
      fireEvent.mouseMove(window, { clientX: 220 });
      fireEvent.mouseUp(window, { button: 0, clientX: 220 });
    });

    expect((shell as HTMLDivElement).scrollLeft).toBe(80);
  });

  it("collapses folder children locally in the UI", async () => {
    await renderApp();

    const toggle = await screen.findByRole("button", { name: textMatcher(interpolate(en.trackHeader.collapse, { name: "Rhythm" })) });
    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(screen.queryByText("Drums")).toBeNull();
    expect(screen.queryByText("Bass")).toBeNull();
    expect(await screen.findByRole("button", { name: textMatcher(interpolate(en.trackHeader.expand, { name: "Rhythm" })) })).toBeTruthy();
  });

  it("zooms the timeline with the wheel and exposes a native horizontal scrollbar", async () => {
    const { container } = await renderApp();
    const shell = mockTimelineShellMetrics(container, 1500);
    mockRulerBounds(container);

    await act(async () => {
      fireEvent(window, new Event("resize"));
    });

    const ruler = container.querySelector(".lt-ruler-track") as HTMLElement;
    await act(async () => {
      fireEvent.mouseDown(ruler, { button: 0, clientX: 900 });
    });
    await act(async () => {
      fireEvent.mouseMove(window, { button: 0, clientX: 900 });
      fireEvent.mouseUp(window, { button: 0, clientX: 900 });
    });

    expect(await screen.findByText(textMatcher(en.transport.status.cursorMoved.split("{{time}}")[0].trim()))).toBeTruthy();
    expect(screen.queryByRole("slider", { name: /zoom horizontal del timeline/i })).toBeNull();
    expect(screen.getByLabelText(textMatcher(en.transport.shell.horizontalScroll))).toBeTruthy();

    await act(async () => {
      fireEvent.wheel(ruler, { deltaY: -100, clientX: 900 });
    });

    expect((shell as HTMLDivElement).scrollLeft).toBeGreaterThan(0);
  });

  it("zooms when the wheel is used over the painted timeline canvas", async () => {
    const { container } = await renderApp();
    const shell = mockTimelineShellMetrics(container, 1500);
    mockTrackListBounds(container, 1500, 500);

    await act(async () => {
      fireEvent(window, new Event("resize"));
    });

    const trackCanvas = container.querySelector(".lt-track-canvas") as HTMLElement | null;
    expect(trackCanvas).toBeTruthy();

    await act(async () => {
      fireEvent.wheel(trackCanvas as HTMLElement, { deltaY: -100, clientX: 900 });
    });

    expect((shell as HTMLDivElement).scrollLeft).toBeGreaterThan(0);
  });

  it("zooms when the wheel is used over the track list surface", async () => {
    const { container } = await renderApp();
    const shell = mockTimelineShellMetrics(container, 1500);
    mockTrackListBounds(container, 1500, 500);

    await act(async () => {
      fireEvent(window, new Event("resize"));
    });

    const trackList = container.querySelector(".lt-track-list") as HTMLElement | null;
    expect(trackList).toBeTruthy();

    await act(async () => {
      fireEvent.wheel(trackList as HTMLElement, { deltaY: -100, clientX: 900 });
    });

    expect((shell as HTMLDivElement).scrollLeft).toBeGreaterThan(0);
  });

  it("registers non-passive native wheel listeners on timeline interaction surfaces", async () => {
    const addEventListenerSpy = vi.spyOn(HTMLDivElement.prototype, "addEventListener");

    await renderApp();

    const wheelCalls = addEventListenerSpy.mock.calls.filter(
      ([type, _listener, options]) =>
        type === "wheel" && typeof options === "object" && options !== null && "passive" in options,
    );

    expect(wheelCalls.length).toBeGreaterThanOrEqual(2);
    expect(
      wheelCalls.some(
        ([, , options]) =>
          typeof options === "object" && options !== null && "passive" in options && options.passive === false,
      ),
    ).toBe(true);
  });

  it("resizes track rows with ctrl plus wheel anywhere on the timeline shell", async () => {
    const { container } = await renderApp();
    mockTimelineShellMetrics(container, 1500);

    const firstHeader = container.querySelector(".lt-track-header") as HTMLElement | null;
    const firstLane = container.querySelector(".lt-track-lane") as HTMLElement | null;
    expect(firstHeader).toBeTruthy();
    expect(firstLane).toBeTruthy();
    expect((firstHeader as HTMLElement).style.height).toBe(`${TIMELINE_DEFAULT_TRACK_HEIGHT}px`);
    expect((firstLane as HTMLElement).style.height).toBe(`${TIMELINE_DEFAULT_TRACK_HEIGHT}px`);

    await act(async () => {
      fireEvent.wheel(firstHeader as HTMLElement, { deltaY: -100, ctrlKey: true });
    });

    expect((firstHeader as HTMLElement).style.height).toBe(`${TIMELINE_DEFAULT_TRACK_HEIGHT + 8}px`);
    expect((firstLane as HTMLElement).style.height).toBe(`${TIMELINE_DEFAULT_TRACK_HEIGHT + 8}px`);
  });

  it("resizes track rows with ctrl plus wheel over the native timeline lane surface", async () => {
    const { container } = await renderApp();
    mockTimelineShellMetrics(container, 1500);

    const firstHeader = container.querySelector(".lt-track-header") as HTMLElement | null;
    const trackList = container.querySelector(".lt-track-list") as HTMLElement | null;
    expect(firstHeader).toBeTruthy();
    expect(trackList).toBeTruthy();
    expect((firstHeader as HTMLElement).style.height).toBe(`${TIMELINE_DEFAULT_TRACK_HEIGHT}px`);

    await act(async () => {
      fireEvent.wheel(trackList as HTMLElement, { deltaY: -100, ctrlKey: true });
    });

    expect((firstHeader as HTMLElement).style.height).toBe(`${TIMELINE_DEFAULT_TRACK_HEIGHT + 8}px`);
  });

  it("creates a new audio track from the track context menu", async () => {
    vi.spyOn(window, "prompt").mockReturnValue("New track");
    await renderApp();

    const keysHeader = screen.getByText("Keys").closest(".lt-track-header");
    expect(keysHeader).toBeTruthy();

    await act(async () => {
      fireEvent.contextMenu(keysHeader as HTMLElement, { clientX: 180, clientY: 300 });
    });

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: textMatcher(en.transport.menu.insertTrack) }));
    });

    expect(await screen.findByText(trackCreatedMatcher("New track"))).toBeTruthy();
    expect(screen.getByText("New track")).toBeTruthy();
  });

  it("reorders tracks vertically from the header drag handle", async () => {
    const { container } = await renderApp();
    mockTrackRowDragGeometry(container);

    const keysHeader = getTrackHeader(container, "Keys");

    await act(async () => {
      fireEvent.mouseDown(keysHeader, { button: 0, clientX: 80, clientY: 470 });
    });

    await act(async () => {
      fireEvent.mouseMove(window, { button: 0, clientX: 80, clientY: 380 });
      fireEvent.mouseUp(window, { button: 0, clientX: 80, clientY: 380 });
    });

    expect(await screen.findByText(textMatcher(interpolate(en.transport.status.tracksReordered, { count: 1 })))).toBeTruthy();
  });

  it("allows dragging a track into a folder track", async () => {
    const { container } = await renderApp();
    mockTrackRowDragGeometry(container);

    const keysHeader = getTrackHeader(container, "Keys");

    await act(async () => {
      fireEvent.mouseDown(keysHeader, { button: 0, clientX: 80, clientY: 470 });
    });

    await act(async () => {
      fireEvent.mouseMove(window, { button: 0, clientX: 80, clientY: 410 });
      fireEvent.mouseUp(window, { button: 0, clientX: 80, clientY: 410 });
    });

    expect(await screen.findByText(textMatcher(interpolate(en.transport.status.tracksReordered, { count: 1 })))).toBeTruthy();
  });

});
