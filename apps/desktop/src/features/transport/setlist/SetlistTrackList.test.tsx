import { useTimelineUIStore } from "../uiStore";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { SongView, TrackSummary } from "@libretracks/shared/models";

import { LIBRARY_ASSET_DRAG_MIME } from "../library/dragDrop";
import type { ContextMenuAction } from "../types";
import type { TimelineMenus } from "../menus/timelineMenus";
import { SetlistView } from "./SetlistView";
import { INITIAL_SETLIST_STATE, useSetlistStore } from "./setlistStore";
import { testRegion, testSetlistProps } from "./testBindings";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.name ? `${key}:${String(options.name)}` : key,
  }),
}));
vi.mock("../tracks/TrackMeter", () => ({ SongMasterMeter: () => null, TrackMeter: () => null }));
vi.mock("../structure/ArrangementBadge", () => ({ ArrangementBadge: () => null }));

const track = (id: string, name: string, extra: Partial<TrackSummary> = {}): TrackSummary =>
  ({
    id,
    name,
    kind: "audio",
    depth: 0,
    hasChildren: false,
    volume: 1,
    pan: 0,
    muted: false,
    solo: false,
    audioTo: "out-1",
    transposeEnabled: true,
    ...extra,
  }) as TrackSummary;

const regions = [
  testRegion("a", { name: "Alfa", startSeconds: 0, endSeconds: 100 }),
  testRegion("b", { name: "Beta", startSeconds: 100, endSeconds: 200 }),
];
const tracks = [
  track("folder", "Banda", { kind: "folder", hasChildren: true }),
  track("drums", "Batería", { parentTrackId: "folder", depth: 1 }),
  track("voxA", "Voz A"),
  track("voxB", "Voz B"),
];
const songParts = {
  regions,
  tracks,
  clips: [
    { id: "d1", trackId: "drums", timelineStartSeconds: 0, durationSeconds: 90 },
    { id: "va", trackId: "voxA", timelineStartSeconds: 10, durationSeconds: 50 },
    { id: "d2", trackId: "drums", timelineStartSeconds: 100, durationSeconds: 90 },
    { id: "vb", trackId: "voxB", timelineStartSeconds: 120, durationSeconds: 40 },
  ],
} as unknown as Partial<SongView>;
const clipsByRegion = {
  a: [
    { id: "d1", clipName: "drums-a.wav", trackId: "drums", trackName: "Batería" },
    { id: "va", clipName: "voz-a.wav", trackId: "voxA", trackName: "Voz A" },
  ],
  b: [
    { id: "d2", clipName: "drums-b.wav", trackId: "drums", trackName: "Batería" },
    { id: "vb", clipName: "voz-b.wav", trackId: "voxB", trackName: "Voz B" },
  ],
};

function menus() {
  return {
    openMenu: vi.fn(),
    globalTrackListContextMenu: vi.fn(() => [{ label: "transport.menu.addAudioTrack", onSelect: vi.fn() }]),
  } as unknown as TimelineMenus;
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    ...testSetlistProps(songParts),
    tracks,
    clipsByRegion,
    menus: menus(),
    selectedRegionId: "a",
    ...overrides,
  };
}

const rowNames = (container: HTMLElement) =>
  Array.from(container.querySelectorAll(".lt-setlist-track-row strong")).map((element) => element.textContent);
const row = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`.lt-setlist-track-row[data-track-id="${id}"]`)!;

const originalPointerEvent = window.PointerEvent;
beforeAll(() => {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  Object.defineProperty(window, "PointerEvent", { configurable: true, value: TestPointerEvent });
});
afterAll(() => {
  Object.defineProperty(window, "PointerEvent", { configurable: true, value: originalPointerEvent });
});
beforeEach(() => useSetlistStore.setState({ ...INITIAL_SETLIST_STATE, editMode: "tracks" }));

