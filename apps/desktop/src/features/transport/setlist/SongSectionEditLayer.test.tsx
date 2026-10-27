import { fireEvent, render, screen } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { SectionMarkerSummary, SongView } from "@libretracks/shared/models";

import { useSongStore } from "../songStore";
import { INITIAL_STRUCTURE_STATE, useStructureStore } from "../structure/structureStore";
import { useTimelineUIStore } from "../uiStore";
import { createSectionEditHandlers, type SectionEditDeps } from "./sectionEditHandlers";
import { SongSectionEditLayer } from "./SongSectionEditLayer";
import { testRegion } from "./testBindings";

const mobile = vi.hoisted(() => ({ value: false }));
vi.mock("../desktopApi", async (importOriginal) => {
  const original = await importOriginal<typeof import("../desktopApi")>();
  return {
    ...original,
    get isMobileApp() {
      return mobile.value;
    },
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.name ? `${key}:${String(options.name)}` : key,
  }),
}));

// 120 BPM 4/4: 2 s per bar. Song from 0 to 100 s drawn 1000 px wide.
const marker = (id: string, startSeconds: number) =>
  ({ id, name: id, startSeconds, kind: "verse" }) as SectionMarkerSummary;
const region = testRegion("r", { name: "Canción", startSeconds: 0, endSeconds: 100 });
const song = {
  bpm: 120,
  timeSignature: "4/4",
  tempoMarkers: [],
  timeSignatureMarkers: [],
  regions: [region],
  clips: [],
  sectionMarkers: [marker("Verso", 10), marker("Coro", 40), marker("Puente", 80)],
} as unknown as SongView;

function setup(overrides: Partial<SectionEditDeps> = {}) {
  const deps: SectionEditDeps = {
    t: (key) => key,
    getSong: () => song,
    getRegion: () => region,
    getPlayheadSeconds: () => 33.3,
    getSnapEnabled: () => true,
    getGridWidthPx: () => 1000,
    menus: {
      openMenu: vi.fn(),
      rulerContextMenu: vi.fn(() => []),
      openCreateSectionKindMenu: vi.fn(),
      openCreateCueKindMenu: vi.fn(),
      createTypedMarker: vi.fn(),
      songRegionContextMenu: vi.fn(() => []),
      tempoMarkerContextMenu: vi.fn(() => []),
      timeSignatureMarkerContextMenu: vi.fn(() => []),
      keyChangeCallbacks: { openMenu: vi.fn(), move: vi.fn() },
    },
    rulerMarkers: {
      moveGroup: vi.fn(),
      duplicate: vi.fn(),
      remove: vi.fn(),
      groupMenu: vi.fn(() => []),
    },
    onSectionContextMenu: vi.fn(),
    onResizeSong: vi.fn(),
    workspaceEndSeconds: 3600,
    ...overrides,
  };
  const handlers = createSectionEditHandlers(() => deps);
  return { deps, handlers };
}

function renderLayer(handlers: ReturnType<typeof setup>["handlers"]) {
  const view = render(<SongSectionEditLayer song={song} region={region} handlers={handlers} />);
  const layer = view.container.querySelector<HTMLElement>(".lt-setlist-section-layer")!;
  Object.defineProperty(layer, "offsetWidth", { configurable: true, value: 1000 });
  layer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 80, right: 1000, bottom: 80 }) as DOMRect;
  return { ...view, layer };
}

const handle = (name: string) => screen.getByRole("button", { name: `setlistView.sections.handle:${name}` });

const originalPointerEvent = window.PointerEvent;
beforeAll(() => {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  Object.defineProperty(window, "PointerEvent", { configurable: true, value: TestPointerEvent });
});
afterAll(() => {
  Object.defineProperty(window, "PointerEvent", { configurable: true, value: originalPointerEvent });
});

beforeEach(() => {
  mobile.value = false;
  useTimelineUIStore.getState().clearSelection();
  useTimelineUIStore.setState({ snapEnabled: true });
  useStructureStore.setState(INITIAL_STRUCTURE_STATE);
  useSongStore.setState({ song: null });
});

