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
  setMockNativeWebviewPosition,
  submitPromptDialog
} from "../test/testUtils";

describe("App / library", () => {
  it("toggles the library panel from the sidebar button", async () => {
    await renderApp();

    const libraryButton = screen.getByRole("button", { name: textMatcher(en.transport.shell.library) });
    expect(screen.queryByLabelText(textMatcher(en.library.panelAria))).toBeNull();

    await act(async () => {
      fireEvent.click(libraryButton);
    });

    expect(await screen.findByLabelText(textMatcher(en.library.panelAria))).toBeTruthy();
    expect(screen.getByText("drums.wav")).toBeTruthy();

    await act(async () => {
      fireEvent.click(libraryButton);
    });

    expect(screen.queryByLabelText(textMatcher(en.library.panelAria))).toBeNull();
  });

  it("shows library assets and starts a pointer drag ghost for timeline drops", async () => {
    disablePointerEventSupport();
    await renderApp();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: textMatcher(en.transport.shell.library) }));
    });

    expect(screen.getByText("drums.wav")).toBeTruthy();
    expect(screen.getByText("bass.wav")).toBeTruthy();

    await act(async () => {
      fireEvent.mouseDown(getLibraryAssetButton("drums.wav"), {
        button: 0,
        clientX: 90,
        clientY: 210,
      });
      fireEvent.mouseMove(window, {
        clientX: 130,
        clientY: 250,
      });
    });

    expect(screen.getByText(en.library.dragHintTimeline)).toBeTruthy();

    await act(async () => {
      fireEvent.mouseUp(window, {
        clientX: 130,
        clientY: 250,
      });
    });
  });

  it("starts a multi-asset pointer drag from the current library selection", async () => {
    disablePointerEventSupport();
    await renderApp();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /library/i }));
    });

    await act(async () => {
      fireEvent.click(getLibraryAssetButton("drums.wav"));
      fireEvent.click(getLibraryAssetButton("bass.wav"), { ctrlKey: true });
    });

    expect(screen.getByText("2 selected")).toBeTruthy();

    await act(async () => {
      fireEvent.mouseDown(getLibraryAssetButton("drums.wav"), {
        button: 0,
        clientX: 90,
        clientY: 210,
      });
      fireEvent.mouseMove(window, {
        clientX: 138,
        clientY: 258,
      });
    });

    expect(screen.getByText("2 assets")).toBeTruthy();
    expect(screen.getByText(en.library.dragHintTimelineMultiple)).toBeTruthy();

    await act(async () => {
      fireEvent.mouseUp(window, {
        clientX: 138,
        clientY: 258,
      });
    });
  });

  it("moves a library asset into a folder with pointer drag", async () => {
    disablePointerEventSupport();
    const desktopApi = await import("../features/transport/desktopApi");
    const moveLibraryAssetMock = vi.mocked(desktopApi.moveLibraryAsset);

    await renderApp();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: textMatcher(en.transport.shell.library) }));
    });

    await screen.findByText("drums.wav");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: textMatcher(en.library.folderButton) }));
    });

    await submitPromptDialog("Band");
    const bandFolderLabel = await screen.findByText("Band");
    const bandFolderSummary = bandFolderLabel.closest(".lt-library-folder-summary") as HTMLElement | null;
    expect(bandFolderSummary).toBeTruthy();

    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => bandFolderSummary),
    });

    await act(async () => {
      fireEvent.mouseDown(getLibraryAssetButton("drums.wav"), {
        button: 0,
        clientX: 90,
        clientY: 210,
      });
      fireEvent.mouseMove(window, {
        clientX: 120,
        clientY: 320,
      });
      fireEvent.mouseUp(window, {
        clientX: 120,
        clientY: 320,
      });
    });

    await waitFor(() => {
      expect(moveLibraryAssetMock).toHaveBeenCalledWith("audio/drums.wav", "Band");
    });

  });

  it("merges the old song library folder into the existing new one when renaming a compact song", async () => {
    const desktopApi = await import("../features/transport/desktopApi");
    await desktopApi.moveLibraryAsset("audio/drums.wav", "LibreTracks Session");
    await desktopApi.createLibraryFolder("Renamed Song");

    const renameLibraryFolderMock = vi.mocked(desktopApi.renameLibraryFolder);
    const moveLibraryAssetMock = vi.mocked(desktopApi.moveLibraryAsset);
    const deleteLibraryFolderMock = vi.mocked(desktopApi.deleteLibraryFolder);
    renameLibraryFolderMock.mockClear();
    moveLibraryAssetMock.mockClear();
    deleteLibraryFolderMock.mockClear();

    await renderApp();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /cambiar a vista compacta/i }));
    });

    const compactSongHeader = document.querySelector(".lt-compact-song-header");
    expect(compactSongHeader).toBeTruthy();

    await act(async () => {
      fireEvent.contextMenu(compactSongHeader as HTMLElement, {
        clientX: 120,
        clientY: 120,
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /renombrar canci/i }));
    });

    await submitPromptDialog("Renamed Song");
    await waitFor(() => {
      expect(moveLibraryAssetMock).toHaveBeenCalledWith("audio/drums.wav", "Renamed Song");
      expect(deleteLibraryFolderMock).toHaveBeenCalledWith("LibreTracks Session");
      expect(renameLibraryFolderMock).not.toHaveBeenCalled();
    });
  });

});
