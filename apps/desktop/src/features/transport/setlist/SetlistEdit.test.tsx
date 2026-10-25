import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SectionMarkerSummary, SongView } from "@libretracks/shared/models";

import type { TimelineMenus } from "../menus/timelineMenus";
import { useSongStore } from "../songStore";
import { INITIAL_STRUCTURE_STATE, useStructureStore } from "../structure/structureStore";
import { useTimelineUIStore } from "../uiStore";
import { SetlistView } from "./SetlistView";
import { INITIAL_SETLIST_STATE, useSetlistStore } from "./setlistStore";
import { parseClockInput } from "./SetlistSongSettings";
import { testRegion, testSetlistProps } from "./testBindings";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.name ? `${key}:${String(options.name)}` : key,
  }),
}));

vi.mock("../tracks/TrackMeter", () => ({ SongMasterMeter: () => null, TrackMeter: () => null }));
vi.mock("../structure/ArrangementBadge", () => ({ ArrangementBadge: () => null }));

const api = vi.hoisted(() => ({
  updateSongRegionFades: vi.fn(async () => ({ projectRevision: 2 })),
  updateSongRegionVoiceGuideCountStyle: vi.fn(async () => ({ projectRevision: 3 })),
}));
vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  ...api,
  isMobileApp: false,
}));
const dialog = vi.hoisted(() => ({ promptDialog: vi.fn(async () => "3") }));
vi.mock("../../../shared/dialog/dialogService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shared/dialog/dialogService")>()),
  promptDialog: dialog.promptDialog,
}));

const marker = (id: string, startSeconds: number) =>
  ({ id, name: id, startSeconds, kind: "verse" }) as SectionMarkerSummary;
const regions = [
  testRegion("a", { name: "Alfa", startSeconds: 0, endSeconds: 60, key: "G" }),
  testRegion("b", { name: "Beta", startSeconds: 64, endSeconds: 160, key: "D", transposeSemitones: 2 }),
];
const songParts = {
  regions,
  sectionMarkers: [marker("Coro", 80)],
  clips: [{ id: "c1", trackId: "t", timelineStartSeconds: 70, durationSeconds: 60 }],
} as unknown as Partial<SongView>;

function menusWith(onSelect: Record<string, () => void>) {
  return {
    songRegionContextMenu: () =>
      Object.entries(onSelect).map(([label, select]) => ({ label, onSelect: select })),
  } as unknown as TimelineMenus;
}

function props(overrides: Record<string, unknown> = {}) {
  return { ...testSetlistProps(songParts), selectedRegionId: "b", ...overrides };
}

function enterEdit() {
  fireEvent.click(screen.getByRole("button", { name: "setlistView.edit.button" }));
}

beforeEach(() => {
  useSetlistStore.setState(INITIAL_SETLIST_STATE);
  useStructureStore.setState(INITIAL_STRUCTURE_STATE);
  vi.clearAllMocks();
});

describe("Edit mode", () => {
  it("the Edit button toggles it; outside it a section jumps, inside it selects", () => {
    const onMarkerAction = vi.fn();
    const base = props();
    const { container } = render(
      <SetlistView {...base} performance={{ ...base.performance, onMarkerAction }} layoutClass="wide" />,
    );
    const coro = () => container.querySelector<HTMLElement>("[data-block-id='Coro']")!;
    fireEvent.click(coro());
    expect(onMarkerAction).toHaveBeenCalledTimes(1);

    enterEdit();
    expect(useSetlistStore.getState().editMode).toBe("song");
    fireEvent.click(coro());
    expect(onMarkerAction).toHaveBeenCalledTimes(1);
    expect(useTimelineUIStore.getState().selectedSectionId).toBe("Coro");
    expect(coro().classList.contains("is-selected")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "setlistView.edit.done" }));
    expect(useSetlistStore.getState().editMode).toBeNull();
  });

  it("entering edit selects the song the view shows", () => {
    const onSelectRegion = vi.fn();
    render(<SetlistView {...props({ selectedRegionId: null, activeRegionId: "b", onSelectRegion })} layoutClass="wide" />);
    enterEdit();
    expect(onSelectRegion).toHaveBeenCalledWith("b");
  });

  it("Esc leaves edit mode, but not while a modal is open", () => {
    render(<SetlistView {...props()} layoutClass="wide" />);
    enterEdit();
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useSetlistStore.getState().editMode).toBe("song");
    modal.remove();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useSetlistStore.getState().editMode).toBeNull();
  });

  it.each(["wide", "medium", "short"] as const)("%s: the drawer has its layout", (layoutClass) => {
    const { container } = render(<SetlistView {...props()} layoutClass={layoutClass} />);
    enterEdit();
    const drawer = container.querySelector(`.lt-setlist-drawer.is-${layoutClass}`);
    expect(drawer).not.toBeNull();
    if (layoutClass === "short") {
      // Full screen with a back button.
      expect(within(drawer as HTMLElement).getAllByRole("button", { name: "setlistView.edit.close" })).toHaveLength(1);
    } else {
      // A full-height side panel beside the band and the console.
      expect(container.querySelector(".lt-setlist-view > [data-setlist-zone='drawer']")).not.toBeNull();
    }
  });

  it("in edit mode the row offers «Level songs»", () => {
    render(<SetlistView {...props()} layoutClass="wide" />);
    expect(screen.queryByText("setlistView.songs.levelSongs")).toBeNull();
    enterEdit();
    expect(screen.getByText("setlistView.songs.levelSongs")).toBeTruthy();
  });
});

