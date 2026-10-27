import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AutomationCueSummary, SongView } from "@libretracks/shared/models";

import { resetFrameGateForTests } from "../../frameGate";
import type { TimelineMenus } from "../../menus/timelineMenus";
import { useTimelineUIStore } from "../../uiStore";
import { INITIAL_SETLIST_STATE, useSetlistStore } from "../setlistStore";
import { testRegion } from "../testBindings";
import { SongLanes } from "./SongLanes";
import { songMeterChanges, songTempoPoints } from "./TempoLane";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.label ? `${key}:${String(options.label)}` : options?.signature ? `${key}:${String(options.signature)}` : key,
  }),
}));

// Song from 0 to 100 s, 1000 px: 10 px/s. Base 120 BPM; a ritardando from
// 60 s down to 80 BPM at 80 s; 2/4 for one bar at 70 s.
const region = testRegion("r", { startSeconds: 0, endSeconds: 100 });
const song = {
  bpm: 120,
  timeSignature: "4/4",
  tempoMarkers: [
    { id: "rit", startSeconds: 60, bpm: 120, ramp: true },
    { id: "slow", startSeconds: 80, bpm: 80 },
    { id: "next-song", startSeconds: 140, bpm: 90 },
  ],
  timeSignatureMarkers: [
    { id: "two", startSeconds: 70, signature: "2/4" },
    { id: "back", startSeconds: 71, signature: "4/4" },
  ],
  regions: [region],
  sectionMarkers: [],
  tracks: [],
  clips: [],
  automationCues: [{ id: "c", name: "Cue", atSeconds: 10, enabled: true, actions: [] } as AutomationCueSummary],
  automationTrack: { afterTrackId: null, enabled: true },
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
    tempoMarkerContextMenu: vi.fn(() => [{ label: "tempo" }]),
    timeSignatureMarkerContextMenu: vi.fn(() => [{ label: "meter" }]),
    rulerContextMenu: vi.fn(() => [{ label: "ruler" }]),
    changeTimelineBpmAt: vi.fn(async () => {}),
    createTimeSignatureMarkerAt: vi.fn(async () => {}),
    moveAutomationCue: vi.fn(),
    editAutomationCue: vi.fn(),
  };
}

type LanesProps = ComponentProps<typeof SongLanes>;
function props(menuMock = menus(), overrides: Partial<LanesProps> = {}): LanesProps {
  return {
    song,
    region,
    tracks: [],
    waveformSummaries: {},
    positionSecondsRef: { current: 33 },
    layout: "wide",
    menus: menuMock as unknown as TimelineMenus,
    mixerHandlers: {} as LanesProps["mixerHandlers"],
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
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  resetFrameGateForTests();
  useSetlistStore.setState(INITIAL_SETLIST_STATE);
  useTimelineUIStore.setState({ snapEnabled: true });
});
afterEach(() => vi.unstubAllGlobals());

describe("tempo lane model", () => {
  it("the tempo in force at the start, then the song's markers (with their ramps)", () => {
    expect(songTempoPoints(song, region).map(({ seconds, bpm, ramp }) => ({ seconds, bpm, ramp }))).toEqual([
      { seconds: 0, bpm: 120, ramp: false },
      { seconds: 60, bpm: 120, ramp: true },
      { seconds: 80, bpm: 80, ramp: false },
    ]);
    expect(songMeterChanges(song, region).map((marker) => marker.signature)).toEqual(["2/4", "4/4"]);
  });
});

