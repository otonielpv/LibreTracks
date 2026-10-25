import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { MidiClipSummary, SongView, TrackSummary } from "@libretracks/shared/models";

import { resetFrameGateForTests } from "../../frameGate";
import type { TimelineMenus } from "../../menus/timelineMenus";
import { useTimelineUIStore } from "../../uiStore";
import { INITIAL_SETLIST_STATE, useSetlistStore } from "../setlistStore";
import { testRegion } from "../testBindings";
import { midiClipSummary, midiEventLabel } from "./MidiLane";
import { SongLanes } from "./SongLanes";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.name ? `${key}:${String(options.name)}` : key,
  }),
}));

// Song from 0 to 100 s at 120 BPM 4/4, 1000 px wide: 10 px/s.
const region = testRegion("r", { startSeconds: 0, endSeconds: 100 });
const track = (id: string, kind: TrackSummary["kind"], extra: Partial<TrackSummary> = {}) =>
  ({ id, name: id, kind, depth: 0, hasChildren: false, volume: 1, pan: 0, muted: false, solo: false, audioTo: "m", transposeEnabled: true, ...extra }) as TrackSummary;
const midiClip = (id: string, trackId: string, timelineStartSeconds: number): MidiClipSummary => ({
  id,
  trackId,
  timelineStartSeconds,
  name: `Clip ${id}`,
  events: [
    { id: "e1", atSeconds: 0, kind: { type: "programChange", program: 12 } },
    { id: "e2", atSeconds: 0.1, kind: { type: "controlChange", controller: 64, value: 127 } },
  ],
});
const tracks = [
  track("lights", "midi", { midiPort: "IAC", midiChannel: 3 }),
  track("propresenter", "midi", { midiEnabled: false }),
  track("drums", "audio"),
];
const song = {
  bpm: 120,
  timeSignature: "4/4",
  tempoMarkers: [],
  timeSignatureMarkers: [],
  regions: [region],
  sectionMarkers: [{ id: "chorus", name: "Coro", kind: "chorus", startSeconds: 40 }],
  tracks,
  clips: [],
  midiClips: [midiClip("m1", "lights", 20), midiClip("other", "lights", 150)],
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
    createMidiClipAt: vi.fn(),
    editMidiClip: vi.fn(),
    openMidiClipMenu: vi.fn(),
    midiLaneContextMenu: vi.fn(() => [{ label: "lane" }]),
    moveMidiClip: vi.fn(),
    toggleMidiTrackEnabled: vi.fn(),
    openMidiRouteEditor: vi.fn(),
    openMidiSettings: vi.fn(),
    handleAddAutomationTrack: vi.fn(),
  };
}