function drag(element: HTMLElement, fromX: number, toX: number, extra: Record<string, unknown> = {}) {
  fireEvent.pointerDown(element, { button: 0, pointerId: 1, clientX: fromX, ...extra });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: (fromX + toX) / 2 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: toX });
}

describe("Section handles: drag", () => {
  it("previews locally and commits ONE moveRulerMarkers on release, snapped to a bar", () => {
    const { deps, handlers } = setup();
    renderLayer(handlers);
    const coro = handle("Coro");
    drag(coro, 400, 433);
    expect(deps.rulerMarkers.moveGroup).not.toHaveBeenCalled();
    // 33 px = 3.3 s → 43.3 s, snapped to the bar at 44 s: +4 s = 40 px.
    expect(coro.style.transform).toBe("translate3d(40px, 0, 0)");
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 433 });
    expect(deps.rulerMarkers.moveGroup).toHaveBeenCalledTimes(1);
    expect(deps.rulerMarkers.moveGroup).toHaveBeenCalledWith([{ kind: "section", id: "Coro" }], 4);
  });

  it("stays inside the song at both edges", () => {
    useTimelineUIStore.setState({ snapEnabled: false });
    const { deps, handlers } = setup({ getSnapEnabled: () => false });
    renderLayer(handlers);
    drag(handle("Verso"), 100, -500);
    fireEvent.pointerUp(window, { pointerId: 1, clientX: -500 });
    expect(deps.rulerMarkers.moveGroup).toHaveBeenLastCalledWith([{ kind: "section", id: "Verso" }], -10);

    drag(handle("Puente"), 800, 5000);
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 5000 });
    const [, delta] = (deps.rulerMarkers.moveGroup as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    expect(80 + delta).toBeLessThan(100);
    expect(80 + delta).toBeGreaterThan(99.9);
  });

  it("a selected group moves together", () => {
    useTimelineUIStore.setState({ snapEnabled: false });
    const { deps, handlers } = setup({ getSnapEnabled: () => false });
    renderLayer(handlers);
    useTimelineUIStore.getState().setSelectedMarkers([
      { kind: "section", id: "Verso" },
      { kind: "section", id: "Coro" },
    ]);
    drag(handle("Coro"), 400, 450);
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 450 });
    const [markers, delta] = (deps.rulerMarkers.moveGroup as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(markers).toEqual([
      { kind: "section", id: "Verso" },
      { kind: "section", id: "Coro" },
    ]);
    expect(delta).toBeCloseTo(5, 9);
  });

  it("a song with an applied arrangement asks first and does not move", () => {
    const arranged = {
      ...song,
      regions: [{ ...region, structure: { sections: [], arrangements: [{ id: "x", name: "Corto", blocks: [] }], appliedArrangementId: "x" } }],
    } as unknown as SongView;
    useSongStore.setState({ song: arranged });
    const { deps, handlers } = setup();
    renderLayer(handlers);
    const coro = handle("Coro");
    drag(coro, 400, 450);
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 450 });
    expect(deps.rulerMarkers.moveGroup).not.toHaveBeenCalled();
    expect(useStructureStore.getState().guard).toMatchObject({ arrangementName: "Corto" });
    expect(coro.style.transform).toBe("");
  });
});

