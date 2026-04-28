import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "../shared/i18n";
import en from "../shared/i18n/en";
import { useTransportStore } from "../features/transport/store";
import {
  TIMELINE_DEFAULT_SNAP_ENABLED,
  TIMELINE_DEFAULT_TRACK_HEIGHT,
  TIMELINE_DEFAULT_ZOOM_LEVEL,
  useTimelineUIStore,
} from "../features/transport/uiStore";
import { App } from "./App";

vi.mock("../features/transport/desktopApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../features/transport/desktopApi")>();
  const { testDesktopApiMock } = await import("./testDesktopApiMock");

  return {
    ...actual,
    isTauriApp: true,
    listenToTransportLifecycle: vi.fn(testDesktopApiMock.listenToTransportLifecycle),
    listenToAudioMeters: vi.fn(testDesktopApiMock.listenToAudioMeters),
    listenToLibraryImportProgress: vi.fn(testDesktopApiMock.listenToLibraryImportProgress),
    listenToWaveformReady: vi.fn(testDesktopApiMock.listenToWaveformReady),
    listenToSettingsUpdated: vi.fn(testDesktopApiMock.listenToSettingsUpdated),
    listenToMidiRawMessage: vi.fn(testDesktopApiMock.listenToMidiRawMessage),
    getTransportSnapshot: vi.fn(testDesktopApiMock.getTransportSnapshot),
    getSongView: vi.fn(testDesktopApiMock.getSongView),
    getWaveformSummaries: vi.fn(testDesktopApiMock.getWaveformSummaries),
    getLibraryWaveformSummaries: vi.fn(testDesktopApiMock.getLibraryWaveformSummaries),
    getLibraryAssets: vi.fn(testDesktopApiMock.getLibraryAssets),
    getLibraryFolders: vi.fn(testDesktopApiMock.getLibraryFolders),
    getDesktopPerformanceSnapshot: vi.fn(testDesktopApiMock.getDesktopPerformanceSnapshot),
    getSettings: vi.fn(testDesktopApiMock.getSettings),
    saveSettings: vi.fn(testDesktopApiMock.saveSettings),
    updateAudioSettings: vi.fn(testDesktopApiMock.updateAudioSettings),
    getAudioOutputDevices: vi.fn(testDesktopApiMock.getAudioOutputDevices),
    getMidiInputs: vi.fn(testDesktopApiMock.getMidiInputs),
    reportUiRenderMetric: vi.fn(testDesktopApiMock.reportUiRenderMetric),
    createSong: vi.fn(testDesktopApiMock.createSong),
    saveProject: vi.fn(testDesktopApiMock.saveProject),
    saveProjectAs: vi.fn(testDesktopApiMock.saveProjectAs),
    undoAction: vi.fn(testDesktopApiMock.undoAction),
    redoAction: vi.fn(testDesktopApiMock.redoAction),
    updateSongTempo: vi.fn(testDesktopApiMock.updateSongTempo),
    upsertSongTempoMarker: vi.fn(testDesktopApiMock.upsertSongTempoMarker),
    deleteSongTempoMarker: vi.fn(testDesktopApiMock.deleteSongTempoMarker),
    openProject: vi.fn(testDesktopApiMock.openProject),
    pickAndImportSong: vi.fn(testDesktopApiMock.pickAndImportSong),
    importLibraryAssetsFromDialog: vi.fn(testDesktopApiMock.importLibraryAssetsFromDialog),
    deleteLibraryAsset: vi.fn(testDesktopApiMock.deleteLibraryAsset),
    moveLibraryAsset: vi.fn(testDesktopApiMock.moveLibraryAsset),
    createLibraryFolder: vi.fn(testDesktopApiMock.createLibraryFolder),
    renameLibraryFolder: vi.fn(testDesktopApiMock.renameLibraryFolder),
    deleteLibraryFolder: vi.fn(testDesktopApiMock.deleteLibraryFolder),
    playTransport: vi.fn(testDesktopApiMock.playTransport),
    pauseTransport: vi.fn(testDesktopApiMock.pauseTransport),
    stopTransport: vi.fn(testDesktopApiMock.stopTransport),
    seekTransport: vi.fn(testDesktopApiMock.seekTransport),
    scheduleMarkerJump: vi.fn(testDesktopApiMock.scheduleMarkerJump),
    scheduleRegionJump: vi.fn(testDesktopApiMock.scheduleRegionJump),
    cancelMarkerJump: vi.fn(testDesktopApiMock.cancelMarkerJump),
    moveClip: vi.fn(testDesktopApiMock.moveClip),
    moveClipLive: vi.fn(testDesktopApiMock.moveClipLive),
    deleteClip: vi.fn(testDesktopApiMock.deleteClip),
    updateClipWindow: vi.fn(testDesktopApiMock.updateClipWindow),
    duplicateClip: vi.fn(testDesktopApiMock.duplicateClip),
    splitClip: vi.fn(testDesktopApiMock.splitClip),
    createSongRegion: vi.fn(testDesktopApiMock.createSongRegion),
    updateSongRegion: vi.fn(testDesktopApiMock.updateSongRegion),
    deleteSongRegion: vi.fn(testDesktopApiMock.deleteSongRegion),
    createSectionMarker: vi.fn(testDesktopApiMock.createSectionMarker),
    updateSectionMarker: vi.fn(testDesktopApiMock.updateSectionMarker),
    deleteSectionMarker: vi.fn(testDesktopApiMock.deleteSectionMarker),
    assignSectionMarkerDigit: vi.fn(testDesktopApiMock.assignSectionMarkerDigit),
    createTrack: vi.fn(testDesktopApiMock.createTrack),
    createClip: vi.fn(testDesktopApiMock.createClip),
    createClipsBatch: vi.fn(testDesktopApiMock.createClipsBatch),
    moveTrack: vi.fn(testDesktopApiMock.moveTrack),
    updateTrack: vi.fn(testDesktopApiMock.updateTrack),
    updateTrackMixLive: vi.fn(testDesktopApiMock.updateTrackMixLive),
    deleteTrack: vi.fn(testDesktopApiMock.deleteTrack),
  };
});

