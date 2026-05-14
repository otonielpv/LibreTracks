import {
  act as rtlAct,
  cleanup,
  fireEvent as rtlFireEvent,
  render as rtlRender,
  screen as rtlScreen,
  waitFor as rtlWaitFor,
  within as rtlWithin,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "../shared/i18n";
import enMessages from "../shared/i18n/en";
import { useTransportStore as transportStore } from "../features/transport/store";
import {
  TIMELINE_DEFAULT_SNAP_ENABLED,
  TIMELINE_DEFAULT_TRACK_HEIGHT as defaultTrackHeight,
  TIMELINE_DEFAULT_ZOOM_LEVEL,
  useTimelineUIStore,
} from "../features/transport/uiStore";
import { App as AppComponent } from "../app/App";
import { emitWaveformReadyForTest, resetTestDesktopApiMock, testDesktopApiMock } from "../app/testDesktopApiMock";

export type MockWebviewDragDropEvent =
  | {
      payload:
        | { type: "over"; paths?: string[]; position: { x: number; y: number } }
        | { type: "drop"; paths: string[]; position: { x: number; y: number } }
        | { type: "cancel" };
      type?: "wrong-top-level-type";
      paths?: string[];
      position?: { x: number; y: number };
    };

let nativeDragDropHandler: ((event: MockWebviewDragDropEvent) => void) | null = null;
let mockNativeWebviewPosition = { x: 0, y: 0 };
export function setMockNativeWebviewPosition(position: { x: number; y: number }) {
  mockNativeWebviewPosition = position;
}
export const act = rtlAct;
export const fireEvent = rtlFireEvent;
export const render = rtlRender;
export const screen = rtlScreen;
export const waitFor = rtlWaitFor;
export const within = rtlWithin;
export const en = enMessages;
export const App = AppComponent;
export const TIMELINE_DEFAULT_TRACK_HEIGHT = defaultTrackHeight;
export const useTransportStore = transportStore;
const originalPointerEvent = window.PointerEvent;

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    position: async () => mockNativeWebviewPosition,
    onDragDropEvent: async (handler: (event: MockWebviewDragDropEvent) => void) => {
      nativeDragDropHandler = handler;
      return () => {
        if (nativeDragDropHandler === handler) {
          nativeDragDropHandler = null;
        }
      };
    },
  }),
}));

vi.mock("../features/transport/desktopApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../features/transport/desktopApi")>();
  const { testDesktopApiMock } = await import("../app/testDesktopApiMock");

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
    importAudioFilesFromPaths: vi.fn(testDesktopApiMock.importAudioFilesFromPaths),
    importAudioFilesFromBytes: vi.fn(testDesktopApiMock.importAudioFilesFromBytes),
    importSongPackage: vi.fn(testDesktopApiMock.importSongPackage),
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
    updateTrackMixRealtime: vi.fn(testDesktopApiMock.updateTrackMixRealtime),
    commitTrackMixChange: vi.fn(testDesktopApiMock.commitTrackMixChange),
    setMetronomeEnabledRealtime: vi.fn(testDesktopApiMock.setMetronomeEnabledRealtime),
    setMetronomeVolumeRealtime: vi.fn(testDesktopApiMock.setMetronomeVolumeRealtime),
    deleteTrack: vi.fn(testDesktopApiMock.deleteTrack),
  };
});

export function interpolate(template: string, values: Record<string, number | string>) {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, String(value)),
    template,
  );
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function textMatcher(text: string) {
  return new RegExp(escapeRegExp(text), "i");
}

export function clipAddedMatcher(name: string) {
  return textMatcher(interpolate(en.transport.status.clipAdded, { name }));
}

export function trackCreatedMatcher(name: string) {
  return textMatcher(interpolate(en.transport.status.trackCreated, { name }));
}

export function trackDeletedMatcher(name: string) {
  return textMatcher(interpolate(en.transport.status.trackDeleted, { name }));
}

export function jumpNextMarkerMatcher(name: string) {
  return textMatcher(interpolate(en.transport.status.jumpNextMarker, { name }));
}

export function pendingJumpMatcher(markerName: string, trigger: string) {
  return textMatcher(interpolate(en.transport.shell.pendingJump, { markerName, trigger }));
}

export async function chooseMarkerJumpMode(modeLabel: string) {
  const markerJumpSettings = await screen.findByRole("button", {
    name: textMatcher(`${en.timelineToolbar.markerJumpLabel} settings`),
  });
  await act(async () => {
    fireEvent.click(markerJumpSettings);
  });

  const modeButton = await screen.findByRole("button", { name: textMatcher(modeLabel) });
  await act(async () => {
    fireEvent.click(modeButton);
  });
}

export async function chooseSongJumpTrigger(triggerLabel: string) {
  const songSettings = await screen.findByRole("button", {
    name: textMatcher(`${en.timelineToolbar.songTransitionLabel} settings`),
  });
  await act(async () => {
    fireEvent.click(songSettings);
  });

  const triggerButton = await screen.findByRole("button", { name: textMatcher(triggerLabel) });
  await act(async () => {
    fireEvent.click(triggerButton);
  });
}