describe("Section handles: select, menu, create", () => {
  it("the Add submenu offers sections, cues, BPM, meter and key at the cursor's bar", () => {
    const { deps, handlers } = setup();
    const bpm = { label: "transport.menu.changeTimelineBpm", onSelect: vi.fn() };
    const meter = { label: "transport.menu.createTimeSignatureMarker", onSelect: vi.fn() };
    const key = { label: "transport.keyChanges.addAtCursor", onSelect: vi.fn() };
    vi.mocked(deps.menus.rulerContextMenu).mockReturnValue([bpm, meter]);
    vi.mocked(deps.menus.songRegionContextMenu).mockReturnValue([key]);
    handlers.openCreateMenuAt({ clientX: 0, clientY: 0 } as never, 33.3);
    expect(deps.menus.rulerContextMenu).toHaveBeenCalledWith(34, null);
    expect(deps.menus.songRegionContextMenu).toHaveBeenCalledWith(region, 34);
    const actions = vi.mocked(deps.menus.openMenu).mock.calls[0][2];
    expect(actions.map((action) => action.label)).toEqual([
      "setlistView.sections.addShort", "setlistView.sections.addCueShort",
      bpm.label, meter.label, key.label,
    ]);
    actions[0].onSelect?.();
    actions[1].onSelect?.();
    expect(deps.menus.openCreateSectionKindMenu).toHaveBeenCalledWith(34);
    expect(deps.menus.openCreateCueKindMenu).toHaveBeenCalledWith(34);
    actions.slice(2).forEach((action) => action.onSelect?.());
    expect(bpm.onSelect).toHaveBeenCalledOnce();
    expect(meter.onSelect).toHaveBeenCalledOnce();
    expect(key.onSelect).toHaveBeenCalledOnce();
  });

  it("a click selects; Ctrl adds to the selection", () => {
    const { handlers } = setup();
    renderLayer(handlers);
    fireEvent.pointerDown(handle("Verso"), { button: 0, pointerId: 1, clientX: 100 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100 });
    expect(useTimelineUIStore.getState().selectedSectionId).toBe("Verso");
    fireEvent.pointerDown(handle("Coro"), { button: 0, pointerId: 1, clientX: 400, ctrlKey: true });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 400 });
    expect(useTimelineUIStore.getState().selectedMarkers).toEqual([
      { kind: "section", id: "Verso" },
      { kind: "section", id: "Coro" },
    ]);
  });

  it("the handle menu is the DAW section menu, or the group menu for a selection", () => {
    const { deps, handlers } = setup();
    renderLayer(handlers);
    fireEvent.contextMenu(handle("Coro"));
    expect(deps.onSectionContextMenu).toHaveBeenCalledWith(expect.anything(), "Coro");

    useTimelineUIStore.getState().setSelectedMarkers([
      { kind: "section", id: "Verso" },
      { kind: "section", id: "Coro" },
    ]);
    fireEvent.contextMenu(handle("Coro"));
    expect(deps.rulerMarkers.groupMenu).toHaveBeenCalled();
    expect(deps.menus.openMenu).toHaveBeenCalled();
  });

  it("createAt puts a marker on the bar; openMenuAt opens the ruler menu there", () => {
    const { deps, handlers } = setup();
    handlers.createAt(33.3);
    expect(deps.menus.createTypedMarker).toHaveBeenCalledWith(34, null, null);
    handlers.openMenuAt({ clientX: 0, clientY: 0 } as never, 61.2);
    expect(deps.menus.rulerContextMenu).toHaveBeenLastCalledWith(62, null);
    expect(deps.menus.openMenu).toHaveBeenCalledWith(expect.anything(), "transport.menu.createMarker", []);
  });

  it("cues are handles too and move with the same single commit", () => {
    const cueSong = {
      ...song,
      sectionMarkers: [...song.sectionMarkers, { id: "Aviso", name: "Aviso", startSeconds: 60, kind: "custom", categoryOverride: "cue" }],
    } as unknown as SongView;
    const { deps, handlers } = setup({ getSong: () => cueSong });
    const view = render(<SongSectionEditLayer song={cueSong} region={region} handlers={handlers} />);
    const layer = view.container.querySelector<HTMLElement>(".lt-setlist-section-layer")!;
    Object.defineProperty(layer, "offsetWidth", { configurable: true, value: 1000 });
    const cue = handle("Aviso");
    expect(cue.classList.contains("is-cue")).toBe(true);
    drag(cue, 600, 640);
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 640 });
    expect(deps.rulerMarkers.moveGroup).toHaveBeenCalledWith([{ kind: "section", id: "Aviso" }], 4);
  });

  it("the song-end handle changes the song's end (the last section's length) once", () => {
    const onResizeSong = vi.fn();
    const { handlers } = setup({ onResizeSong, workspaceEndSeconds: 3600 });
    renderLayer(handlers);
    const end = screen.getByRole("button", { name: "setlistView.sections.songEnd:Canción" });
    drag(end, 1000, 1033);
    expect(onResizeSong).not.toHaveBeenCalled();
    expect(end.style.transform).toBe("translate3d(33px, 0, 0)");
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 1033 });
    // 103.3 s, on the bar at 104 s.
    expect(onResizeSong).toHaveBeenCalledWith("r", 0, 104);
  });

  it("«+ at the playhead» opens the DAW ruler menu at the bar of the playhead", () => {
    const { deps, handlers } = setup();
    handlers.createAtPlayhead({ clientX: 0, clientY: 0 } as never);
    expect(deps.menus.rulerContextMenu).toHaveBeenCalledWith(34, null);
    expect(deps.menus.openMenu).toHaveBeenCalledWith(expect.anything(), "setlistView.sections.add", expect.arrayContaining([
      expect.objectContaining({ label: "setlistView.sections.addShort" }),
      expect.objectContaining({ label: "setlistView.sections.addCueShort" }),
    ]));
  });

  it("duplicate and delete act on the selection through the batch commands", () => {
    const { deps, handlers } = setup();
    const selection = [
      { kind: "section" as const, id: "Verso" },
      { kind: "section" as const, id: "Coro" },
    ];
    useTimelineUIStore.getState().setSelectedMarkers(selection);
    handlers.duplicateSelection();
    handlers.deleteSelection();
    expect(deps.rulerMarkers.duplicate).toHaveBeenCalledWith(selection);
    expect(deps.rulerMarkers.remove).toHaveBeenCalledWith(selection);
  });
});