describe("Edit → Tracks", () => {
  it("lists the selected song's tracks with that song's clips", () => {
    const { container, rerender } = render(<SetlistView {...props()} layoutClass="wide" />);
    expect(rowNames(container)).toEqual(["Banda", "Batería", "Voz A"]);
    expect(within(row(container, "drums")).getByText("drums-a.wav")).toBeTruthy();
    expect(screen.queryByText("drums-b.wav")).toBeNull();

    rerender(<SetlistView {...props({ selectedRegionId: "b" })} layoutClass="wide" />);
    expect(rowNames(container)).toEqual(["Banda", "Batería", "Voz B"]);
    expect(within(row(container, "drums")).getByText("drums-b.wav")).toBeTruthy();
  });

  it("dropping files or library assets goes to the song", () => {
    const onDropOsFilesIntoSong = vi.fn();
    const onDropLibraryAssetsIntoSong = vi.fn();
    const { container } = render(
      <SetlistView {...props({ onDropOsFilesIntoSong, onDropLibraryAssetsIntoSong })} layoutClass="wide" />,
    );
    const list = container.querySelector<HTMLElement>(".lt-setlist-tracks")!;
    const file = new File(["x"], "bajo.wav");
    fireEvent.drop(list, { dataTransfer: { files: [file], types: ["Files"] } });
    expect(onDropOsFilesIntoSong).toHaveBeenCalledWith("a", [file]);

    fireEvent.drop(list, {
      dataTransfer: {
        files: [],
        types: [LIBRARY_ASSET_DRAG_MIME],
        getData: () => JSON.stringify([{ file_path: "audio/teclas.wav", durationSeconds: 30 }]),
      },
    });
    expect(onDropLibraryAssetsIntoSong).toHaveBeenCalledWith("a", [
      { filePath: "audio/teclas.wav", durationSeconds: 30 },
    ]);
  });

  it("track menus and «+ track» are the DAW's", () => {
    const onTrackContextMenu = vi.fn();
    const base = props({ onTrackContextMenu });
    const { container } = render(<SetlistView {...base} layoutClass="wide" />);
    fireEvent.contextMenu(row(container, "voxA"));
    expect(onTrackContextMenu).toHaveBeenCalledWith(expect.anything(), "voxA");
    fireEvent.click(screen.getByRole("button", { name: /setlistView.tracks.addTrack/ }));
    expect(base.menus.globalTrackListContextMenu).toHaveBeenCalled();
    expect(base.menus.openMenu).toHaveBeenCalledWith(expect.anything(), "setlistView.tracks.addTrack", [
      expect.objectContaining({ label: "transport.menu.addAudioTrack" }),
    ]);
  });

  it("the grip starts the DAW's track reorder drag; selection is the DAW's", () => {
    const onTrackDragStart = vi.fn();
    const onTrackSelect = vi.fn();
    const { container } = render(<SetlistView {...props({ onTrackDragStart, onTrackSelect })} layoutClass="wide" />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "setlistView.tracks.reorder:Voz A" }), { button: 0 });
    expect(onTrackDragStart).toHaveBeenCalledWith(expect.anything(), "voxA");
    fireEvent.click(within(row(container, "voxA")).getByText("Voz A"));
    expect(onTrackSelect).toHaveBeenCalledWith("voxA", "Voz A", expect.anything());
  });

  it("a clip dragged onto another audio track moves there; its menu deletes it", () => {
    const onMoveClipToTrack = vi.fn();
    const onDeleteClip = vi.fn();
    const base = props({ onMoveClipToTrack, onDeleteClip });
    const { container } = render(<SetlistView {...base} layoutClass="wide" />);
    const target = row(container, "voxA");
    const elementFromPoint = vi.fn(() => target);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: elementFromPoint });

    fireEvent.pointerDown(screen.getByText("drums-a.wav"), { button: 0, pointerId: 3 });
    fireEvent.pointerUp(window, { pointerId: 3, clientX: 10, clientY: 10 });
    expect(onMoveClipToTrack).toHaveBeenCalledWith("d1", "voxA");

    fireEvent.contextMenu(screen.getByText("voz-a.wav"));
    const actions = (base.menus.openMenu as Mock).mock.calls.at(-1)![2] as ContextMenuAction[];
    actions.find((action) => action.label === "compactView.deleteClip")!.onSelect();
    expect(onDeleteClip).toHaveBeenCalledWith("va");
  });

  it("«Add audio…» uses the song's add-audio handler", () => {
    const onAddAudioToSong = vi.fn();
    render(<SetlistView {...props({ onAddAudioToSong })} layoutClass="wide" />);
    fireEvent.click(screen.getByRole("button", { name: /setlistView.tracks.addAudio/ }));
    expect(onAddAudioToSong).toHaveBeenCalledWith("a");
  });
});

describe("Edit → Tracks by size", () => {
  it("wide: the list takes the mixer's place and shows the route", () => {
    const { container } = render(<SetlistView {...props()} layoutClass="wide" />);
    expect(container.querySelector("[data-setlist-zone='mixer'] .lt-setlist-tracks")).not.toBeNull();
    expect(container.querySelector(".lt-setlist-track-route")).not.toBeNull();
  });

  it("medium: no route column", () => {
    const { container } = render(<SetlistView {...props()} layoutClass="medium" />);
    expect(container.querySelector(".lt-setlist-tracks")).not.toBeNull();
    expect(container.querySelector(".lt-setlist-track-route")).toBeNull();
  });

  it("short: a full-screen list whose clips show when a track is expanded", () => {
    const { container } = render(<SetlistView {...props()} layoutClass="short" />);
    expect(container.querySelector("[data-setlist-zone='drawer'] .lt-setlist-tracks")).not.toBeNull();
    expect(screen.queryByText("drums-a.wav")).toBeNull();
    fireEvent.click(within(row(container, "drums")).getByText("Batería"));
    expect(screen.getByText("drums-a.wav")).toBeTruthy();
  });

  // The iPhone report: the handle did not move tracks with a finger (the
  // DAW only lets a finger drag in its reorder mode; the handle turns it on
  // for the drag) and the automation row had no handle.
  it("a finger on the handle drags in the DAW's reorder mode, the automation row included", () => {
    class TouchPointerEvent extends MouseEvent {
      readonly pointerId = 1;
      readonly pointerType = "touch";
    }
    const original = window.PointerEvent;
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: TouchPointerEvent });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const seen: boolean[] = [];
    const onTrackDragStart = vi.fn(() => seen.push(useTimelineUIStore.getState().trackReorderMode));
    const base = props({ onTrackDragStart });
    const automationSong = { ...base.performance.song, automationTrack: { afterTrackId: "drums", enabled: true } } as SongView;
    render(<SetlistView {...base} performance={{ ...base.performance, song: automationSong }} layoutClass="wide" />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "setlistView.tracks.reorder:Voz A" }), { button: 0 });
    expect(seen).toEqual([true]);
    fireEvent.pointerUp(window);
    vi.advanceTimersByTime(1);
    expect(useTimelineUIStore.getState().trackReorderMode).toBe(false);
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "setlistView.tracks.reorder:setlistView.tracks.kind.automation" }),
      { button: 0 },
    );
    expect(onTrackDragStart).toHaveBeenLastCalledWith(expect.anything(), "__automation__");
    vi.useRealTimers();
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: original });
  });
});

