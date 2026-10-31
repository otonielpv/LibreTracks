import { act, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SectionMarkerSummary, SongView } from "@libretracks/shared/models";

import { useKeybindingStore } from "../keyboard/keybindingStore";
import { useTransportStore } from "../store";
import { useTimelineKeyboardShortcuts } from "../timeline/TimelineKeyboardShortcuts";
import { useTimelineUIStore } from "../uiStore";
import { useSetlistKeyboard, type SetlistKeyboardBridge } from "./setlistKeyboard";
import { INITIAL_SETLIST_STATE, useSetlistStore } from "./setlistStore";
import { testRegion } from "./testBindings";

/**
 * Paso 19, C1: the Setlist performance keys go through the real dispatcher
 * (the window listener of useTimelineKeyboardShortcuts), not a copy of it.
 */

const r1 = testRegion("r1", { name: "Uno", startSeconds: 0, endSeconds: 60 });
const r2 = testRegion("r2", { name: "Dos", startSeconds: 60, endSeconds: 120 });
const marker = (id: string, startSeconds: number) =>
  ({ id, name: id, startSeconds, kind: "verse" }) as SectionMarkerSummary;
const verso = marker("Verso", 10);
const coro = marker("Coro", 30);
const song = {
  bpm: 120,
  timeSignature: "4/4",
  regions: [r1, r2],
  sectionMarkers: [verso, coro],
  tempoMarkers: [],
  timeSignatureMarkers: [],
} as unknown as SongView;

function dispatcherProps() {
  const noop = vi.fn();
  return {
    runAction: async (work: () => Promise<void>) => work(),
    applyPlaybackSnapshot: noop,
    snapshotRef: { current: null },
    song,
    selectedClipId: null,
    selectedClipIds: [],
    selectedTrackIds: [],
    selectedRegionId: null,
    openTopMenu: null,
    setOpenTopMenu: noop,
    setSelectedClipId: noop,
    clearSelection: noop,
    clearSelections: vi.fn(),
    copySelectedClips: () => false,
    duplicateSelectedClips: async () => false,
    pasteCopiedClips: async () => false,
    handleSaveProjectClick: noop,
    handleSaveProjectAsClick: noop,
    scheduleMarkerJumpWithGlobalMode: vi.fn(),
    scheduleRegionJumpWithOptions: vi.fn(),
    splitSongUnderCursor: async () => {},
    splitSelectedClipsUnderCursor: async () => false,
    selectAllClips: () => false,
    nudgeSelectedClips: vi.fn(async () => true),
    deleteSelectedRegion: async () => {},
    renameSelected: async () => {},
    setStatus: noop,
    t: (key: string) => key,
    toggleViewMode: noop,
    toggleViewModeBackward: noop,
  } as unknown as Parameters<typeof useTimelineKeyboardShortcuts>[0];
}

function makeBridge(overrides: Partial<SetlistKeyboardBridge> = {}): SetlistKeyboardBridge {
  return {
    regions: [r1, r2],
    shownRegion: r1,
    song,
    canControl: true,
    pendingMarkerId: null,
    positionSecondsRef: { current: 0 },
    startLabel: "Inicio",
    onSelectRegion: vi.fn(),
    onCueSong: vi.fn(),
    onPlaySong: vi.fn(),
    onMarkerAction: vi.fn(),
    onCancelPendingJump: vi.fn(),
    ...overrides,
  };
}

function BridgeHost({ bridge }: { bridge: SetlistKeyboardBridge }) {
  useSetlistKeyboard(bridge);
  return <button type="button">focus me</button>;
}

const press = (key: string, target: Element | Window = window) =>
  act(() => {
    fireEvent.keyDown(target, { key });
  });

beforeEach(() => {
  useTimelineUIStore.setState({ viewMode: "setlist", midiLearnMode: null });
  useSetlistStore.setState(INITIAL_SETLIST_STATE);
  useKeybindingStore.setState({ overrides: {} });
  useTransportStore.setState({ playback: null });
});

afterEach(() => {
  useTimelineUIStore.setState({ viewMode: "daw" });
});

