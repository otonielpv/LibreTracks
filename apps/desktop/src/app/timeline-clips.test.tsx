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
import { useTimelineUIStore } from "../features/transport/uiStore";

describe("App / timeline-clips", () => {
  it("keeps timeline click seeks aligned after toggling compact view", async () => {
    const desktopApi = await import("../features/transport/desktopApi");
    const seekSpy = vi.mocked(desktopApi.seekTransport);

    const { container } = await renderApp();
    mockRulerBounds(container);
    mockTimelineShellMetrics(container, 1500);

    await act(async () => {
      useTimelineUIStore.getState().setZoomLevel(1);
      useTimelineUIStore.getState().setCameraX(6300);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /cambiar a vista compacta/i }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /cambiar a vista daw/i }));
    });

    await waitFor(() => {
      expect(container.querySelector(".lt-ruler-track")).toBeTruthy();
    });
    mockRulerBounds(container);
    mockTimelineShellMetrics(container, 1500);

    seekSpy.mockClear();
    const ruler = container.querySelector(".lt-ruler-track") as HTMLElement | null;
    expect(ruler).toBeTruthy();

    await act(async () => {
      fireEvent.mouseDown(ruler as HTMLElement, {
        button: 0,
        clientX: 630,
      });
      fireEvent.mouseUp(window, {
        button: 0,
        clientX: 630,
      });
    });

    await waitFor(() => {
      const positionSeconds = seekSpy.mock.calls[0]?.[0] ?? 0;
      expect(positionSeconds).toBeGreaterThan(300);
    });
  });

  it("drags a clip before bar one for pre-roll alignment", async () => {
    const desktopApi = await import("../features/transport/desktopApi");
    const moveClipSpy = vi.spyOn(desktopApi, "moveClip");

    const { container } = await renderApp();
    mockRulerBounds(container);
    mockLaneBounds(container);
    mockTimelineShellMetrics(container, 1500);

    await act(async () => {
      fireEvent(window, new Event("resize"));
    });

    const drumsRow = getTrackLaneRow(container, "Drums");
    const drumsLane = drumsRow?.querySelector(".lt-track-lane") as HTMLElement | null;
    expect(drumsLane).toBeTruthy();

    await act(async () => {
      fireEvent.mouseDown(drumsLane as HTMLElement, {
        button: 0,
        clientX: 320,
      });
      window.dispatchEvent(
        new MouseEvent("mousemove", { clientX: 220, bubbles: true }),
      );
      window.dispatchEvent(
        new MouseEvent("mouseup", { button: 0, clientX: 220, bubbles: true }),
      );
    });

    await waitFor(() => {
      expect(moveClipSpy).toHaveBeenCalled();
    });

    expect(moveClipSpy.mock.calls[0][1]).toBeLessThan(0);
  });

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

  it("ctrl-clicks two clips and drags them together via the batch move IPC", async () => {
    const desktopApi = await import("../features/transport/desktopApi");
    const moveClipsBatchSpy = vi.spyOn(desktopApi, "moveClipsBatch");
    const moveClipSpy = vi.spyOn(desktopApi, "moveClip");

    const { container } = await renderApp();
    mockRulerBounds(container);
    mockLaneBounds(container);
    mockTimelineShellMetrics(container, 1500);

    await act(async () => {
      fireEvent(window, new Event("resize"));
    });

    const drumsRow = getTrackLaneRow(container, "Drums");
    const bassRow = getTrackLaneRow(container, "Bass");
    const drumsLane = drumsRow?.querySelector(".lt-track-lane") as HTMLElement | null;
    const bassLane = bassRow?.querySelector(".lt-track-lane") as HTMLElement | null;
    expect(drumsLane).toBeTruthy();
    expect(bassLane).toBeTruthy();

    // Click drums clip (origin t=0), then ctrl+click bass clip (origin t=8)
    // to extend the selection. The Bass clip starts at t=8s which at the
    // default zoom maps roughly to clientX≈8*pps; the lane mock uses
    // left=260, so a pointerX of ~400 lands solidly inside it.
    await act(async () => {
      fireEvent.mouseDown(drumsLane as HTMLElement, {
        button: 0,
        clientX: 320,
      });
      fireEvent.mouseUp(window, { button: 0, clientX: 320 });
    });
    await act(async () => {
      fireEvent.mouseDown(bassLane as HTMLElement, {
        button: 0,
        clientX: 400,
        ctrlKey: true,
      });
      fireEvent.mouseUp(window, { button: 0, clientX: 400, ctrlKey: true });
    });

    // Now drag the drums clip 100px to the right with both clips selected.
    await act(async () => {
      fireEvent.mouseDown(drumsLane as HTMLElement, {
        button: 0,
        clientX: 320,
      });
      fireEvent.mouseMove(window, { clientX: 420 });
      fireEvent.mouseUp(window, { button: 0, clientX: 420 });
    });

    await waitFor(() => {
      expect(moveClipsBatchSpy).toHaveBeenCalled();
    });

    // The single-clip path should NOT have been used — multi-selection must
    // go through the batch IPC so the engine rebuilds the timeline once.
    expect(moveClipSpy).not.toHaveBeenCalled();

    const batchArg = moveClipsBatchSpy.mock.calls[0][0];
    expect(batchArg).toHaveLength(2);
    const clipIds = batchArg.map((m) => m.clipId).sort();
    expect(clipIds).toEqual(["clip-bass", "clip-drums"]);

    // Both clips moved by the same group delta (drums went from 0 to some
    // value, bass started at 8 and moved by the same delta).
    const drumsMove = batchArg.find((m) => m.clipId === "clip-drums")!;
    const bassMove = batchArg.find((m) => m.clipId === "clip-bass")!;
    const groupDelta = drumsMove.timelineStartSeconds - 0;
    expect(groupDelta).toBeGreaterThan(0);
    expect(bassMove.timelineStartSeconds - 8).toBeCloseTo(groupDelta, 3);
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