describe("tempo lane", () => {
  // C1: markers, the ramp as a slope, and the meter changes.
  it("draws the base tempo, the markers, the ramp slope and the meters", () => {
    const { container } = render(<SongLanes {...props()} />);
    const labels = Array.from(container.querySelectorAll(".lt-setlist-tempo-marker")).map((node) => node.textContent);
    expect(labels).toEqual(["120 BPM", "120 BPM ↗", "80 BPM"]);
    expect(container.querySelector('[data-tempo-marker-id="rit"]')?.classList.contains("is-ramp")).toBe(true);
    expect(container.querySelector('[data-tempo-marker-id="next-song"]')).toBeNull();
    // Flat 0→600 px, the slope 600→800 px from 120 to 80 BPM, flat to the end.
    const path = container.querySelector(".lt-setlist-tempo-curve path")?.getAttribute("d") ?? "";
    expect(path).toContain("L600.0,");
    const [, flatY] = /M0\.0,([\d.]+)/.exec(path) ?? [];
    const slopeEnd = /L800\.0,([\d.]+)/.exec(path)?.[1];
    expect(Number(slopeEnd)).toBeGreaterThan(Number(flatY));
    expect(Array.from(container.querySelectorAll(".lt-setlist-meter-marker")).map((node) => node.textContent)).toEqual([
      "2/4",
      "4/4",
    ]);
  });

  // C2: the DAW's menus and creators.
  it("markers open the DAW's menus; the lane's right click is the ruler menu; + Tempo / + Meter at the playhead", () => {
    const menuMock = menus();
    const { container } = render(<SongLanes {...props(menuMock)} />);
    fireEvent.click(container.querySelector<HTMLElement>('[data-tempo-marker-id="rit"]')!);
    expect(menuMock.tempoMarkerContextMenu).toHaveBeenCalledWith(expect.objectContaining({ id: "rit" }));
    fireEvent.click(container.querySelector<HTMLElement>('[data-meter-marker-id="two"]')!);
    expect(menuMock.timeSignatureMarkerContextMenu).toHaveBeenCalledWith(expect.objectContaining({ id: "two" }));
    const cell = screen.getByLabelText("setlistView.tempo.lane");
    Object.defineProperty(cell, "offsetWidth", { configurable: true, value: 1000 });
    cell.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 48, right: 1000, bottom: 48 }) as DOMRect;
    fireEvent.contextMenu(cell, { clientX: 250 });
    expect(menuMock.rulerContextMenu).toHaveBeenCalledWith(25, null);
    fireEvent.click(screen.getByRole("button", { name: "setlistView.tempo.addTempo" }));
    expect(menuMock.changeTimelineBpmAt).toHaveBeenCalledWith(33);
    fireEvent.click(screen.getByRole("button", { name: "setlistView.tempo.addMeter" }));
    expect(menuMock.createTimeSignatureMarkerAt).toHaveBeenCalledWith(33);
  });

  // C4: nothing caches bars across a tempo change: the same drag lands on the
  // grid of the snapshot in force.
  it("after a tempo change, dragging snaps to the new bars", () => {
    const dragCue = (bpm: number) => {
      const menuMock = menus();
      const changed = { ...song, bpm, tempoMarkers: [] } as unknown as SongView;
      const { container, unmount } = render(<SongLanes {...props(menuMock, { song: changed })} />);
      const cue = container.querySelector<HTMLElement>('[data-lane-cue-id="c"]')!;
      fireEvent.pointerDown(cue, { button: 0, pointerId: 9, clientX: 100 });
      fireEvent.pointerMove(window, { pointerId: 9, clientX: 228 });
      fireEvent.pointerUp(window, { pointerId: 9, clientX: 228 });
      unmount();
      return (menuMock.moveAutomationCue.mock.calls[0] as unknown as [string, number])[1];
    };
    const at120 = dragCue(120);
    const at90 = dragCue(90);
    // 120 BPM: beats every 0.5 s; 90 BPM: every 2/3 s. Same gesture, other grid.
    expect(at120 % 0.5).toBeCloseTo(0, 6);
    expect((at90 / (60 / 90)) % 1).toBeCloseTo(0, 6);
    expect(at90).not.toBeCloseTo(at120, 3);
  });

  it.each(["medium", "short"] as const)("%s: the tempo lane is there", (layout) => {
    const { container } = render(<SongLanes {...props(menus(), { layout })} />);
    expect(container.querySelector(".lt-setlist-lane-row.is-tempo")).not.toBeNull();
  });
});