describe("Setlist keyboard (paso 19)", () => {
  it("←/→ walk a section cursor and Enter jumps there, without nudging", () => {
    const props = dispatcherProps();
    renderHook(() => useTimelineKeyboardShortcuts(props));
    const bridge = makeBridge();
    render(<BridgeHost bridge={bridge} />);

    press("ArrowRight"); // from the implicit start → Verso
    press("ArrowRight"); // → Coro
    press("ArrowLeft"); // → Verso
    expect(useSetlistStore.getState().sectionCursorId).not.toBeNull();
    press("Enter");

    expect(bridge.onMarkerAction).toHaveBeenCalledWith(verso);
    expect(useSetlistStore.getState().sectionCursorId).toBeNull();
    expect(props.nudgeSelectedClips).not.toHaveBeenCalled();
  });

  it("Enter with no cursor plays the shown song, as on a focused card", () => {
    renderHook(() => useTimelineKeyboardShortcuts(dispatcherProps()));
    const bridge = makeBridge();
    render(<BridgeHost bridge={bridge} />);
    press("Enter");
    expect(bridge.onPlaySong).toHaveBeenCalledWith("r1", "Uno");
  });

  it("↑/↓ change song as a tap on its card does (select, and cue when stopped)", () => {
    renderHook(() => useTimelineKeyboardShortcuts(dispatcherProps()));
    const bridge = makeBridge();
    render(<BridgeHost bridge={bridge} />);
    press("ArrowDown");
    expect(bridge.onSelectRegion).toHaveBeenCalledWith("r2");
    expect(bridge.onCueSong).toHaveBeenCalledWith("r2");
    press("ArrowUp"); // already the first: nothing
    expect(bridge.onSelectRegion).toHaveBeenCalledTimes(1);
  });

  it("outside Setlist, or editing in it, the arrows still nudge clips", () => {
    const props = dispatcherProps();
    renderHook(() => useTimelineKeyboardShortcuts(props));
    render(<BridgeHost bridge={makeBridge()} />);

    act(() => useSetlistStore.setState({ editMode: "lanes" }));
    press("ArrowRight");
    act(() => {
      useTimelineUIStore.setState({ viewMode: "daw" });
      useSetlistStore.setState({ editMode: null });
    });
    press("ArrowLeft");

    expect(props.nudgeSelectedClips).toHaveBeenNthCalledWith(1, 1);
    expect(props.nudgeSelectedClips).toHaveBeenNthCalledWith(2, -1);
    expect(useSetlistStore.getState().sectionCursorId).toBeNull();
  });

  it("a focused button keeps Enter while there is no cursor", () => {
    renderHook(() => useTimelineKeyboardShortcuts(dispatcherProps()));
    const bridge = makeBridge();
    const { getByText } = render(<BridgeHost bridge={bridge} />);
    press("Enter", getByText("focus me"));
    expect(bridge.onPlaySong).not.toHaveBeenCalled();
  });

  it("with a cursor, Enter jumps even from the card or ▶ the click left focused", () => {
    renderHook(() => useTimelineKeyboardShortcuts(dispatcherProps()));
    const bridge = makeBridge();
    const { getByText } = render(<BridgeHost bridge={bridge} />);
    const button = getByText("focus me");
    press("ArrowRight", button);
    press("Enter", button);
    expect(bridge.onMarkerAction).toHaveBeenCalledWith(verso);
  });

  it("Esc drops the cursor before clearing the selection", () => {
    const props = dispatcherProps();
    renderHook(() => useTimelineKeyboardShortcuts(props));
    render(<BridgeHost bridge={makeBridge()} />);
    press("ArrowRight");
    press("Escape");
    expect(useSetlistStore.getState().sectionCursorId).toBeNull();
    expect(props.clearSelections).not.toHaveBeenCalled();
    press("Escape");
    expect(props.clearSelections).toHaveBeenCalledTimes(1);
  });

  it("changing the shown song clears the cursor", () => {
    renderHook(() => useTimelineKeyboardShortcuts(dispatcherProps()));
    const { rerender } = render(<BridgeHost bridge={makeBridge()} />);
    press("ArrowRight");
    expect(useSetlistStore.getState().sectionCursorId).not.toBeNull();
    rerender(<BridgeHost bridge={makeBridge({ shownRegion: r2 })} />);
    expect(useSetlistStore.getState().sectionCursorId).toBeNull();
  });

  it("«Open Setlist» switches the view once the user binds it", () => {
    act(() => useTimelineUIStore.setState({ viewMode: "daw" }));
    useKeybindingStore.setState({ overrides: { "view.setlist": "Ctrl+Shift+L" } });
    renderHook(() => useTimelineKeyboardShortcuts(dispatcherProps()));
    act(() => {
      fireEvent.keyDown(window, { key: "L", ctrlKey: true, shiftKey: true });
    });
    expect(useTimelineUIStore.getState().viewMode).toBe("setlist");
  });
});