type LanesProps = ComponentProps<typeof SongLanes>;
function props(menuMock = menus(), overrides: Partial<LanesProps> = {}): LanesProps {
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

const block = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-lane-midi-clip-id="${id}"]`)!;
const lane = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`.lt-setlist-lane[data-lane-track-id="${id}"]`)!;

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
  useTimelineUIStore.setState({ snapEnabled: false });
});
afterEach(() => vi.unstubAllGlobals());

describe("MIDI summaries", () => {
  it("one short label per message, the first three of a clip and a count", () => {
    expect(midiEventLabel({ type: "programChange", program: 12 })).toBe("PC 12");
    expect(midiEventLabel({ type: "controlChange", controller: 64, value: 127 })).toBe("CC 64=127");
    expect(midiEventLabel({ type: "controlCurve", controller: 7, fromValue: 0, toValue: 127, durationSeconds: 2 })).toBe("CC 7 0→127");
    expect(midiEventLabel({ type: "note", note: 60, velocity: 100, durationSeconds: 1 })).toBe("C4");
    const many = Array.from({ length: 5 }, (_, index) => ({
      id: `e${index}`,
      atSeconds: 5 - index,
      kind: { type: "programChange" as const, program: index },
    }));
    expect(midiClipSummary({ events: many })).toBe("PC 4 · PC 3 · PC 2 +2");
  });
});

describe("MIDI lane", () => {
  it("every MIDI track gets a row (even without clips here); clips sit at their time", () => {
    const { container } = render(<SongLanes {...props()} />);
    expect(lane(container, "lights")).not.toBeNull();
    expect(lane(container, "propresenter")).not.toBeNull();
    expect(lane(container, "propresenter").classList.contains("is-disabled")).toBe(true);
    // The audio track has nothing in this song: no row.
    expect(lane(container, "drums")).toBeNull();
    expect(block(container, "m1").style.left).toBe("200px");
    expect(block(container, "m1").textContent).toContain("PC 12 · CC 64=127");
    expect(block(container, "other")).toBeNull();
  });

  it("a click edits; a drag moves with ONE call on release; Esc cancels", () => {
    const menuMock = menus();
    const { container } = render(<SongLanes {...props(menuMock)} />);
    const element = block(container, "m1");
    fireEvent.pointerDown(element, { button: 0, pointerId: 1, clientX: 200 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 200 });
    expect(menuMock.editMidiClip).toHaveBeenCalledWith(expect.objectContaining({ id: "m1" }));

    fireEvent.pointerDown(element, { button: 0, pointerId: 2, clientX: 200 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 300 });
    expect(element.style.transform).toBe("translate3d(100px, 0, 0)");
    expect(menuMock.moveMidiClip).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 300 });
    expect(menuMock.moveMidiClip).toHaveBeenCalledTimes(1);
    expect(menuMock.moveMidiClip).toHaveBeenCalledWith("m1", 30, null);

    fireEvent.pointerDown(element, { button: 0, pointerId: 3, clientX: 200 });
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 260 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(window, { pointerId: 3, clientX: 260 });
    expect(menuMock.moveMidiClip).toHaveBeenCalledTimes(1);
  });

  it("dropped on another MIDI track, the same one call carries the new track", () => {
    const menuMock = menus();
    const { container } = render(<SongLanes {...props(menuMock)} />);
    const target = lane(container, "propresenter");
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => target) });
    const element = block(container, "m1");
    fireEvent.pointerDown(element, { button: 0, pointerId: 4, clientX: 200 });
    fireEvent.pointerMove(window, { pointerId: 4, clientX: 200, clientY: 90 });
    fireEvent.pointerMove(window, { pointerId: 4, clientX: 210, clientY: 90 });
    expect(target.classList.contains("is-drop-target")).toBe(true);
    fireEvent.pointerUp(window, { pointerId: 4, clientX: 210 });
    expect(menuMock.moveMidiClip).toHaveBeenCalledWith("m1", 21, "propresenter");
  });

  it("double click creates there; menus are the DAW's", () => {
    const menuMock = menus();
    const { container } = render(<SongLanes {...props(menuMock)} />);
    const cell = lane(container, "lights");
    Object.defineProperty(cell, "offsetWidth", { configurable: true, value: 1000 });
    cell.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 50, right: 1000, bottom: 50 }) as DOMRect;
    fireEvent.doubleClick(cell, { clientX: 455 });
    expect(menuMock.createMidiClipAt).toHaveBeenCalledWith("lights", 45.5);
    fireEvent.contextMenu(block(container, "m1"));
    expect(menuMock.openMidiClipMenu).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "m1" }));
    fireEvent.contextMenu(cell, { clientX: 100 });
    expect(menuMock.midiLaneContextMenu).toHaveBeenCalledWith("lights", 10);
  });

  it("the header: on/off, routing and MIDI settings are the DAW's commands", () => {
    const menuMock = menus();
    render(<SongLanes {...props(menuMock)} />);
    fireEvent.click(screen.getAllByRole("button", { name: "transport.midi.disableTrack" })[0]);
    expect(menuMock.toggleMidiTrackEnabled).toHaveBeenCalledWith("lights");
    fireEvent.click(screen.getByRole("button", { name: /setlistView.midi.routeAria:lights/ }));
    expect(menuMock.openMidiRouteEditor).toHaveBeenCalledWith("lights");
    fireEvent.click(screen.getAllByRole("button", { name: "setlistView.midi.settings" })[0]);
    expect(menuMock.openMidiSettings).toHaveBeenCalled();
  });

  // C1: at the playhead and at the start of its section.
  it("«+ MIDI» creates on the chosen track at the playhead or at the section start", () => {
    const menuMock = menus();
    render(<SongLanes {...props(menuMock)} />);
    fireEvent.click(screen.getByRole("button", { name: /setlistView.midi.add$/ }));
    const [, , actions] = menuMock.openMenu.mock.calls.at(-1) as unknown as [
      unknown,
      string,
      Array<{ label: string; onSelect: () => void }>,
    ];
    expect(actions.map((action) => action.label)).toEqual([
      "setlistView.midi.atPlayhead:lights",
      "setlistView.midi.atSection:lights",
      "setlistView.midi.atPlayhead:propresenter",
      "setlistView.midi.atSection:propresenter",
    ]);
    actions[0].onSelect();
    expect(menuMock.createMidiClipAt).toHaveBeenLastCalledWith("lights", 47);
    actions[1].onSelect();
    expect(menuMock.createMidiClipAt).toHaveBeenLastCalledWith("lights", 40);
  });

  it.each(["medium", "short"] as const)("%s: same lane", (layout) => {
    const { container } = render(<SongLanes {...props(menus(), { layout })} />);
    expect(within(lane(container, "lights")).getByText("Clip m1")).toBeTruthy();
  });
});