beforeEach(async () => {
  nativeDragDropHandler = null;
  mockNativeWebviewPosition = { x: 0, y: 0 };
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    value: originalPointerEvent,
  });
  resetTestDesktopApiMock();
  useTransportStore.setState({
    meters: {},
    playback: null,
    optimisticMix: {},
    pendingAudioImports: [],
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
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  cleanup();
});

export function disablePointerEventSupport() {
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    value: undefined,
  });
}

export async function emitNativeDropEvent(event: MockWebviewDragDropEvent) {
  await waitFor(() => {
    expect(nativeDragDropHandler).toBeTruthy();
  });

  await act(async () => {
    nativeDragDropHandler?.(event);
  });
}

export function getExternalDropGuide(container: HTMLElement) {
  return Array.from(container.querySelectorAll('[aria-hidden="true"]')).find(
    (element): element is HTMLElement =>
      element instanceof HTMLElement &&
      (element.style.width === "1px" || element.style.width === "2px"),
  ) ?? null;
}

export function getLibraryAssetRow(container: HTMLElement, fileName: string) {
  return Array.from(container.querySelectorAll(".lt-library-asset")).find(
    (element): element is HTMLElement => element instanceof HTMLElement && element.getAttribute("title") === fileName,
  ) ?? null;
}

export function createFileList(files: File[]) {
  return {
    item: (index: number) => files[index] ?? null,
    ...files,
  } as unknown as FileList;
}

export function createExternalFileDataTransfer(files: File[]) {
  return {
    dropEffect: "",
    effectAllowed: "",
    files: createFileList(files),
    types: ["Files"],
    getData: vi.fn(() => ""),
    setData: vi.fn(),
  };
}

export function createTestFile(fileName: string, bytes: number[], type = "application/octet-stream") {
  const file = new File([Uint8Array.from(bytes)], fileName, { type });
  Object.defineProperty(file, "arrayBuffer", {
    configurable: true,
    value: async () => Uint8Array.from(bytes).buffer,
  });
  return file;
}

export function attachNativePath(file: File, path: string) {
  Object.defineProperty(file, "path", {
    configurable: true,
    value: path,
  });
  return file as File & { path: string };
}

export async function renderApp() {
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

export async function openLibraryPanel() {
  const libraryButton = screen.getByRole("button", { name: textMatcher(en.transport.shell.library) });
  await act(async () => {
    fireEvent.click(libraryButton);
  });
  await screen.findByLabelText(textMatcher(en.library.panelAria));
}

export function mockRulerBounds(container: HTMLElement) {
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

export function mockTimelineShellMetrics(container: HTMLElement, width = 1400) {
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

export function mockLaneBounds(container: HTMLElement, width = 1140) {
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

export function mockTrackListBounds(container: HTMLElement, width = 1400, height = 500) {
  const trackList = container.querySelector(".lt-track-list") as HTMLDivElement | null;
  expect(trackList).toBeTruthy();
  const rows = Array.from(container.querySelectorAll(".lt-track-lane-row")) as HTMLDivElement[];
  const headerRows = Array.from(container.querySelectorAll(".lt-track-header-row")) as HTMLDivElement[];

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

export function mockTimelinePaneBounds(container: HTMLElement, width = 1400, height = 500) {
  const pane = container.querySelector(".lt-timeline-canvas-pane") as HTMLDivElement | null;
  expect(pane).toBeTruthy();

  Object.defineProperty(pane, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: 0,
      right: width,
      top: 0,
      bottom: height,
      width,
      height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
}

export function getTrackHeader(container: HTMLElement, trackName: string) {
  const header = Array.from(container.querySelectorAll(".lt-track-header")).find((candidate) =>
    candidate.textContent?.includes(trackName),
  );
  expect(header).toBeTruthy();
  return header as HTMLDivElement;
}

export function getTrackLaneRow(container: HTMLElement, trackName: string) {
  const headerRow = getTrackHeader(container, trackName).closest(".lt-track-header-row") as HTMLDivElement | null;
  expect(headerRow).toBeTruthy();

  const trackId = headerRow?.dataset.trackId ?? null;
  expect(trackId).toBeTruthy();

  const laneRow = container.querySelector(`.lt-track-lane-row[data-track-id="${trackId}"]`) as HTMLDivElement | null;
  expect(laneRow).toBeTruthy();
  return laneRow as HTMLDivElement;
}

export function getLibraryAssetButton(fileName: string) {
  const assetButton = document.querySelector(`.lt-library-asset[aria-label="${fileName}"]`);
  expect(assetButton).toBeTruthy();
  return assetButton as HTMLButtonElement;
}

export function mockTrackRowDragGeometry(container: HTMLElement) {
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


export { emitWaveformReadyForTest, testDesktopApiMock };
