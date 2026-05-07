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

describe("App / drag-drop", () => {
  it("drops a library asset onto a track lane and creates a new clip without dataTransfer", async () => {
    disablePointerEventSupport();
    const { container } = await renderApp();
    await openLibraryPanel();
    mockRulerBounds(container);
    mockLaneBounds(container);
    mockTrackListBounds(container);

    const drumsRow = getTrackLaneRow(container, "Drums");
    expect(drumsRow).toBeTruthy();

    await act(async () => {
      fireEvent.mouseDown(getLibraryAssetButton("drums.wav"), {
        button: 0,
        clientX: 90,
        clientY: 210,
      });
      fireEvent.mouseMove(window, { clientX: 420, clientY: 160 });
      fireEvent.mouseUp(window, { clientX: 420, clientY: 160 });
    });

    expect(await screen.findByText(clipAddedMatcher("drums.wav"))).toBeTruthy();
    expect(screen.getByText(interpolate(en.timelineToolbar.clipsCount, { count: 5 }))).toBeTruthy();
  });

  it("updates the timeline preview during pointer drag and clears it when cancelled", async () => {
    disablePointerEventSupport();
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

    await act(async () => {
      fireEvent.mouseUp(window, { clientX: 420, clientY: 160 });
    });

    await waitFor(() => {
      expect(container.querySelector(".lt-library-clip-ghost")).toBeNull();
    });
  });

  it("drops multiple library assets with the vertical modifier and creates stacked tracks and clips", async () => {
    disablePointerEventSupport();
    const { container } = await renderApp();
    mockRulerBounds(container);
    mockLaneBounds(container);
    mockTrackListBounds(container);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: textMatcher(en.transport.shell.library) }));
    });

    await screen.findByText("drums.wav");

    await act(async () => {
      fireEvent.click(getLibraryAssetButton("drums.wav"));
      fireEvent.click(getLibraryAssetButton("bass.wav"), { ctrlKey: true });
    });

    const drumsRow = getTrackLaneRow(container, "Drums");
    expect(drumsRow).toBeTruthy();

    await act(async () => {
      fireEvent.mouseDown(getLibraryAssetButton("drums.wav"), {
        button: 0,
        clientX: 90,
        clientY: 210,
      });
      fireEvent.mouseMove(window, {
        clientX: 420,
        clientY: 160,
        ctrlKey: true,
      });
      fireEvent.mouseUp(window, {
        clientX: 420,
        clientY: 160,
        ctrlKey: true,
      });
    });

    expect(
      await screen.findByText(textMatcher(interpolate(en.transport.status.clipsAdded, { count: 2 }))),
    ).toBeTruthy();
    expect(await screen.findByText(interpolate(en.timelineToolbar.clipsCount, { count: 6 }))).toBeTruthy();
  });

  it("drops a song package on the timeline", async () => {
    const desktopApi = await import("../features/transport/desktopApi");
    const importSongPackageMock = vi.mocked(desktopApi.importSongPackage);
    const { container } = await renderApp();
    mockRulerBounds(container);
    mockLaneBounds(container);
    mockTrackListBounds(container);
    mockTimelinePaneBounds(container);

    await act(async () => {
      await emitNativeDropEvent({
        payload: {
          type: "over",
          paths: ["C:/mock/imports/session.ltpkg"],
          position: { x: 420, y: 180 },
        },
      });
      await emitNativeDropEvent({
        payload: {
          type: "drop",
          paths: ["C:/mock/imports/session.ltpkg"],
          position: { x: 420, y: 180 },
        },
      });
    });

    await waitFor(() => {
      expect(importSongPackageMock).toHaveBeenCalledWith("C:/mock/imports/session.ltpkg", expect.any(Number));
    });
    expect(await screen.findByText(/package imported at/i)).toBeTruthy();
    await waitFor(async () => {
      expect(await desktopApi.getLibraryAssets()).toEqual(
        expect.arrayContaining([expect.objectContaining({ fileName: "session-package.wav" })]),
      );
    });
  });

  it("drops audio files on the timeline, imports them, and creates one new track per file", async () => {
    const desktopApi = await import("../features/transport/desktopApi");
    const getWaveformSummariesMock = vi.mocked(desktopApi.getWaveformSummaries);
    const importAudioFilesFromPathsMock = vi.mocked(desktopApi.importAudioFilesFromPaths);
    let releaseImport: (() => void) | null = null;
    const importGate = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    importAudioFilesFromPathsMock.mockImplementationOnce(async (files) => {
      await importGate;
      return testDesktopApiMock.importAudioFilesFromPaths(files);
    });
    const { container } = await renderApp();
    await openLibraryPanel();
    mockRulerBounds(container);
    mockLaneBounds(container);
    mockTrackListBounds(container);
    mockTimelinePaneBounds(container);

    await act(async () => {
      await emitNativeDropEvent({
        payload: {
          type: "over",
          paths: ["C:/mock/imports/lead.wav", "C:/mock/imports/pad.mp3"],
          position: { x: 420, y: 180 },
        },
      });
      await emitNativeDropEvent({
        payload: {
          type: "drop",
          paths: ["C:/mock/imports/lead.wav", "C:/mock/imports/pad.mp3"],
          position: { x: 420, y: 180 },
        },
      });
    });

    await waitFor(() => {
      expect(useTransportStore.getState().pendingAudioImports).toHaveLength(2);
      expect(useTransportStore.getState().pendingAudioImports.map((item) => item.fileName)).toEqual([
        "lead.wav",
        "pad.mp3",
      ]);
    });
    await waitFor(() => {
      expect(importAudioFilesFromPathsMock).toHaveBeenCalledWith([
        { fileName: "lead.wav", sourcePath: "C:/mock/imports/lead.wav" },
        { fileName: "pad.mp3", sourcePath: "C:/mock/imports/pad.mp3" },
      ]);
    });

    await act(async () => {
      releaseImport?.();
    });

    expect(importAudioFilesFromPathsMock).toHaveBeenCalledTimes(1);
  });

  it("uses native file paths for external audio drops without reading file bytes", async () => {
    const desktopApi = await import("../features/transport/desktopApi");
    const importAudioFilesFromPathsMock = vi.mocked(desktopApi.importAudioFilesFromPaths);
    const importAudioFilesFromBytesMock = vi.mocked(desktopApi.importAudioFilesFromBytes);
    const arrayBufferSpy = vi.fn(async () => new ArrayBuffer(0));
    Object.defineProperty(File.prototype, "arrayBuffer", {
      configurable: true,
      value: arrayBufferSpy,
    });
    let releaseImport: (() => void) | null = null;
    const importGate = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    importAudioFilesFromPathsMock.mockImplementationOnce(async (files) => {
      await importGate;
      return testDesktopApiMock.importAudioFilesFromPaths(files);
    });

    const { container } = await renderApp();
    await openLibraryPanel();
    mockRulerBounds(container);
    mockLaneBounds(container);
    mockTrackListBounds(container);
    mockTimelinePaneBounds(container);

    await act(async () => {
      await emitNativeDropEvent({
        type: "wrong-top-level-type",
        paths: [],
        position: { x: 1, y: 1 },
        payload: {
          type: "over",
          paths: ["C:/mock/imports/lead.wav", "C:/mock/imports/pad.mp3"],
          position: { x: 420, y: 180 },
        },
      });
      await emitNativeDropEvent({
        type: "wrong-top-level-type",
        paths: [],
        position: { x: 1, y: 1 },
        payload: {
          type: "drop",
          paths: ["C:/mock/imports/lead.wav", "C:/mock/imports/pad.mp3"],
          position: { x: 420, y: 180 },
        },
      });
    });

    expect(screen.getAllByText("lead.wav").length).toBeGreaterThan(0);
    expect(screen.getAllByText("pad.mp3").length).toBeGreaterThan(0);
    expect(useTransportStore.getState().pendingAudioImports).toHaveLength(2);

    await waitFor(() => {
      expect(importAudioFilesFromPathsMock).toHaveBeenCalledWith([
        { fileName: "lead.wav", sourcePath: "C:/mock/imports/lead.wav" },
        { fileName: "pad.mp3", sourcePath: "C:/mock/imports/pad.mp3" },
      ]);
    });

    expect(importAudioFilesFromBytesMock).not.toHaveBeenCalled();
    expect(arrayBufferSpy).not.toHaveBeenCalled();

    await act(async () => {
      releaseImport?.();
    });

    expect(importAudioFilesFromBytesMock).not.toHaveBeenCalled();
    expect(importAudioFilesFromPathsMock).toHaveBeenCalledTimes(1);
  });

  it("uses native file paths for external audio drops when native coordinates are physical pixels", async () => {
    const desktopApi = await import("../features/transport/desktopApi");
    const importAudioFilesFromPathsMock = vi.mocked(desktopApi.importAudioFilesFromPaths);
    const originalDevicePixelRatio = window.devicePixelRatio;

    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 2,
    });

    const { container } = await renderApp();
    mockRulerBounds(container);
    mockLaneBounds(container);
    mockTrackListBounds(container);
    mockTimelinePaneBounds(container);

    try {
      await act(async () => {
        await emitNativeDropEvent({
          payload: {
            type: "over",
            paths: ["C:/mock/imports/lead.wav"],
            position: { x: 840, y: 360 },
          },
        });
      });

      expect(getExternalDropGuide(container)).toBeTruthy();

      await act(async () => {
        await emitNativeDropEvent({
          payload: {
            type: "drop",
            paths: ["C:/mock/imports/lead.wav"],
            position: { x: 840, y: 360 },
          },
        });
      });

      await waitFor(() => {
        expect(importAudioFilesFromPathsMock).toHaveBeenCalledWith([
          { fileName: "lead.wav", sourcePath: "C:/mock/imports/lead.wav" },
        ]);
      });
    } finally {
      Object.defineProperty(window, "devicePixelRatio", {
        configurable: true,
        value: originalDevicePixelRatio,
      });
    }
  });

  it("shows a native external drop guide when over events only provide position", async () => {
    const { container } = await renderApp();
    mockRulerBounds(container);
    mockLaneBounds(container);
    mockTrackListBounds(container);
    mockTimelinePaneBounds(container);

    await act(async () => {
      await emitNativeDropEvent({
        payload: {
          type: "over",
          position: { x: 420, y: 180 },
        },
      });
    });

    expect(screen.getByText("Drop")).toBeTruthy();
  });

  it("keeps native external drops aligned when the webview position is offset", async () => {
    const originalDevicePixelRatio = window.devicePixelRatio;
    const desktopApi = await import("../features/transport/desktopApi");
    const importAudioFilesFromPathsMock = vi.mocked(desktopApi.importAudioFilesFromPaths);
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 1,
    });

    try {
      setMockNativeWebviewPosition({ x: 300, y: 80 });
      const { container } = await renderApp();
      mockRulerBounds(container);
      mockLaneBounds(container);
      mockTrackListBounds(container);
      mockTimelinePaneBounds(container);

      await act(async () => {
        await Promise.resolve();
      });

      await act(async () => {
        await emitNativeDropEvent({
          payload: {
            type: "over",
            paths: ["C:/mock/imports/lead.wav"],
            position: { x: 420, y: 180 },
          },
        });
      });

      expect(getExternalDropGuide(container)).toBeTruthy();

      await act(async () => {
        await emitNativeDropEvent({
          payload: {
            type: "drop",
            paths: ["C:/mock/imports/lead.wav"],
            position: { x: 420, y: 180 },
          },
        });
      });

      await waitFor(() => {
        expect(importAudioFilesFromPathsMock).toHaveBeenCalledWith([
          { fileName: "lead.wav", sourcePath: "C:/mock/imports/lead.wav" },
        ]);
      });
    } finally {
      Object.defineProperty(window, "devicePixelRatio", {
        configurable: true,
        value: originalDevicePixelRatio,
      });
    }
  });

  it("marks pending external audio imports as failed when the import rejects", async () => {
    const desktopApi = await import("../features/transport/desktopApi");
    vi.mocked(desktopApi.importAudioFilesFromPaths).mockRejectedValueOnce(new Error("Import failed in test"));
    const { container } = await renderApp();
    mockRulerBounds(container);
    mockLaneBounds(container);
    mockTrackListBounds(container);
    mockTimelinePaneBounds(container);

    await act(async () => {
      await emitNativeDropEvent({
        payload: {
          type: "over",
          paths: ["C:/mock/imports/broken.wav"],
          position: { x: 420, y: 180 },
        },
      });
      await emitNativeDropEvent({
        payload: {
          type: "drop",
          paths: ["C:/mock/imports/broken.wav"],
          position: { x: 420, y: 180 },
        },
      });
    });

    await waitFor(() => {
      expect(
        useTransportStore.getState().pendingAudioImports.some(
          (item) => item.fileName === "broken.wav" && item.status === "failed",
        ),
      ).toBe(true);
    });
    expect(await screen.findByText(/Import failed in test/i)).toBeTruthy();
    expect(
      useTransportStore.getState().pendingAudioImports.some(
        (item) => item.fileName === "broken.wav" && item.status === "failed",
      ),
    ).toBe(true);
  });

  it("rejects mixed external drops", async () => {
    const { container } = await renderApp();
    mockRulerBounds(container);
    mockLaneBounds(container);
    mockTrackListBounds(container);
    mockTimelinePaneBounds(container);

    await act(async () => {
      await emitNativeDropEvent({
        payload: {
          type: "over",
          paths: ["C:/mock/imports/session.ltpkg", "C:/mock/imports/lead.wav"],
          position: { x: 420, y: 180 },
        },
      });
      await emitNativeDropEvent({
        payload: {
          type: "drop",
          paths: ["C:/mock/imports/session.ltpkg", "C:/mock/imports/lead.wav"],
          position: { x: 420, y: 180 },
        },
      });
    });

    expect(await screen.findByText(textMatcher(en.transport.status.externalDropMixed))).toBeTruthy();
  });

  it("rejects unsupported external drops", async () => {
    const { container } = await renderApp();
    mockRulerBounds(container);
    mockLaneBounds(container);
    mockTrackListBounds(container);
    mockTimelinePaneBounds(container);

    await act(async () => {
      await emitNativeDropEvent({
        payload: {
          type: "over",
          paths: ["C:/mock/imports/notes.txt"],
          position: { x: 420, y: 180 },
        },
      });
      await emitNativeDropEvent({
        payload: {
          type: "drop",
          paths: ["C:/mock/imports/notes.txt"],
          position: { x: 420, y: 180 },
        },
      });
    });

    expect(await screen.findByText(textMatcher(en.transport.status.externalDropUnsupported))).toBeTruthy();
  });

  it("clears native external drop preview and does not import outside the timeline", async () => {
    const desktopApi = await import("../features/transport/desktopApi");
    const importAudioFilesFromPathsMock = vi.mocked(desktopApi.importAudioFilesFromPaths);
    const importAudioFilesFromBytesMock = vi.mocked(desktopApi.importAudioFilesFromBytes);
    const { container } = await renderApp();
    mockRulerBounds(container);
    mockLaneBounds(container);
    mockTrackListBounds(container);
    mockTimelinePaneBounds(container);

    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => document.body),
    });

    await act(async () => {
      await emitNativeDropEvent({
        payload: {
          type: "over",
          paths: ["C:/mock/imports/lead.wav"],
          position: { x: 20, y: 20 },
        },
      });
    });

    expect(screen.queryByText("Audio")).toBeNull();

    await act(async () => {
      await emitNativeDropEvent({
        payload: {
          type: "drop",
          paths: ["C:/mock/imports/lead.wav"],
          position: { x: 20, y: 20 },
        },
      });
    });

    expect(importAudioFilesFromPathsMock).not.toHaveBeenCalled();
    expect(importAudioFilesFromBytesMock).not.toHaveBeenCalled();
  });

});
