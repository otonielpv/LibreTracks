import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AutomationCueSummary, SongView } from "@libretracks/shared/models";

import type { TimelineMenus } from "../menus/timelineMenus";
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
  };
}

const rows = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>(".lt-setlist-automation-item"));

describe("SetlistAutomationPanel", () => {
  it("lists the song's cues in time order with their bar position and section", () => {
    const { container } = render(
      <SetlistAutomationPanel song={song} region={region} layout="short" menus={menus() as unknown as TimelineMenus} positionSecondsRef={{ current: 0 }} />,
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
      <SetlistAutomationPanel song={song} region={region} layout="wide" menus={menuMock as unknown as TimelineMenus} positionSecondsRef={{ current: 10 }} />,
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
});