function interpolate(template: string, values: Record<string, number | string>) {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, String(value)),
    template,
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textMatcher(text: string) {
  return new RegExp(escapeRegExp(text), "i");
}

function clipAddedMatcher(name: string) {
  return textMatcher(interpolate(en.transport.status.clipAdded, { name }));
}

function trackCreatedMatcher(name: string) {
  return textMatcher(interpolate(en.transport.status.trackCreated, { name }));
}

function trackDeletedMatcher(name: string) {
  return textMatcher(interpolate(en.transport.status.trackDeleted, { name }));
}

function jumpNextMarkerMatcher(name: string) {
  return textMatcher(interpolate(en.transport.status.jumpNextMarker, { name }));
}

function pendingJumpMatcher(markerName: string, trigger: string) {
  return textMatcher(interpolate(en.transport.shell.pendingJump, { markerName, trigger }));
}

beforeEach(async () => {
  const { resetTestDesktopApiMock } = await import("./testDesktopApiMock");
  resetTestDesktopApiMock();
  useTransportStore.setState({
    meters: {},
    playback: null,
    optimisticMix: {},
  });
  useTimelineUIStore.setState({
    cameraX: 0,
    zoomLevel: TIMELINE_DEFAULT_ZOOM_LEVEL,
    trackHeight: TIMELINE_DEFAULT_TRACK_HEIGHT,
    selectedTrackIds: [],
    selectedClipId: null,
    selectedSectionId: null,
    snapEnabled: TIMELINE_DEFAULT_SNAP_ENABLED,
    midiLearnMode: null,
  });
  vi.clearAllMocks();
  vi.restoreAllMocks();
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
});

