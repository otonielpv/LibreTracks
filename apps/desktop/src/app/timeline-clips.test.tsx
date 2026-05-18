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

describe("App / timeline-clips", () => {
  it("clears stale library clip ghosts after deleting a track", async () => {
    disablePointerEventSupport();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { container } = await renderApp();
    mockRulerBounds(container);
    mockLaneBounds(container);
    mockTrackListBounds(container);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: textMatcher(en.transport.shell.library) }));
    });

    const drumsRow = getTrackLaneRow(container, "Drums");
    expect(drumsRow).toBeTruthy();

    await act(async () => {
      fireEvent.mouseDown(getLibraryAssetButton("drums.wav"), {
        button: 0,
        clientX: 90,
        clientY: 210,
      });
      fireEvent.mouseMove(window, { clientX: 420, clientY: 160 });
    });

    await waitFor(() => {
      expect(container.querySelectorAll(".lt-library-clip-ghost").length).toBeGreaterThan(0);
    });

    const drumsHeader = getTrackHeader(container, "Drums");
    expect(drumsHeader).toBeTruthy();

    await act(async () => {
      fireEvent.contextMenu(drumsHeader as HTMLElement, { clientX: 180, clientY: 220 });
    });

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: textMatcher(en.common.delete) }));
    });

    expect(confirmSpy).toHaveBeenCalled();
    expect(await screen.findByText(trackDeletedMatcher("Drums"))).toBeTruthy();
    await waitFor(() => {
      expect(container.querySelector(".lt-library-clip-ghost")).toBeNull();
    });
  });

  it("clears the arrangement immediately after deleting the only track with a clip", async () => {
    const desktopApi = await import("../features/transport/desktopApi");
    await desktopApi.createSong();
    await desktopApi.createTrack({
      name: "Solo",
      kind: "audio",
    });
    const seededSong = await desktopApi.getSongView();
    const seededTrackId = seededSong?.tracks.at(-1)?.id ?? null;
    expect(seededTrackId).toBeTruthy();
    await desktopApi.createClipsBatch([
      {
        trackId: seededTrackId as string,
        filePath: "audio/drums.wav",
        timelineStartSeconds: 0,
      },
    ]);

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { container } = render(<App />);
  await screen.findByText(textMatcher(en.transport.status.readyDesktop));
    await screen.findByText("Solo");
    mockRulerBounds(container);
    mockTrackListBounds(container);

    const drumsHeader = getTrackHeader(container, "Solo");
    await act(async () => {
      fireEvent.contextMenu(drumsHeader, { clientX: 180, clientY: 220 });
    });

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: textMatcher(en.common.delete) }));
    });

    expect(confirmSpy).toHaveBeenCalled();
    expect(await screen.findByText(trackDeletedMatcher("Solo"))).toBeTruthy();
    expect(container.querySelector(".lt-track-list")).toBeTruthy();
    expect(container.querySelector(".lt-track-lane-row")).toBeNull();
    expect(container.querySelector(".lt-library-clip-ghost")).toBeNull();
  });

  it("creates a marker from the ruler right-click context menu", async () => {
    const { container } = await renderApp();
    mockRulerBounds(container);

    const ruler = container.querySelector(".lt-ruler-track") as HTMLElement;
    await act(async () => {
      fireEvent.contextMenu(ruler, { clientX: 420, clientY: 32 });
    });

    expect(await screen.findByRole("button", { name: /create marker/i })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create marker/i }));
    });

    expect(
      await screen.findByText(textMatcher(en.transport.status.markerCreatedAt.split("{{time}}")[0].trim())),
    ).toBeTruthy();
    expect(screen.getByText("Marker 5")).toBeTruthy();
  });

  it("opens the clip context menu and allows splitting at the cursor", async () => {
    const { container } = await renderApp();
    mockRulerBounds(container);
    mockLaneBounds(container);
    mockTimelineShellMetrics(container, 1500);

    await act(async () => {
      fireEvent(window, new Event("resize"));
    });

    const ruler = container.querySelector(".lt-ruler-track") as HTMLElement;
    await act(async () => {
      fireEvent.mouseDown(ruler, { button: 0, clientX: 320 });
    });
    await act(async () => {
      fireEvent.mouseMove(window, { button: 0, clientX: 320 });
      fireEvent.mouseUp(window, { button: 0, clientX: 320 });
    });

    await screen.findByText(textMatcher(en.transport.status.cursorMoved.split("{{time}}")[0].trim()));

    const drumsRow = getTrackLaneRow(container, "Drums");
    expect(drumsRow).toBeTruthy();
    const drumsLane = drumsRow?.querySelector(".lt-track-lane") as HTMLElement | null;
    expect(drumsLane).toBeTruthy();

    await act(async () => {
      fireEvent.contextMenu(drumsLane as HTMLElement, { clientX: 320, clientY: 200 });
    });

    const splitAction = await screen.findByRole("button", { name: textMatcher(en.transport.menu.splitClipAtCursor) });
    expect(splitAction.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      fireEvent.click(splitAction);
    });

    expect(await screen.findByText(textMatcher(en.transport.status.clipSplitAt.replace("{{time}}", "")))).toBeTruthy();
    expect(screen.getByText(interpolate(en.timelineToolbar.clipsCount, { count: 5 }))).toBeTruthy();
  });

});