describe("Edit → Song", () => {
  it("each field calls the existing handler", () => {
    const spies = {
      onSetSongKey: vi.fn(),
      onSelectedRegionTransposeChange: vi.fn(),
      onSelectedRegionWarpToggle: vi.fn(),
      onSelectedRegionTempoChange: vi.fn(),
      onMasterGainChange: vi.fn(),
      onMasterGainCommit: vi.fn(),
    };
    render(<SetlistView {...props(spies)} layoutClass="wide" />);
    enterEdit();

    fireEvent.change(screen.getByRole("combobox", { name: "setlistView.edit.key" }), { target: { value: "E" } });
    expect(spies.onSetSongKey).toHaveBeenCalledWith("b", "E");

    fireEvent.click(screen.getByRole("button", { name: "timelineToolbar.regionTransposeUpAria" }));
    expect(spies.onSelectedRegionTransposeChange).toHaveBeenCalledWith(3);

    fireEvent.click(screen.getByRole("button", { name: "setlistView.edit.warpOff" }));
    expect(spies.onSelectedRegionWarpToggle).toHaveBeenCalledWith(true);

    const drawer = document.querySelector(".lt-setlist-drawer") as HTMLElement;
    const master = within(drawer).getByRole("slider", { name: "setlistView.mixer.masterAria:Beta" });
    fireEvent.change(master, { target: { value: "0.5" } });
    fireEvent.pointerUp(master);
    expect(spies.onMasterGainChange).toHaveBeenCalledWith("b", 0.5);
    expect(spies.onMasterGainCommit).toHaveBeenCalledWith("b");
  });

  it("rename, export, render, analyse and delete are the DAW song menu's entries", () => {
    const selected: string[] = [];
    const labels = [
      "transport.menu.renameSong",
      "transport.menu.exportSong",
      "transport.menu.renderSong",
      "transport.menu.analyzeSong",
      "transport.menu.deleteSong",
      "transport.menu.changeRegionWarpSourceBpm",
    ];
    const menus = menusWith(Object.fromEntries(labels.map((label) => [label, () => selected.push(label)])));
    render(<SetlistView {...props({ menus })} layoutClass="wide" />);
    enterEdit();
    for (const label of labels) {
      fireEvent.click(screen.getByRole("button", { name: label }));
    }
    expect(selected).toEqual(labels);
  });

  it("fades and count style are the song submenus' own actions", async () => {
    render(<SetlistView {...props()} layoutClass="wide" />);
    enterEdit();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "transport.menu.songFadeIn" }));
    });
    expect(dialog.promptDialog).toHaveBeenCalled();
    expect(api.updateSongRegionFades).toHaveBeenCalledWith("b", 3, 0);

    await act(async () => {
      fireEvent.click(screen.getAllByRole("radio")[1]);
    });
    expect(api.updateSongRegionVoiceGuideCountStyle).toHaveBeenCalledWith("b", "full");
  });
});