const LIBRARY_ASSET_DRAG_MIME = "application/libretracks-library-assets";

async function renderApp() {
  const view = render(<App />);
  await screen.findByText(textMatcher(en.transport.status.readyDesktop));
  await waitFor(() => {
    expect(
      document.querySelector(".lt-track-lane-row") ??
      screen.queryByLabelText(textMatcher(en.transport.shell.emptyArrangementDropzone)),
    ).toBeTruthy();
  });
  return view;
}

function mockRulerBounds(container: HTMLElement) {
  const rulerTrack = container.querySelector(".lt-ruler-track") as HTMLDivElement | null;
  expect(rulerTrack).toBeTruthy();

  Object.defineProperty(rulerTrack, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: 0,
      right: 1200,
      top: 0,
      bottom: 86,
      width: 1200,
      height: 86,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
}

function mockTimelineShellMetrics(container: HTMLElement, width = 1400) {
  const shell = container.querySelector(".lt-timeline-shell") as HTMLDivElement | null;
  expect(shell).toBeTruthy();

  Object.defineProperty(shell, "clientWidth", {
    configurable: true,
    value: width,
  });

  Object.defineProperty(shell, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: 0,
      right: width,
      top: 0,
      bottom: 500,
      width,
      height: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });

  Object.defineProperty(shell, "scrollLeft", {
    configurable: true,
    writable: true,
    value: 0,
  });

  return shell as HTMLDivElement;
}

function mockLaneBounds(container: HTMLElement, width = 1140) {
  const lanes = Array.from(container.querySelectorAll(".lt-track-lane")) as HTMLDivElement[];
  expect(lanes.length).toBeGreaterThan(0);

  lanes.forEach((lane, index) => {
    const top = 120 + index * 84;
    Object.defineProperty(lane, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 260,
        right: 260 + width,
        top,
        bottom: top + 78,
        width,
        height: 78,
        x: 260,
        y: top,
        toJSON: () => ({}),
      }),
    });
  });
}

function mockTrackListBounds(container: HTMLElement, width = 1400, height = 500) {
  const trackList = container.querySelector(".lt-track-list") as HTMLDivElement | null;
  expect(trackList).toBeTruthy();

  Object.defineProperty(trackList, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: 0,
      right: width,
      top: 64,
      bottom: 64 + height,
      width,
      height,
      x: 0,
      y: 64,
      toJSON: () => ({}),
    }),
  });

  Object.defineProperty(trackList, "scrollTop", {
    configurable: true,
    writable: true,
    value: 0,
  });
}

function getTrackHeader(container: HTMLElement, trackName: string) {
  const header = Array.from(container.querySelectorAll(".lt-track-header")).find((candidate) =>
    candidate.textContent?.includes(trackName),
  );
  expect(header).toBeTruthy();
  return header as HTMLDivElement;
}

function getTrackLaneRow(container: HTMLElement, trackName: string) {
  const headerRow = getTrackHeader(container, trackName).closest(".lt-track-header-row") as HTMLDivElement | null;
  expect(headerRow).toBeTruthy();

  const trackId = headerRow?.dataset.trackId ?? null;
  expect(trackId).toBeTruthy();

  const laneRow = container.querySelector(`.lt-track-lane-row[data-track-id="${trackId}"]`) as HTMLDivElement | null;
  expect(laneRow).toBeTruthy();
  return laneRow as HTMLDivElement;
}

function getLibraryAssetButton(fileName: string) {
  const assetButton = document.querySelector(`.lt-library-asset[aria-label="${fileName}"]`);
  expect(assetButton).toBeTruthy();
  return assetButton as HTMLButtonElement;
}