describe("Section handles: touch", () => {
  it("on mobile the handles get the touch grab zone and the waveform does not drag", () => {
    mobile.value = true;
    const { deps, handlers } = setup();
    const { layer } = renderLayer(handlers);
    expect(layer.classList.contains("is-touch")).toBe(true);
    fireEvent.pointerDown(layer, { button: 0, pointerId: 2, pointerType: "touch", clientX: 400 });
    fireEvent.pointerMove(window, { pointerId: 2, pointerType: "touch", clientX: 600 });
    fireEvent.pointerUp(window, { pointerId: 2, pointerType: "touch", clientX: 600 });
    expect(deps.rulerMarkers.moveGroup).not.toHaveBeenCalled();

    const coro = handle("Coro");
    drag(coro, 400, 450, { pointerType: "touch" });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 450 });
    expect(deps.rulerMarkers.moveGroup).toHaveBeenCalledTimes(1);
  });
});

// The phone report: no way to add a tempo, meter or key change mid-song.
describe("tempo, meter and key on the phone", () => {
  it("one menu with the DAW's three actions, at the line's bar", () => {
    const bpm = { label: "transport.menu.changeTimelineBpm", onSelect: vi.fn() };
    const meter = { label: "transport.menu.createTimeSignatureMarker", onSelect: vi.fn() };
    const key = { label: "transport.keyChanges.addAtCursor ▸", onSelect: vi.fn() };
    const { deps, handlers } = setup();
    const menus = deps.menus as unknown as Record<string, ReturnType<typeof vi.fn>>;
    menus.rulerContextMenu.mockReturnValue([{ label: "transport.menu.createMarker" }, bpm, meter]);
    menus.songRegionContextMenu.mockReturnValue([{ label: "other" }, key]);
    handlers.openTimingMenuAt({ clientX: 1, clientY: 1 } as never, 33.3);
    // Snap on: the nearest bar, 34 s (2 s bars).
    expect(menus.rulerContextMenu).toHaveBeenCalledWith(34, null);
    expect(menus.openMenu).toHaveBeenCalledWith(expect.anything(), "setlistView.sections.timingTitle", [bpm, meter, key]);
  });

  it("a key mark opens the DAW's key-change menu", () => {
    const { deps, handlers } = setup();
    handlers.openTimingMarkMenu({ clientX: 5, clientY: 6 } as never, { kind: "key", id: "k1" });
    expect(deps.menus.keyChangeCallbacks.openMenu).toHaveBeenCalledWith(5, 6, "r", "k1");
  });
});
