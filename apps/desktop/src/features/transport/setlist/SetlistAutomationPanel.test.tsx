import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AutomationCueSummary, SongView } from "@libretracks/shared/models";

import type { TimelineMenus } from "../menus/timelineMenus";
import { useTimelineUIStore } from "../uiStore";
import { SetlistAutomationPanel } from "./SetlistAutomationPanel";
import { testRegion } from "./testBindings";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.name ? `${key}:${String(options.name)}` : key,
  }),
}));

const cue = (id: string, atSeconds: number, enabled = true) =>
  ({ id, name: `Cue ${id}`, atSeconds, enabled, actions: [{ type: "wait", durationSeconds: 2 }] }) as AutomationCueSummary;

// 4/4 at 120 BPM (2 s bars) until 8 s, then 6/8 (1.5 s bars at 120 BPM),
// then 60 BPM from 11 s (bars of 3 s).
const region = testRegion("r", { startSeconds: 0, endSeconds: 30 });
const song = {
  bpm: 120,
  timeSignature: "4/4",
  tempoMarkers: [{ id: "slow", startSeconds: 11, bpm: 60 }],
  timeSignatureMarkers: [{ id: "six", startSeconds: 8, signature: "6/8" }],
  regions: [region],
  clips: [],
  tracks: [],
  sectionMarkers: [
    { id: "v", name: "Verso", kind: "verse", startSeconds: 0 },
    { id: "c", name: "Coro", kind: "chorus", startSeconds: 8 },
  ],
  automationCues: [cue("late", 14), cue("first", 2), cue("six", 9.5, false), cue("other-song", 40)],
} as unknown as SongView;

function menus() {
  return {
    openMenu: vi.fn(),
    createAutomationCueAt: vi.fn(),
    editAutomationCue: vi.fn(),
    automationCueContextMenu: vi.fn(() => [{ label: "x" }]),
    openMixScenes: vi.fn(),
    automationTrackContextMenu: vi.fn(() => [{ label: "transport.automation.removeTrack" }]),
    setAutomationTrackOn: vi.fn(),
    handleAddAutomationTrack: vi.fn(),
  };
}

beforeEach(() => useTimelineUIStore.setState({ snapEnabled: true }));

const rows = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>(".lt-setlist-automation-item"));

describe("SetlistAutomationPanel", () => {
  it("lists the song's cues in time order with their bar position and section", () => {
    const { container } = render(
      <SetlistAutomationPanel song={song} region={region} layout="short" menus={menus() as unknown as TimelineMenus} positionSecondsRef={{ current: 0 }} waveformSummaries={{}} onSeek={vi.fn()} runShortcutAction={vi.fn()} />,
    );
    const items = rows(container);
    expect(items.map((item) => item.querySelector(".lt-setlist-automation-name")?.textContent)).toEqual([
      "Cue first",
      "Cue six",
      "Cue late",
    ]);
    const position = (item: HTMLElement) => item.querySelector(".lt-setlist-sections-position")?.textContent ?? "";
    // 2 s = bar 2 in 4/4.
    expect(position(items[0]).startsWith("2.1")).toBe(true);
    // 8 s starts bar 5 in 6/8; 9.5 s is bar 6.
    expect(position(items[1]).startsWith("6.1")).toBe(true);
    // 6/8 bars at 8, 9.5 and 11 s (bar 7); then 60 BPM makes a bar 3 s:
    // 14 s starts bar 8.
    expect(position(items[2]).startsWith("8.1")).toBe(true);
    expect(within(items[0]).getByText("Verso")).toBeTruthy();
    expect(within(items[2]).getByText("Coro")).toBeTruthy();
    expect(items[1].classList.contains("is-off")).toBe(true);
  });

  it("every action is the DAW's: create at the playhead or the section start, edit, menu, scenes", () => {
    const menuMock = menus();
    const { container } = render(
      <SetlistAutomationPanel song={song} region={region} layout="wide" menus={menuMock as unknown as TimelineMenus} positionSecondsRef={{ current: 10 }} waveformSummaries={{}} onSeek={vi.fn()} runShortcutAction={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /setlistView.automation.add$/ }));
    expect(menuMock.createAutomationCueAt).toHaveBeenLastCalledWith(10);
    fireEvent.click(screen.getByRole("button", { name: /setlistView.automation.addAtSection$/ }));
    expect(menuMock.createAutomationCueAt).toHaveBeenLastCalledWith(8);
    fireEvent.click(rows(container)[0].querySelector<HTMLElement>(".lt-setlist-automation-main")!);
    expect(menuMock.editAutomationCue).toHaveBeenCalledWith(expect.objectContaining({ id: "first" }));
    fireEvent.click(screen.getByRole("button", { name: "setlistView.sections.menu:Cue late" }));
    expect(menuMock.automationCueContextMenu).toHaveBeenCalledWith(expect.objectContaining({ id: "late" }));
    fireEvent.click(screen.getByRole("button", { name: /setlistView.automation.scenes$/ }));
    expect(menuMock.openMixScenes).toHaveBeenCalled();
  });

  // The iPhone report: the list alone gave no idea where the cues go. They
  // sit on the song's waveform, and tapping one edits it.
  it("the cues sit on the waveform; tapping one edits it", () => {
    const menuMock = menus();
    const { container } = render(
      <SetlistAutomationPanel song={song} region={region} layout="short" menus={menuMock as unknown as TimelineMenus} positionSecondsRef={{ current: 0 }} waveformSummaries={{}} onSeek={vi.fn()} runShortcutAction={vi.fn()} />,
    );
    const marks = Array.from(container.querySelectorAll<HTMLElement>(".lt-setlist-scrub-automation"));
    expect(marks.map((mark) => mark.textContent)).toEqual(["Cue first", "Cue six", "Cue late"]);
    expect(marks[1].classList.contains("is-off")).toBe(true);
    fireEvent.click(marks[2]);
    expect(menuMock.editAutomationCue).toHaveBeenCalledWith(expect.objectContaining({ id: "late" }));
  });
});