function mockTrackRowDragGeometry(container: HTMLElement) {
  const rows = Array.from(container.querySelectorAll(".lt-track-lane-row")) as HTMLDivElement[];
  const headerRows = Array.from(container.querySelectorAll(".lt-track-header-row")) as HTMLDivElement[];
  expect(rows.length).toBeGreaterThan(0);
  expect(headerRows.length).toBeGreaterThan(0);

  rows.forEach((row, index) => {
    const top = 120 + index * 84;
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0,
        right: 1400,
        top,
        bottom: top + 78,
        width: 1400,
        height: 78,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }),
    });
  });

  headerRows.forEach((row, index) => {
    const top = 120 + index * 84;
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0,
        right: 260,
        top,
        bottom: top + 78,
        width: 260,
        height: 78,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }),
    });
  });

  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn((x: number, y: number) => {
      const rowIndex = rows.findIndex((_, index) => {
        const top = 120 + index * 84;
        return y >= top && y <= top + 78;
      });

      if (rowIndex < 0) {
        return null;
      }

      return x < 260 ? headerRows[rowIndex] ?? rows[rowIndex] ?? null : rows[rowIndex] ?? headerRows[rowIndex] ?? null;
    }),
  });
}

describe("App", () => {
  it("renders the timeline-centric DAW shell", async () => {
    const { container } = await renderApp();

    expect(screen.getByText("LIBRETRACKS")).toBeTruthy();
    expect(screen.getByRole("button", { name: textMatcher(en.timelineTopbar.play) })).toBeTruthy();
    expect(screen.getByRole("button", { name: textMatcher(en.timelineTopbar.pause) })).toBeTruthy();
    expect(screen.getByRole("button", { name: textMatcher(en.timelineTopbar.stop) })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /browser/i })).toBeNull();
    expect(screen.queryByLabelText(textMatcher(en.library.panelAria))).toBeNull();
    expect(container.querySelector(".lt-ruler-canvas-layer")).toBeTruthy();
  });

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

  it("shows library assets and exposes the drag payload for timeline drops", async () => {
    await renderApp();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: textMatcher(en.transport.shell.library) }));
    });

    expect(screen.getByText("drums.wav")).toBeTruthy();
    expect(screen.getByText("bass.wav")).toBeTruthy();

    const transferData = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "",
      setData: vi.fn((type: string, value: string) => {
        transferData.set(type, value);
      }),
      getData: vi.fn((type: string) => transferData.get(type) ?? ""),
    };

    await act(async () => {
      fireEvent.dragStart(getLibraryAssetButton("drums.wav"), { dataTransfer });
    });

    expect(dataTransfer.effectAllowed).toBe("copyMove");
    expect(dataTransfer.setData).toHaveBeenCalledTimes(2);
    expect(JSON.parse(transferData.get(LIBRARY_ASSET_DRAG_MIME) ?? "[]")).toEqual([
      {
        file_path: "audio/drums.wav",
        durationSeconds: 180,
      },
    ]);
  });

  it("emits a multi-asset drag payload from the current library selection", async () => {
    await renderApp();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /library/i }));
    });

    await act(async () => {
      fireEvent.click(getLibraryAssetButton("drums.wav"));
      fireEvent.click(getLibraryAssetButton("bass.wav"), { ctrlKey: true });
    });

    expect(screen.getByText("2 selected")).toBeTruthy();

    const transferData = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "",
      setData: vi.fn((type: string, value: string) => {
        transferData.set(type, value);
      }),
    };

    await act(async () => {
      fireEvent.dragStart(getLibraryAssetButton("drums.wav"), { dataTransfer });
    });

    expect(dataTransfer.effectAllowed).toBe("copyMove");
    expect(JSON.parse(transferData.get(LIBRARY_ASSET_DRAG_MIME) ?? "[]")).toEqual([
      {
        file_path: "audio/bass.wav",
        durationSeconds: 164,
      },
      {
        file_path: "audio/drums.wav",
        durationSeconds: 180,
      },
    ]);
  });

  it("drops a library asset onto a track lane and creates a new clip", async () => {
    const { container } = await renderApp();
    mockRulerBounds(container);
    mockLaneBounds(container);
    mockTrackListBounds(container);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /library/i }));
    });

    const transferData = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: vi.fn((type: string, value: string) => {
        transferData.set(type, value);
      }),
      getData: vi.fn((type: string) => transferData.get(type) ?? ""),
    };

    await act(async () => {
      fireEvent.dragStart(getLibraryAssetButton("drums.wav"), { dataTransfer });
    });

    const drumsRow = getTrackLaneRow(container, "Drums");
    expect(drumsRow).toBeTruthy();
    const drumsLane = drumsRow?.querySelector(".lt-track-lane") as HTMLElement | null;
    expect(drumsLane).toBeTruthy();

    await act(async () => {
      fireEvent.dragOver(drumsLane as HTMLElement, { dataTransfer, clientX: 420, clientY: 160 });
      fireEvent.drop(drumsLane as HTMLElement, { dataTransfer, clientX: 420, clientY: 160 });
    });

    expect(await screen.findByText(clipAddedMatcher("drums.wav"))).toBeTruthy();
    expect(screen.getByText(interpolate(en.timelineToolbar.clipsCount, { count: 5 }))).toBeTruthy();
  });

  it("accepts library drags when the browser exposes only MIME types during hover", async () => {
    const { container } = await renderApp();
    mockRulerBounds(container);
    mockLaneBounds(container);
    mockTrackListBounds(container);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: textMatcher(en.transport.shell.library) }));
    });

    const transferData = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      types: [LIBRARY_ASSET_DRAG_MIME],
      setData: vi.fn((type: string, value: string) => {
        transferData.set(type, value);
      }),
      getData: vi.fn(() => ""),
    };

    await act(async () => {
      fireEvent.dragStart(getLibraryAssetButton("drums.wav"), { dataTransfer });
    });

    const drumsRow = getTrackLaneRow(container, "Drums");
    expect(drumsRow).toBeTruthy();
    const drumsLane = drumsRow?.querySelector(".lt-track-lane") as HTMLElement | null;
    expect(drumsLane).toBeTruthy();

    await act(async () => {
      fireEvent.dragOver(drumsLane as HTMLElement, { dataTransfer, clientX: 420, clientY: 160 });
      fireEvent.drop(drumsLane as HTMLElement, { dataTransfer, clientX: 420, clientY: 160 });
    });

    expect(await screen.findByText(clipAddedMatcher("drums.wav"))).toBeTruthy();
    expect(screen.getByText(interpolate(en.timelineToolbar.clipsCount, { count: 5 }))).toBeTruthy();
  });

  it("accepts library drags when the runtime exposes only text/plain during hover", async () => {
    const { container } = await renderApp();
    mockRulerBounds(container);
    mockLaneBounds(container);
    mockTrackListBounds(container);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: textMatcher(en.transport.shell.library) }));
    });

    const transferData = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      types: ["text/plain"],
      setData: vi.fn((type: string, value: string) => {
        transferData.set(type, value);
      }),
      getData: vi.fn((type: string) => (type === "text/plain" ? transferData.get(type) ?? "" : "")),
    };

    await act(async () => {
      fireEvent.dragStart(getLibraryAssetButton("drums.wav"), { dataTransfer });
    });

    const drumsRow = getTrackLaneRow(container, "Drums");
    expect(drumsRow).toBeTruthy();
    const drumsLane = drumsRow?.querySelector(".lt-track-lane") as HTMLElement | null;
    expect(drumsLane).toBeTruthy();

    await act(async () => {
      fireEvent.dragOver(drumsLane as HTMLElement, { dataTransfer, clientX: 420, clientY: 160 });
      fireEvent.drop(drumsLane as HTMLElement, { dataTransfer, clientX: 420, clientY: 160 });
    });

    expect(await screen.findByText(clipAddedMatcher("drums.wav"))).toBeTruthy();
    expect(screen.getByText(interpolate(en.timelineToolbar.clipsCount, { count: 5 }))).toBeTruthy();
  });

  it("accepts library drags when the runtime strips both payload and MIME types during hover", async () => {
    const { container } = await renderApp();
    mockRulerBounds(container);
    mockLaneBounds(container);
    mockTrackListBounds(container);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: textMatcher(en.transport.shell.library) }));
    });

    const dragStartTransfer = {
      effectAllowed: "",
      setData: vi.fn(),
    };

    await act(async () => {
      fireEvent.dragStart(getLibraryAssetButton("drums.wav"), { dataTransfer: dragStartTransfer });
    });

    const hoverTransfer = {
      dropEffect: "",
      getData: vi.fn(() => ""),
      types: [],
    };

    const drumsRow = getTrackLaneRow(container, "Drums");
    expect(drumsRow).toBeTruthy();
    const drumsLane = drumsRow?.querySelector(".lt-track-lane") as HTMLElement | null;
    expect(drumsLane).toBeTruthy();

    await act(async () => {
      fireEvent.dragOver(drumsLane as HTMLElement, { dataTransfer: hoverTransfer, clientX: 420, clientY: 160 });
      fireEvent.drop(drumsLane as HTMLElement, { dataTransfer: hoverTransfer, clientX: 420, clientY: 160 });
    });

    expect(await screen.findByText(clipAddedMatcher("drums.wav"))).toBeTruthy();
    expect(screen.getByText(interpolate(en.timelineToolbar.clipsCount, { count: 5 }))).toBeTruthy();
  });

  it("clears stale library clip ghosts after deleting a track", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { container } = await renderApp();
    mockRulerBounds(container);
    mockLaneBounds(container);
    mockTrackListBounds(container);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: textMatcher(en.transport.shell.library) }));
    });

    const transferData = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: vi.fn((type: string, value: string) => {
        transferData.set(type, value);
      }),
      getData: vi.fn((type: string) => transferData.get(type) ?? ""),
    };

    await act(async () => {
      fireEvent.dragStart(getLibraryAssetButton("drums.wav"), { dataTransfer });
    });

    const drumsRow = getTrackLaneRow(container, "Drums");
    expect(drumsRow).toBeTruthy();
    const drumsLane = drumsRow?.querySelector(".lt-track-lane") as HTMLElement | null;
    expect(drumsLane).toBeTruthy();

    await act(async () => {
      fireEvent.dragOver(drumsLane as HTMLElement, { dataTransfer, clientX: 420, clientY: 160 });
    });

    expect(container.querySelectorAll(".lt-library-clip-ghost").length).toBeGreaterThan(0);

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
    expect(container.querySelector(".lt-library-clip-ghost")).toBeNull();
  });

  it("drops multiple library assets with the vertical modifier and creates stacked tracks and clips", async () => {
    const { container } = await renderApp();
    mockRulerBounds(container);
    mockLaneBounds(container);
    mockTrackListBounds(container);

    const transferData = new Map<string, string>();
    transferData.set(
      LIBRARY_ASSET_DRAG_MIME,
      JSON.stringify([
        {
          file_path: "audio/drums.wav",
          durationSeconds: 180,
        },
        {
          file_path: "audio/bass.wav",
          durationSeconds: 160,
        },
      ]),
    );

    const dataTransfer = {
      dropEffect: "",
      getData: vi.fn((type: string) => transferData.get(type) ?? ""),
    };

    const drumsRow = getTrackLaneRow(container, "Drums");
    expect(drumsRow).toBeTruthy();
    const drumsLane = drumsRow?.querySelector(".lt-track-lane") as HTMLElement | null;
    expect(drumsLane).toBeTruthy();

    await act(async () => {
      fireEvent.dragOver(drumsLane as HTMLElement, {
        dataTransfer,
        clientX: 420,
        clientY: 160,
        ctrlKey: true,
      });
      fireEvent.drop(drumsLane as HTMLElement, {
        dataTransfer,
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
    expect(screen.getByLabelText(textMatcher(en.transport.shell.emptyArrangementDropzone))).toBeTruthy();
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

  it("shows the marker context menu on right click", async () => {
    await renderApp();

    const introSection = await screen.findByRole("button", { name: "Intro" });
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

    const nextMarkerButton = await screen.findByRole("button", {
      name: textMatcher(en.transport.jumpMode.nextMarker),
    });
    await act(async () => {
      fireEvent.click(nextMarkerButton);
    });

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

    const nextMarkerButton = await screen.findByRole("button", {
      name: textMatcher(en.transport.jumpMode.nextMarker),
    });
    await act(async () => {
      fireEvent.click(nextMarkerButton);
    });

    await act(async () => {
      fireEvent.keyDown(window, { code: "Numpad0", key: "0" });
    });

    expect(await screen.findByText(jumpNextMarkerMatcher("Intro"))).toBeTruthy();
  });

  it("maps shift plus 0 to the first song region", async () => {
    await renderApp();

    const regionEndButton = await screen.findByRole("button", {
      name: textMatcher(en.transport.jumpMode.regionEnd),
    });
    await act(async () => {
      fireEvent.click(regionEndButton);
    });

    await act(async () => {
      fireEvent.keyDown(window, { code: "Digit0", key: "0", shiftKey: true });
    });

    await waitFor(() => {
      expect(useTransportStore.getState().playback?.pendingMarkerJump?.targetMarkerName).toBe("LibreTracks Session");
      expect(useTransportStore.getState().playback?.pendingMarkerJump?.trigger).toBe("region_end");
    });
  });

  it("overwrites the armed marker on click and cancels when clicked again", async () => {
    await renderApp();

    const nextMarkerButton = await screen.findByRole("button", {
      name: textMatcher(en.transport.jumpMode.nextMarker),
    });
    await act(async () => {
      fireEvent.click(nextMarkerButton);
    });

    const introMarker = await screen.findByRole("button", { name: "Intro" });
    const bridgeMarker = await screen.findByRole("button", { name: "Bridge" });

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

    const nextMarkerButton = await screen.findByRole("button", {
      name: textMatcher(en.transport.jumpMode.nextMarker),
    });
    await act(async () => {
      fireEvent.click(nextMarkerButton);
    });

    const introMarker = await screen.findByRole("button", { name: "Intro" });
    await act(async () => {
      fireEvent.click(introMarker);
    });

    expect(await screen.findByText(textMatcher(en.transport.status.noMarkersAhead))).toBeTruthy();
    expect(screen.queryByText(textMatcher(en.transport.shell.pendingJump.split("{{markerName}}")[0].trim()))).toBeNull();
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
    expect((firstHeader as HTMLElement).style.height).toBe("94px");
    expect((firstLane as HTMLElement).style.height).toBe("94px");

    await act(async () => {
      fireEvent.wheel(firstHeader as HTMLElement, { deltaY: -100, ctrlKey: true });
    });

    expect((firstHeader as HTMLElement).style.height).toBe("102px");
    expect((firstLane as HTMLElement).style.height).toBe("102px");
  });

  it("resizes track rows with ctrl plus wheel over the native timeline lane surface", async () => {
    const { container } = await renderApp();
    mockTimelineShellMetrics(container, 1500);

    const firstHeader = container.querySelector(".lt-track-header") as HTMLElement | null;
    const trackList = container.querySelector(".lt-track-list") as HTMLElement | null;
    expect(firstHeader).toBeTruthy();
    expect(trackList).toBeTruthy();
    expect((firstHeader as HTMLElement).style.height).toBe("94px");

    await act(async () => {
      fireEvent.wheel(trackList as HTMLElement, { deltaY: -100, ctrlKey: true });
    });

    expect((firstHeader as HTMLElement).style.height).toBe("102px");
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