// Step 15, C3: the top bar's tap tempo, kept inside the edited song.
describe("Edit → Song tap tempo", () => {
  it("Tap is the DAW's tap tempo; the playhead is first brought into the song", () => {
    const onTapTempo = vi.fn();
    const base = props({ onTapTempo });
    const onSeek = vi.fn();
    const positionSecondsRef = { current: 10 };
    render(
      <SetlistView
        {...base}
        performance={{ ...base.performance, onSeek, positionSecondsRef }}
        layoutClass="wide"
      />,
    );
    enterEdit();
    fireEvent.click(screen.getByRole("button", { name: /setlistView.tempo.tap$/ }));
    // The playhead (10 s) is in Alfa, the edited song is Beta (64 s).
    expect(onSeek).toHaveBeenCalledWith(64);
    expect(onTapTempo).toHaveBeenCalledTimes(1);
    positionSecondsRef.current = 70;
    fireEvent.click(screen.getByRole("button", { name: /setlistView.tempo.tap$/ }));
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onTapTempo).toHaveBeenCalledTimes(2);
  });
});

describe("Edit → Song bounds", () => {
  it("an end typed before the start is pushed back like dragging the edge in the DAW", () => {
    const onResizeSong = vi.fn();
    render(<SetlistView {...props({ onResizeSong })} layoutClass="wide" />);
    enterEdit();
    const end = screen.getByRole("textbox", { name: "setlistView.edit.end · markerPosition.seconds" });
    fireEvent.change(end, { target: { value: "0:30" } });
    fireEvent.keyDown(end, { key: "Enter" });
    // The song's clip ends at 130 s: the end can't go below it.
    expect(onResizeSong).toHaveBeenCalledWith("b", 64, 130);
  });

  it("the start stops at the previous song", () => {
    const onResizeSong = vi.fn();
    render(<SetlistView {...props({ onResizeSong })} layoutClass="wide" />);
    enterEdit();
    const start = screen.getByRole("textbox", { name: "setlistView.edit.start · markerPosition.seconds" });
    fireEvent.change(start, { target: { value: "10" } });
    fireEvent.blur(start);
    expect(onResizeSong).toHaveBeenCalledWith("b", 60, 160);
  });

  it("the gap with the previous song moves the song like the DAW", () => {
    const onMoveSong = vi.fn();
    render(<SetlistView {...props({ onMoveSong })} layoutClass="wide" />);
    enterEdit();
    // 120 BPM 4/4: one bar is 2 s; the gap is 4 s = 2 bars.
    const gap = screen.getByRole("textbox", { name: "setlistView.edit.gap:Alfa" }) as HTMLInputElement;
    expect(gap.value).toBe("2");
    fireEvent.change(gap, { target: { value: "4" } });
    fireEvent.keyDown(gap, { key: "Enter" });
    expect(onMoveSong).toHaveBeenCalledWith("b", 4);
  });

  it("a song with an applied arrangement asks «Edit the original?» first", () => {
    const arranged = testRegion("b", {
      name: "Beta",
      startSeconds: 64,
      endSeconds: 160,
      structure: { sections: [], arrangements: [{ id: "sun", name: "Domingo", blocks: [] }], appliedArrangementId: "sun" },
    });
    const song = { ...testSetlistProps(songParts).performance.song, regions: [regions[0], arranged] } as SongView;
    useSongStore.setState({ song });
    const onResizeSong = vi.fn();
    const base = props({ regions: [regions[0], arranged], onResizeSong });
    render(<SetlistView {...base} performance={{ ...base.performance, song }} layoutClass="wide" />);
    enterEdit();
    const end = screen.getByRole("textbox", { name: "setlistView.edit.end · markerPosition.seconds" });
    fireEvent.change(end, { target: { value: "2:30" } });
    fireEvent.keyDown(end, { key: "Enter" });
    expect(onResizeSong).not.toHaveBeenCalled();
    expect(useStructureStore.getState().guard).toMatchObject({ regionId: "b", arrangementName: "Domingo" });
    useSongStore.setState({ song: null });
  });

  it("parses clock input", () => {
    expect(parseClockInput("1:05.25")).toBe(65.25);
    expect(parseClockInput("90")).toBe(90);
    expect(parseClockInput("1,5")).toBe(1.5);
    expect(parseClockInput("a")).toBeNull();
    expect(parseClockInput("1:2:3")).toBeNull();
  });
});