const renderPanel = (overrides: Partial<SongView> = {}, onSeek = vi.fn()) => {
  const menuMock = menus();
  render(
    <SetlistAutomationPanel song={{ ...song, ...overrides }} region={region} layout="short" menus={menuMock as unknown as TimelineMenus} positionSecondsRef={{ current: 0 }} waveformSummaries={{}} onSeek={onSeek} runShortcutAction={vi.fn()} />,
  );
  return menuMock;
};

describe("the automation track in the panel", () => {
  // The iPhone report: no way to turn it off or remove it from here.
  it("turns it on/off and opens the DAW's track menu (remove, scenes)", () => {
    const menuMock = renderPanel({ automationTrack: { afterTrackId: null, enabled: false } });
    fireEvent.click(screen.getByRole("button", { name: "setlistView.automation.turnOn" }));
    expect(menuMock.setAutomationTrackOn).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "setlistView.sections.menu:setlistView.automation.track" }));
    expect(menuMock.openMenu).toHaveBeenCalledWith(expect.anything(), "setlistView.automation.track", [
      { label: "transport.automation.removeTrack" },
    ]);
  });

  it("without one, offers to add it", () => {
    const menuMock = renderPanel({ automationTrack: null });
    fireEvent.click(screen.getByRole("button", { name: /setlistView.automation.addTrack/ }));
    expect(menuMock.handleAddAutomationTrack).toHaveBeenCalledWith(null);
  });
});

describe("snap on the waveform", () => {
  it("the toggle is the DAW's snap: on, a swipe lands on a bar; off, where it was left", () => {
    const original = window.PointerEvent;
    class TestPointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    }
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: TestPointerEvent });
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
    const onSeek = vi.fn();
    const { container } = render(
      <SetlistAutomationPanel song={song} region={region} layout="short" menus={menus() as unknown as TimelineMenus} positionSecondsRef={{ current: 0 }} waveformSummaries={{}} onSeek={onSeek} runShortcutAction={vi.fn()} />,
    );
    const viewport = container.querySelector<HTMLElement>(".lt-setlist-scrub-viewport")!;
    // 8 bars of 2 s across 400 px: 25 px/s. A 137.5 px swipe = 5.5 s.
    const swipe = (from: number, to: number) => {
      fireEvent.pointerDown(viewport, { pointerId: 1, clientX: from });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: to });
      fireEvent.pointerUp(window, { pointerId: 1, clientX: to });
    };
    swipe(300, 162.5);
    expect(onSeek).toHaveBeenLastCalledWith(6);

    const toggle = screen.getByRole("button", { name: "setlistView.scrub.snap" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(useTimelineUIStore.getState().snapEnabled).toBe(false);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    swipe(300, 287.5);
    expect(onSeek).toHaveBeenLastCalledWith(6.5);
    width.mockRestore();
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: original });
  });
});

