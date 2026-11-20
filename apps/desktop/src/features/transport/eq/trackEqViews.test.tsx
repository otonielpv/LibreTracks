// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SongView, TrackEq, TrackSummary } from "@libretracks/shared/models";

import i18n from "../../../shared/i18n";

const platform = vi.hoisted(() => ({ mobile: false }));
const api = vi.hoisted(() => ({
  commitTrackEqChange: vi.fn(async (_args: { trackId: string; eq: unknown }) => ({ projectRevision: 9 })),
  updateTrackEqRealtime: vi.fn(async (_args: { trackId: string; eq: unknown }) => undefined),
  commitTrackEqsChange: vi.fn(async (_args: { changes: { trackId: string; eq: unknown }[] }) => ({
    projectRevision: 10,
  })),
}));

vi.mock("../desktopApi", async (original) => ({
  ...(await original<object>()),
  get isMobileApp() {
    return platform.mobile;
  },
  commitTrackEqChange: api.commitTrackEqChange,
  updateTrackEqRealtime: api.updateTrackEqRealtime,
  commitTrackEqsChange: api.commitTrackEqsChange,
  getPadsCatalog: vi.fn(async () => ({ offline: false, pads: [] })),
}));

vi.mock("../tracks/TrackMeter", () => ({
  SongMasterMeter: () => null,
  TrackMeter: () => null,
}));

vi.mock("../structure/ArrangementBadge", () => ({
  ArrangementBadge: () => null,
}));

import { CompactMixer } from "../compact/CompactMixer";
import { MobileSelectionActionBar } from "../mobile/MobileSelectionActionBar";
import { SetlistView } from "../setlist/SetlistView";
import { testRegion, testSetlistProps } from "../setlist/testBindings";
import { setSong } from "../songStore";
import { TrackHeaderItem } from "../tracks/TrackHeaderItem";
import { useTimelineUIStore } from "../uiStore";
import { TrackEqEditorHost } from "./TrackEqEditorHost";
import { defaultTrackEq } from "@libretracks/shared/eq/trackEqModel";
import { useTrackEqStore } from "./trackEqStore";

const activeEq = (): TrackEq => {
  const eq = defaultTrackEq();
  eq.bands[2].gainDb = 4;
  return eq;
};

const base = {
  depth: 0,
  hasChildren: false,
  volume: 1,
  pan: 0,
  muted: false,
  solo: false,
  audioTo: "master",
  transposeEnabled: true,
  color: null,
  parentTrackId: null,
};
const TRACKS = [
  { ...base, id: "voz", name: "Voz", kind: "audio", eq: null },
  { ...base, id: "bajo", name: "Bajo", kind: "audio", eq: activeEq() },
  { ...base, id: "banda", name: "Banda", kind: "folder" },
  { ...base, id: "luces", name: "Luces", kind: "midi" },
  { ...base, id: "clip", name: "Clip", kind: "video" },
] as unknown as TrackSummary[];

function loadSong(tracks: TrackSummary[] = TRACKS) {
  act(() =>
    setSong({
      id: "s",
      title: "S",
      bpm: 120,
      timeSignature: "4/4",
      durationSeconds: 100,
      regions: [],
      sectionMarkers: [],
      tempoMarkers: [],
      timeSignatureMarkers: [],
      clips: [],
      tracks,
      projectRevision: 1,
    } as unknown as SongView),
  );
}

const eqButton = (name: string) => screen.queryByRole("button", { name: `Ecualizador de ${name}` });

function renderHeader(track: TrackSummary) {
  render(
    <TrackHeaderItem
      trackId={track.id}
      trackName={track.name}
      trackKind={track.kind}
      hasParent={false}
      trackDepth={0}
      childCount={0}
      trackHeight={80}
      panValue={0}
      trackMuted={false}
      trackSolo={false}
      trackTransposeEnabled
      trackChannelMode="stereo"
      volumeValue={1}
      audioTo="master"
      audioRoutingOptions={[{ value: "master", label: "Master" }]}
      isCollapsed={false}
      isSelected={false}
      isDropTarget={false}
      dropMode={null}
      isDragging={false}
      densityClass=""
      onSelectTrack={vi.fn()}
      onOpenContextMenu={vi.fn()}
      onStartTrackDrag={vi.fn()}
      onToggleFolder={vi.fn()}
      onToggleMute={vi.fn()}
      onToggleSolo={vi.fn()}
      onToggleTranspose={vi.fn()}
      onVolumeChange={vi.fn()}
      onCommitVolume={vi.fn()}
      onPanChange={vi.fn()}
      onCommitPan={vi.fn()}
      onAudioToChange={vi.fn()}
    />,
  );
}

