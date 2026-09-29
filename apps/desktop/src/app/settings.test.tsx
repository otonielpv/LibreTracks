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

describe("App / settings", () => {
  it("renders the settings panel from the sidebar button", async () => {
    await renderApp();

    const settingsButton = screen.getByRole("button", { name: /^Settings$/i });
    await act(async () => {
      fireEvent.click(settingsButton);
    });

    expect(await screen.findByText(textMatcher(en.transport.settingsModal.description))).toBeTruthy();
  });

  it("pause at song end is off by default and the General toggle persists it", async () => {
    const desktopApi = await import("../features/transport/desktopApi");
    const updateSpy = vi.mocked(desktopApi.updateAudioSettings);
    updateSpy.mockClear();
    await renderApp();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Settings$/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("tab", { name: /^General$/i }));
    });

    const toggle = (await screen.findByRole("checkbox", {
      name: textMatcher(en.transport.settingsModal.pauseAtSongEnd),
    })) as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    await act(async () => {
      fireEvent.click(toggle);
    });

    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ pauseAtSongEnd: true }),
      ),
    );
  });
});
