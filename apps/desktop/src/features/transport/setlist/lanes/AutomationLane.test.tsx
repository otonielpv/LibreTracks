import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AutomationCueSummary, ClipSummary, SongView, TrackSummary } from "@libretracks/shared/models";

import { resetFrameGateForTests } from "../../frameGate";
import type { TimelineMenus } from "../../menus/timelineMenus";
import { useTimelineUIStore } from "../../uiStore";
import { INITIAL_SETLIST_STATE, useSetlistStore } from "../setlistStore";
import { testRegion } from "../testBindings";
import { SongLanes } from "./SongLanes";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.name ? `${key}:${String(options.name)}` : key,
  }),
}));

// Song from 0 to 100 s, 120 BPM 4/4, drawn 1000 px wide at 1×: 10 px/s.
const region = testRegion("r", { name: "Canción", startSeconds: 0, endSeconds: 100 });
const track = (id: string) =>
  ({ id, name: id, kind: "audio", depth: 0, hasChildren: false, volume: 1, pan: 0, muted: false, solo: false, audioTo: "m", transposeEnabled: true }) as TrackSummary;
const clip = (id: string, trackId: string, timelineStartSeconds: number) =>
  ({
    id,
    trackId,
    filePath: `${id}.wav`,
    waveformKey: id,
    timelineStartSeconds,
    sourceStartSeconds: 0,
    sourceDurationSeconds: 60,
    durationSeconds: 10,
    gain: 1,
  }) as ClipSummary;
const cue = (id: string, atSeconds: number, extra: Partial<AutomationCueSummary> = {}) =>
  ({ id, name: `Cue ${id}`, atSeconds, enabled: true, actions: [{ type: "wait", durationSeconds: 1 }], ...extra }) as AutomationCueSummary;
const tracks = [track("drums"), track("bass")];
const baseSong = {
  bpm: 120,
  timeSignature: "4/4",
  tempoMarkers: [],
  timeSignatureMarkers: [],
  regions: [region],
  sectionMarkers: [{ id: "chorus", name: "Coro", kind: "chorus", startSeconds: 40 }],
  tracks,
  clips: [clip("c1", "drums", 10), clip("c2", "bass", 30)],
  automationCues: [cue("a", 20), cue("b", 60, { enabled: false }), cue("outside", 150)],
  automationTrack: { afterTrackId: "drums", enabled: true },
} as unknown as SongView;

