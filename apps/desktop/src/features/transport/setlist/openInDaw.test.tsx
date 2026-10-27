import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BASE_PIXELS_PER_SECOND } from "@libretracks/shared/timelineMath";

import { useTimelineUIStore } from "../uiStore";
import { DAW_FRAME_MARGIN, dawLaneWidth, frameRegionInDaw, openInDaw } from "./openInDaw";
import { ReturnToSetlistChip } from "./ReturnToSetlistChip";
import { SetlistView } from "./SetlistView";
import { INITIAL_SETLIST_STATE, useSetlistStore } from "./setlistStore";
import { testRegion, testSetlistProps } from "./testBindings";
import type { SongView } from "@libretracks/shared/models";
import type { TimelineMenus } from "../menus/timelineMenus";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.name ? `${key}:${String(options.name)}` : key,
  }),
}));
vi.mock("../tracks/TrackMeter", () => ({ SongMasterMeter: () => null, TrackMeter: () => null }));
vi.mock("../structure/ArrangementBadge", () => ({ ArrangementBadge: () => null }));

// The third song of a session: 60 s to 180 s.
const third = testRegion("c", { name: "Tercera", startSeconds: 60, endSeconds: 180 });

beforeEach(() => {
  useSetlistStore.setState(INITIAL_SETLIST_STATE);
  useTimelineUIStore.setState({ viewMode: "setlist", returnViewMode: null, cameraX: 0, zoomLevel: 1 });
});

describe("framing a song in the DAW", () => {
  it("fits the song in the lanes minus a margin each side, centred", () => {
    const width = 1000;
    const { zoomLevel, cameraX } = frameRegionInDaw(third, width);
    const pps = zoomLevel * BASE_PIXELS_PER_SECOND;
    // The song takes the width minus the margins…
    expect(120 * pps).toBeCloseTo(width * (1 - 2 * DAW_FRAME_MARGIN), 6);
    // …and its centre sits at the lanes' centre.
    expect(((60 + 180) / 2) * pps - cameraX).toBeCloseTo(width / 2, 6);
  });

  it("never before the timeline start, and within the DAW's zoom range", () => {
    expect(frameRegionInDaw({ startSeconds: 0, endSeconds: 10 }, 1000).cameraX).toBe(0);
    expect(frameRegionInDaw({ startSeconds: 0, endSeconds: 0.01 }, 1000).zoomLevel).toBeLessThanOrEqual(64);
  });

  it("uses the DAW's measured lanes, or guesses them before the DAW was ever shown", () => {
    expect(dawLaneWidth(1200, 1920)).toBe(1200);
    expect(dawLaneWidth(320, 1920)).toBe(1620);
  });
});

describe("Open in the DAW and back", () => {
  // C1
  it("selects, frames, switches to the DAW and remembers Setlist", () => {
    const selectRegion = vi.fn();
    openInDaw("c", { getRegion: () => third, getLaneViewportWidth: () => 1000, selectRegion });
    const ui = useTimelineUIStore.getState();
    const expected = frameRegionInDaw(third, 1000);
    expect(selectRegion).toHaveBeenCalledWith("c");
    expect(ui.viewMode).toBe("daw");
    expect(ui.zoomLevel).toBeCloseTo(expected.zoomLevel, 9);
    expect(ui.cameraX).toBeCloseTo(expected.cameraX, 9);
    expect(ui.returnViewMode).toBe("setlist");
  });

  // C2
  it("the chip shows only after opening from Setlist and goes back", () => {
    const { container } = render(<ReturnToSetlistChip />);
    expect(container.textContent).toBe("");
    act(() => openInDaw("c", { getRegion: () => third, getLaneViewportWidth: () => 1000, selectRegion: vi.fn() }));
    fireEvent.click(screen.getByRole("button", { name: /setlistView.daw.back/ }));
    expect(useTimelineUIStore.getState().viewMode).toBe("setlist");
    expect(useTimelineUIStore.getState().returnViewMode).toBeNull();
    expect(container.textContent).toBe("");
  });

  // C3
  it.each([
    ["the selector", () => useTimelineUIStore.getState().setViewMode("compact")],
    ["Tab", () => useTimelineUIStore.getState().toggleViewMode()],
    ["Shift+Tab", () => useTimelineUIStore.getState().toggleViewModeBackward()],
  ])("changing the view with %s clears the way back", (_name, change) => {
    openInDaw("c", { getRegion: () => third, getLaneViewportWidth: () => 1000, selectRegion: vi.fn() });
    act(() => change());
    expect(useTimelineUIStore.getState().returnViewMode).toBeNull();
  });

  it("a card's menu offers «Open in the DAW» first, then the DAW's song menu", () => {
    const onOpenInDaw = vi.fn();
    const openMenu = vi.fn();
    const menus = {
      openMenu,
      songRegionContextMenu: vi.fn(() => [{ label: "rename", onSelect: vi.fn() }]),
    } as unknown as TimelineMenus;
    const base = testSetlistProps({ regions: [third] } as Partial<SongView>);
    render(<SetlistView {...base} menus={menus} onOpenInDaw={onOpenInDaw} layoutClass="wide" />);
    fireEvent.contextMenu(document.querySelector<HTMLElement>('.lt-setlist-song-tile[data-region-id="c"]')!);
    const [, title, actions] = openMenu.mock.calls[0] as [unknown, string, Array<{ label: string; onSelect: () => void }>];
    expect(title).toBe("Tercera");
    expect(actions.map((action) => action.label)).toEqual(["setlistView.daw.open", "rename"]);
    actions[0].onSelect();
    expect(onOpenInDaw).toHaveBeenCalledWith("c");
  });
});
