import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CompactView } from "./CompactView";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  isMobileApp: false,
}));

vi.mock("../store", () => ({
  useTransportStore: (selector: (state: { optimisticRegionMaster: object }) => unknown) =>
    selector({ optimisticRegionMaster: {} }),
}));

vi.mock("../tracks/TrackMeter", () => ({
  SongMasterMeter: () => null,
  TrackMeter: () => null,
}));

vi.mock("../structure/ArrangementBadge", () => ({
  ArrangementBadge: () => null,
}));

const region = {
  id: "song-1",
  name: "Cancion",
  startSeconds: 0,
  endSeconds: 60,
  transposeSemitones: 0,
  key: null,
  warpEnabled: false,
  warpSourceBpm: null,
  master: { gain: 1 },
  compactColumnWidthRem: null,
};
const secondRegion = { ...region, id: "song-2", name: "Otra" };

const clip = {
  id: "clip-1",
  clipName: "bateria.wav",
  trackId: "track-1",
  trackName: "Bateria",
};

function renderCompactView(
  onDeleteClip: () => void,
  regions = [region],
) {
  const props = {
    regions,
    tracks: [],
    activeRegionId: null,
    pendingRegionId: null,
    clipsByRegion: Object.fromEntries(
      regions.map((item) => [item.id, item.id === region.id ? [clip] : []]),
    ),
    audioRoutingOptions: [],
    mixerHandlers: {
      onToggleMute: vi.fn(),
      onToggleSolo: vi.fn(),
      onToggleTranspose: vi.fn(),
      onVolumeChange: vi.fn(),
      onCommitVolume: vi.fn(),
      onPanChange: vi.fn(),
      onCommitPan: vi.fn(),
      onAudioToChange: vi.fn(),
    },
    onTrackContextMenu: vi.fn(),
    selectedTrackIds: [],
    onTrackSelect: vi.fn(),
    onTrackDragStart: vi.fn(),
    selectedRegionId: null,
    onSelectRegion: vi.fn(),
    compactMixerFilterActiveSong: false,
    collapsedFolders: new Set<string>(),
    onToggleFolder: vi.fn(),
    onMasterGainChange: vi.fn(),
    onMasterGainCommit: vi.fn(),
    onDropOsFilesIntoSong: vi.fn(),
    onDropLibraryAssetsIntoSong: vi.fn(),
    onMoveClipToTrack: vi.fn(),
    onDeleteClip,
    onPlaySong: vi.fn(),
    onRenameSong: vi.fn(),
    onSetSongBpm: vi.fn(),
    onDeleteSong: vi.fn(),
    onExportSong: vi.fn(),
    onSongColumnWidthChange: vi.fn(),
    onReorderSong: vi.fn(),
    onSetSongKey: vi.fn(),
    bpmByRegion: {},
    onSnapshotApplied: vi.fn(),
    onImportSongPackageFromDialog: vi.fn(),
    onImportSongPackageFromOsFile: vi.fn(),
    dragPreview: null,
  } satisfies ComponentProps<typeof CompactView>;

  return render(<CompactView {...props} />);
}

function touchPointer(type: "pointerdown" | "pointerup", pointerId: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX: 24, clientY: 12 });
  Object.defineProperties(event, {
    pointerType: { value: "touch" },
    pointerId: { value: pointerId },
  });
  return event;
}

describe("CompactView touch context menu", () => {
  afterEach(() => vi.useRealTimers());

  it("opens a clip menu on long-press and keeps its actions clickable", () => {
    vi.useFakeTimers();
    const onDeleteClip = vi.fn();
    renderCompactView(onDeleteClip);
    const clipEntry = screen.getByText(clip.clipName).closest(".lt-compact-clip-entry");

    expect(clipEntry).not.toBeNull();
    fireEvent(clipEntry!, touchPointer("pointerdown", 12));
    act(() => vi.advanceTimersByTime(550));

    expect(screen.getByText("compactView.deleteClip")).toBeTruthy();
    fireEvent(clipEntry!, touchPointer("pointerup", 12));
    fireEvent.click(clipEntry!);
    fireEvent.click(screen.getByText("compactView.deleteClip"));

    expect(onDeleteClip).toHaveBeenCalledWith(clip.id);
  });

  it("places the resize grip in the gap after its song column", () => {
    renderCompactView(vi.fn());
    const resizeGrip = screen.getByRole("separator", {
      name: "Ancho de la columna Cancion",
    });
    const resizeSlot = resizeGrip.parentElement;

    expect(resizeSlot?.classList.contains("lt-compact-column-resize-slot")).toBe(true);
    expect(resizeSlot?.previousElementSibling?.classList.contains("lt-compact-song-column")).toBe(true);
    expect(resizeGrip.closest(".lt-compact-song-header")).toBeNull();
    expect(resizeGrip.querySelector(".lt-compact-column-resizer-icon")?.textContent)
      .toBe("width");
  });

  it("keeps reorder grips mounted while a column is being resized", () => {
    const { container } = renderCompactView(vi.fn(), [region, secondRegion]);
    const reorderGrips = () =>
      container.querySelectorAll(".lt-song-reorder-handle");
    expect(reorderGrips()).toHaveLength(2);

    fireEvent(
      screen.getByRole("separator", {
        name: "Ancho de la columna Cancion",
      }),
      touchPointer("pointerdown", 21),
    );

    expect(reorderGrips()).toHaveLength(2);
    fireEvent(window, touchPointer("pointerup", 21));
  });
});
describe("CompactView clip stacks far from the visible band", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("empties the stack of a column the observer reports off the band", () => {
    let report: ((entries: Array<{ target: Element; isIntersecting: boolean }>) => void) | null =
      null;
    const observed: Element[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: typeof report) {
          report = callback;
        }
        observe(element: Element) {
          observed.push(element);
        }
        disconnect() {}
      },
    );
    renderCompactView(vi.fn(), [region, secondRegion]);
    const column = (id: string) => observed.find((el) => (el as HTMLElement).dataset.regionId === id)!;

    // Before the first report every column is filled.
    expect(screen.queryByText(clip.clipName)).not.toBeNull();
    expect(observed).toHaveLength(2);

    act(() =>
      report!([
        { target: column(region.id), isIntersecting: false },
        { target: column(secondRegion.id), isIntersecting: true },
      ]),
    );
    expect(screen.queryByText(clip.clipName)).toBeNull();
    // Off the band is not "empty song": no drop hint either.
    expect(
      column(region.id).querySelector(".lt-compact-song-clip-stack-empty"),
    ).toBeNull();

    act(() => report!([{ target: column(region.id), isIntersecting: true }]));
    expect(screen.queryByText(clip.clipName)).not.toBeNull();
  });
});