function renderCompact(tracks: TrackSummary[] = TRACKS) {
  render(
    <CompactMixer
      tracks={tracks}
      audioRoutingOptions={[{ value: "master", label: "Master" }]}
      handlers={{
        onToggleMute: vi.fn(),
        onToggleSolo: vi.fn(),
        onToggleTranspose: vi.fn(),
        onVolumeChange: vi.fn(),
        onCommitVolume: vi.fn(),
        onPanChange: vi.fn(),
        onCommitPan: vi.fn(),
        onAudioToChange: vi.fn(),
      }}
      onTrackContextMenu={vi.fn()}
      selectedTrackIds={[]}
      onTrackSelect={vi.fn()}
      onTrackDragStart={vi.fn()}
      activeSongTrackIds={null}
      filterActiveSong={false}
      collapsedFolders={new Set()}
      onToggleFolder={vi.fn()}
    />,
  );
}

function renderMobileBar(trackIds: string[]) {
  act(() => useTimelineUIStore.getState().selectTrack(trackIds));
  render(
    <MobileSelectionActionBar
      song={{ tracks: TRACKS, clips: [], sectionMarkers: [], regions: [] } as unknown as SongView}
      selectedRegionId={null}
      menus={{
        clipContextMenu: () => [],
        sectionContextMenu: () => [],
        tempoMarkerContextMenu: () => [],
        timeSignatureMarkerContextMenu: () => [],
        songRegionContextMenu: () => [],
        trackContextMenu: () => [{ label: "Renombrar", onSelect: vi.fn() }],
        multiTrackContextMenu: () => [{ label: "Eliminar", onSelect: vi.fn() }],
        automationTrackContextMenu: () => [],
      }}
      creation={{
        onCreateSection: vi.fn(),
        onCreateCue: vi.fn(),
        onAddAudios: vi.fn(),
        onCreateTempoMarker: vi.fn(),
        onCreateTimeSignatureMarker: vi.fn(),
      }}
      onOpenSheet={vi.fn()}
      onClearSelection={vi.fn()}
      mix={{
        setVolume: vi.fn(),
        commitVolume: vi.fn(),
        setPan: vi.fn(),
        commitPan: vi.fn(),
        setAudioTo: vi.fn(),
        toggleTranspose: vi.fn(),
      }}
      audioRoutingOptions={[{ value: "master", label: "Master" }]}
    />,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("es");
  platform.mobile = false;
  vi.clearAllMocks();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
  useTrackEqStore.setState({ openTrackId: null, targetTrackIds: [] });
  useTimelineUIStore.getState().clearSelection();
  useTimelineUIStore.setState({ expandedTrackId: null, areaSelectMode: false });
  loadSong();
});

afterEach(cleanup);

