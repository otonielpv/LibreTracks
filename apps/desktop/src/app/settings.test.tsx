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
import {
  EMPTY_GUEST_STATUS,
  useNetworkSessionStore,
} from "../features/network/networkSessionStore";

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

  it("track meters are post-fader by default and the Audio selector persists the choice", async () => {
    const desktopApi = await import("../features/transport/desktopApi");
    const updateSpy = vi.mocked(desktopApi.updateAudioSettings);
    updateSpy.mockClear();
    await renderApp();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Settings$/i }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("tab", { name: /^Audio$/i }));
    });

    const select = (await screen.findByRole("combobox", {
      name: textMatcher(en.transport.settingsModal.trackMeterMode),
    })) as HTMLSelectElement;
    expect(select.value).toBe("postFader");

    await act(async () => {
      fireEvent.change(select, { target: { value: "postPan" } });
    });

    await waitFor(() =>
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ trackMeterMode: "postPan" }),
      ),
    );
  });

  it("saves live jump settings through the host in guest mirror mode", async () => {
    const desktopApi = await import("../features/transport/desktopApi");
    const sharedDesktopApi = await import("@libretracks/shared/desktopApi");
    const updateSpy = vi.mocked(desktopApi.updateAudioSettings);
    const saveSpy = vi.mocked(desktopApi.saveSettings);
    updateSpy.mockClear();
    saveSpy.mockClear();
    sharedDesktopApi.setGuestMirrorMode(true);
    useNetworkSessionStore.getState().setGuest({
      ...EMPTY_GUEST_STATUS, joined: true, state: "connected", role: "controller",
    });

    try {
      await renderApp();
      await chooseMarkerJumpMode(en.transport.jumpMode.nextMarker);

      await waitFor(() =>
        expect(saveSpy).toHaveBeenCalledWith(
          expect.objectContaining({ globalJumpMode: "next_marker" }),
        ),
      );
      expect(updateSpy).not.toHaveBeenCalled();
    } finally {
      sharedDesktopApi.setGuestMirrorMode(false);
      useNetworkSessionStore.getState().setGuest(EMPTY_GUEST_STATUS);
    }
  });
});