class FakeResizeObserver {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe() {
    this.callback([{ contentRect: { width: 1000, height: 40 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  disconnect() {}
}

function menus() {
  return {
    openMenu: vi.fn(),
    clipContextMenu: vi.fn(() => []),
    createAutomationCueAt: vi.fn(),
    editAutomationCue: vi.fn(),
    automationCueContextMenu: vi.fn(() => [{ label: "cue-menu" }]),
    automationTrackContextMenu: vi.fn(() => [{ label: "lane-menu" }]),
    moveAutomationCue: vi.fn(async () => {}),
    setAutomationTrackOn: vi.fn(async () => {}),
    handleAddAutomationTrack: vi.fn(async () => {}),
  };
}

type LanesProps = ComponentProps<typeof SongLanes>;
function props(song: SongView, menuMock = menus(), overrides: Partial<LanesProps> = {}): LanesProps {
  return {
    song,
    region,
    tracks,
    waveformSummaries: {},
    positionSecondsRef: { current: 47 },
    layout: "wide",
    menus: menuMock as unknown as TimelineMenus,
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
    runShortcutAction: vi.fn(),
    onSeek: vi.fn(),
    onRulerMenuAt: vi.fn(),
    runAction: vi.fn(async (action: () => Promise<void>) => {
      await action();
    }),
    onSnapshotApplied: vi.fn(),
    ...overrides,
  };
}

const diamond = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-lane-cue-id="${id}"]`)!;
const rowKinds = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>(".lt-setlist-lane-row:not(.is-ruler)")).map(
    (row) => row.querySelector<HTMLElement>("[data-lane-track-id]")?.dataset.laneTrackId ?? row.dataset.laneKind,
  );

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
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  resetFrameGateForTests();
  useSetlistStore.setState(INITIAL_SETLIST_STATE);
  useTimelineUIStore.setState({ snapEnabled: false });
});
afterEach(() => vi.unstubAllGlobals());

describe("automation lane", () => {
  it("sits after its track and shows the song's cues only, at their time", () => {
    const { container } = render(<SongLanes {...props(baseSong)} />);
    expect(rowKinds(container)).toEqual(["drums", "automation", "bass"]);
    expect(diamond(container, "a").style.left).toBe("200px");
    expect(diamond(container, "b").classList.contains("is-off")).toBe(true);
    expect(diamond(container, "outside")).toBeNull();
  });

  it("no automation track: no row, and the toolbar offers to add it after the last track", () => {
    const song = { ...baseSong, automationTrack: null } as SongView;
    const menuMock = menus();
    const { container } = render(<SongLanes {...props(song, menuMock)} />);
    expect(rowKinds(container)).toEqual(["drums", "bass"]);
    fireEvent.click(screen.getByRole("button", { name: /transport.automation.addTrack/ }));
    expect(menuMock.handleAddAutomationTrack).toHaveBeenCalledWith("bass");
  });

  it("a click opens the DAW's cue editor; a drag previews and moves with ONE call on release", () => {
    const menuMock = menus();
    const { container } = render(<SongLanes {...props(baseSong, menuMock)} />);
    const element = diamond(container, "a");

    fireEvent.pointerDown(element, { button: 0, pointerId: 1, clientX: 200 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 200 });
    expect(menuMock.editAutomationCue).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));

    fireEvent.pointerDown(element, { button: 0, pointerId: 2, clientX: 200 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 230 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 250 });
    expect(menuMock.moveAutomationCue).not.toHaveBeenCalled();
    expect(element.style.transform).toBe("translate3d(50px, 0, 0)");
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 250 });
    expect(menuMock.moveAutomationCue).toHaveBeenCalledTimes(1);
    expect(menuMock.moveAutomationCue).toHaveBeenCalledWith("a", 25);
    expect(menuMock.editAutomationCue).toHaveBeenCalledTimes(1);
  });

  it("with snap on, the cue lands on the grid", () => {
    useTimelineUIStore.setState({ snapEnabled: true });
    const menuMock = menus();
    const { container } = render(<SongLanes {...props(baseSong, menuMock)} />);
    fireEvent.pointerDown(diamond(container, "a"), { button: 0, pointerId: 3, clientX: 200 });
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 223 });
    fireEvent.pointerUp(window, { pointerId: 3, clientX: 223 });
    const [, seconds] = menuMock.moveAutomationCue.mock.calls[0] as unknown as [string, number];
    expect(seconds % 0.5).toBeCloseTo(0, 6);
  });

  it("Esc during the drag puts the cue back without any call", () => {
    const menuMock = menus();
    const { container } = render(<SongLanes {...props(baseSong, menuMock)} />);
    const element = diamond(container, "a");
    fireEvent.pointerDown(element, { button: 0, pointerId: 4, clientX: 200 });
    fireEvent.pointerMove(window, { pointerId: 4, clientX: 260 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(window, { pointerId: 4, clientX: 260 });
    expect(element.style.transform).toBe("");
    expect(menuMock.moveAutomationCue).not.toHaveBeenCalled();
    expect(menuMock.editAutomationCue).not.toHaveBeenCalled();
  });

  it("menus: the cue's and the lane's are the DAW's", () => {
    const menuMock = menus();
    const { container } = render(<SongLanes {...props(baseSong, menuMock)} />);
    fireEvent.contextMenu(diamond(container, "a"));
    expect(menuMock.automationCueContextMenu).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    expect(menuMock.openMenu).toHaveBeenLastCalledWith(expect.anything(), "Cue a", [{ label: "cue-menu" }]);
    fireEvent.contextMenu(screen.getByLabelText("transport.automation.laneAria"));
    expect(menuMock.openMenu).toHaveBeenLastCalledWith(
      expect.anything(),
      "transport.automation.menuTitle",
      [{ label: "lane-menu" }],
    );
  });

  it("double click on the lane creates a cue there; «+» at the playhead; power switches it off", () => {
    const menuMock = menus();
    render(<SongLanes {...props(baseSong, menuMock)} />);
    const cell = screen.getByLabelText("transport.automation.laneAria");
    Object.defineProperty(cell, "offsetWidth", { configurable: true, value: 1000 });
    cell.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 50, right: 1000, bottom: 50 }) as DOMRect;
    fireEvent.doubleClick(cell, { clientX: 735 });
    expect(menuMock.createAutomationCueAt).toHaveBeenLastCalledWith(73.5);

    fireEvent.click(screen.getByRole("button", { name: "setlistView.automation.addAtPlayhead" }));
    expect(menuMock.createAutomationCueAt).toHaveBeenLastCalledWith(47);

    fireEvent.click(screen.getByRole("button", { name: "transport.automation.disableTrack" }));
    expect(menuMock.setAutomationTrackOn).toHaveBeenCalledWith(false);
  });

  it("«Cue at the section» creates it at the start of the section the playhead is in", () => {
    const menuMock = menus();
    render(<SongLanes {...props(baseSong, menuMock)} />);
    fireEvent.click(screen.getByRole("button", { name: /setlistView.automation.addAtSection$/ }));
    expect(menuMock.createAutomationCueAt).toHaveBeenCalledWith(40);
  });

  it("a new snapshot clears a pending move preview", () => {
    const menuMock = menus();
    const { container, rerender } = render(<SongLanes {...props(baseSong, menuMock)} />);
    const element = diamond(container, "a");
    fireEvent.pointerDown(element, { button: 0, pointerId: 5, clientX: 200 });
    fireEvent.pointerMove(window, { pointerId: 5, clientX: 300 });
    fireEvent.pointerUp(window, { pointerId: 5, clientX: 300 });
    expect(element.style.transform).not.toBe("");
    const moved = { ...baseSong, automationCues: [cue("a", 30), cue("b", 60)] } as SongView;
    act(() => rerender(<SongLanes {...props(moved, menuMock)} />));
    expect(diamond(container, "a").style.transform).toBe("");
    expect(diamond(container, "a").style.left).toBe("300px");
  });
});