describe("EQ button in the DAW header", () => {
  it("shows on audio tracks only and opens that track's editor", () => {
    for (const track of TRACKS) {
      renderHeader(track);
      const button = eqButton(track.name);
      expect(Boolean(button)).toBe(track.kind === "audio");
      if (button) {
        fireEvent.click(button);
        expect(useTrackEqStore.getState().openTrackId).toBe(track.id);
      }
      cleanup();
    }
  });

  it("is lit when the eq is on and a band does something", () => {
    renderHeader(TRACKS[0]);
    renderHeader(TRACKS[1]);
    expect(eqButton("Voz")!.getAttribute("aria-pressed")).toBe("false");
    expect(eqButton("Bajo")!.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("EQ button in the Compact mixer", () => {
  it("shows on audio strips only, opens the editor and lights from the model", () => {
    renderCompact();
    expect(eqButton("Voz")).toBeTruthy();
    expect(eqButton("Banda")).toBeNull();
    expect(eqButton("Luces")).toBeNull();
    expect(eqButton("Clip")).toBeNull();
    expect(eqButton("Bajo")!.className).toContain("is-active");
    expect(eqButton("Voz")!.className).not.toContain("is-active");
    fireEvent.click(eqButton("Voz")!);
    expect(useTrackEqStore.getState().openTrackId).toBe("voz");
  });
});

describe("EQ button in the Setlist mixer", () => {
  it("is the same strip button: audio only, lit from the model, opens the editor", () => {
    const audio = TRACKS.slice(0, 3);
    const parts = {
      tracks: audio,
      regions: [testRegion("a", { name: "Alfa", startSeconds: 0, endSeconds: 100 })],
      clips: ["voz", "bajo"].map((trackId) => ({
        id: `c-${trackId}`,
        trackId,
        timelineStartSeconds: 0,
        durationSeconds: 50,
      })),
    } as unknown as Partial<SongView>;
    const props = {
      ...testSetlistProps(parts),
      tracks: audio,
      selectedRegionId: "a",
      activeRegionId: "a",
      layoutClass: "wide",
    };
    render(<SetlistView {...(props as unknown as Parameters<typeof SetlistView>[0])} />);
    expect(eqButton("Voz")).toBeTruthy();
    expect(eqButton("Banda")).toBeNull();
    expect(eqButton("Bajo")!.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(eqButton("Bajo")!);
    expect(useTrackEqStore.getState().openTrackId).toBe("bajo");
  });
});

describe("EQ button in the mobile selection bar", () => {
  it("one audio track: enabled, lit from the model, opens the editor", () => {
    platform.mobile = true;
    renderMobileBar(["bajo"]);
    const button = eqButton("Bajo")!;
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button);
    expect(useTrackEqStore.getState().openTrackId).toBe("bajo");
  });

  it("several tracks: enabled, the editor warns and a commit reaches all of them", async () => {
    platform.mobile = true;
    renderMobileBar(["voz", "bajo"]);
    render(
      <TrackEqEditorHost
        runAction={async (action) => action()}
        applyPlaybackSnapshot={vi.fn()}
        optimisticallyAppliedRevisionsRef={{ current: new Set() }}
      />,
    );
    const button = eqButton("Voz")!;
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    expect(useTrackEqStore.getState().targetTrackIds).toEqual(["voz", "bajo"]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Se aplica a 2 pistas")).toBeTruthy();
    const gain = within(dialog).getByLabelText("Ganancia de la banda 3");
    await act(async () => {
      fireEvent.change(gain, { target: { value: "5" } });
      fireEvent.keyDown(gain, { key: "Enter" });
    });
    expect(api.commitTrackEqChange).not.toHaveBeenCalled();
    expect(api.commitTrackEqsChange).toHaveBeenCalledTimes(1);
    const { changes } = api.commitTrackEqsChange.mock.calls[0][0];
    expect(changes.map((change) => change.trackId)).toEqual(["voz", "bajo"]);
  });

  it("a folder: no button", () => {
    platform.mobile = true;
    renderMobileBar(["banda"]);
    expect(eqButton("Banda")).toBeNull();
  });
});

describe("one model for every view", () => {
  it("a change made in the editor opened from Compact lights the DAW header without reloading", async () => {
    renderCompact();
    renderHeader(TRACKS[0]);
    render(
      <TrackEqEditorHost
        runAction={async (action) => action()}
        applyPlaybackSnapshot={vi.fn()}
        optimisticallyAppliedRevisionsRef={{ current: new Set() }}
      />,
    );
    const daw = () =>
      screen
        .getAllByRole("button", { name: "Ecualizador de Voz" })
        .find((button) => button.classList.contains("lt-track-toggle-eq"))!;
    expect(daw().getAttribute("aria-pressed")).toBe("false");

    const compact = screen
      .getAllByRole("button", { name: "Ecualizador de Voz" })
      .find((button) => button.classList.contains("is-eq"))!;
    fireEvent.click(compact);
    const dialog = screen.getByRole("dialog");
    const gain = within(dialog).getByLabelText("Ganancia de la banda 3");
    await act(async () => {
      fireEvent.change(gain, { target: { value: "5" } });
      fireEvent.keyDown(gain, { key: "Enter" });
    });

    expect(api.commitTrackEqChange).toHaveBeenCalledTimes(1);
    expect(daw().getAttribute("aria-pressed")).toBe("true");
    expect(compact.className).toContain("is-active");
  });
});
