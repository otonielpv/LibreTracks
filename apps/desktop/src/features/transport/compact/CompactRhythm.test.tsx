import { act, fireEvent, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useRhythmStore } from "../rhythm/rhythmStore";
import { CompactView } from "./CompactView";

/** Teléfono: el panel Ritmo y el mezclador se turnan (compartiendo la altura
 * no se podía usar ninguno de los dos). */

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  isMobileApp: true,
}));

vi.mock("../scenes/SceneMenuButton", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../scenes/SceneMenuButton")>()),
  usePhoneScreen: () => true,
}));

vi.mock("../rhythm/RhythmDock", () => ({
  RhythmDock: () => null,
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

const mixer = () => document.querySelector(".lt-compact-mixer");

describe("CompactView en el teléfono: ritmo y mezclador se turnan", () => {
  beforeEach(() => {
    window.localStorage.setItem("libretracks.compact.mixerVisible", "1");
  });

  it("abrir el ritmo oculta el mezclador sin tocar la preferencia guardada", () => {
    renderCompactView(vi.fn());
    expect(mixer()).not.toBeNull();
    act(() => useRhythmStore.getState().setOpen("compact", true));
    expect(mixer()).toBeNull();
    expect(document.querySelector(".lt-compact-mixer-toggle")?.getAttribute("aria-expanded")).toBe("false");
    expect(window.localStorage.getItem("libretracks.compact.mixerVisible")).toBe("1");
  });

  it("pedir el mezclador cierra el ritmo y lo vuelve a mostrar", () => {
    renderCompactView(vi.fn());
    act(() => useRhythmStore.getState().setOpen("compact", true));
    fireEvent.click(document.querySelector(".lt-compact-mixer-toggle")!);
    expect(useRhythmStore.getState().openByView.compact).toBe(false);
    expect(mixer()).not.toBeNull();
  });

  it("con el mezclador oculto por preferencia, el botón cierra el ritmo y lo abre", () => {
    window.localStorage.setItem("libretracks.compact.mixerVisible", "0");
    renderCompactView(vi.fn());
    act(() => useRhythmStore.getState().setOpen("compact", true));
    fireEvent.click(document.querySelector(".lt-compact-mixer-toggle")!);
    expect(useRhythmStore.getState().openByView.compact).toBe(false);
    expect(mixer()).not.toBeNull();
  });
});
