import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTimelineUIStore } from "../uiStore";
import { SetlistView } from "./SetlistView";
import { INITIAL_SETLIST_STATE, useSetlistStore } from "./setlistStore";
import { testSetlistProps } from "./testBindings";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const zones = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("[data-setlist-zone]")).map(
    (element) => element.getAttribute("data-setlist-zone"),
  );

beforeEach(() => useSetlistStore.setState(INITIAL_SETLIST_STATE));

describe("SetlistView skeleton", () => {
  it.each(["wide", "medium"] as const)(
    "%s stacks songs, the song band and the mixer",
    (layoutClass) => {
      const { container } = render(
        <SetlistView {...testSetlistProps()} layoutClass={layoutClass} />,
      );
      expect(zones(container)).toEqual(["songs", "overview", "mixer"]);
      expect(
        container.querySelector(`.lt-setlist-view.is-${layoutClass}`),
      ).not.toBeNull();
    },
  );

  it("short never shows the song band and the mixer at once: they are tabs", () => {
    const { container } = render(
      <SetlistView {...testSetlistProps()} layoutClass="short" />,
    );
    expect(zones(container)).toEqual(["songs", "overview"]);

    const mixTab = screen.getByRole("tab", { name: "setlistView.tabs.mix" });
    fireEvent.click(mixTab);
    expect(zones(container)).toEqual(["songs", "mixer"]);
    expect(mixTab.getAttribute("aria-selected")).toBe("true");
  });

  it.each(["wide", "medium", "short"] as const)(
    "%s shows the edit drawer only while editing",
    (layoutClass) => {
      const { container } = render(
        <SetlistView {...testSetlistProps()} layoutClass={layoutClass} />,
      );
      expect(zones(container)).not.toContain("drawer");
      act(() => useSetlistStore.getState().setEditMode("song"));
      expect(zones(container)).toContain("drawer");
    },
  );

  it("opens the section menu's «Position…» editor outside the DAW", () => {
    const props = testSetlistProps({
      sectionMarkers: [{ id: "m1", name: "Coro", startSeconds: 10 }],
    } as never);
    render(<SetlistView {...props} layoutClass="wide" />);
    expect(screen.queryByText("markerPosition.bar")).toBeNull();
    act(() => useTimelineUIStore.getState().setMarkerPositionEditorId("m1"));
    expect(screen.getByText("markerPosition.bar")).toBeTruthy();
    act(() => useTimelineUIStore.getState().setMarkerPositionEditorId(null));
  });

  it("the song band carries the sections; editing shows their handles on it", () => {
    const props = testSetlistProps({
      sectionMarkers: [{ id: "m1", name: "Coro", startSeconds: 10 }],
    } as never);
    const { container } = render(<SetlistView {...props} layoutClass="wide" />);
    const band = container.querySelector("[data-setlist-zone='overview']")!;
    expect(band.querySelector(".lt-setlist-overview")).not.toBeNull();
    expect(band.querySelector(".lt-setlist-map-block[data-block-id='m1']")).not.toBeNull();
    expect(band.querySelector(".lt-setlist-section-layer")).toBeNull();

    // Any edit mode, not only Sections: Song settings is the default one.
    act(() => useSetlistStore.getState().setEditMode("song"));
    expect(band.querySelector("[data-section-handle='m1']")).not.toBeNull();
    expect(band.querySelector("[data-section-handle='song-end']")).not.toBeNull();
  });

  it("right click on the waveform opens the DAW ruler menu at that point", () => {
    const openMenu = vi.fn();
    const rulerContextMenu = vi.fn(() => []);
    const props = { ...testSetlistProps(), menus: { openMenu, rulerContextMenu } as never };
    const { container } = render(<SetlistView {...props} layoutClass="wide" />);
    fireEvent.contextMenu(container.querySelector(".lt-setlist-overview")!);
    expect(rulerContextMenu).toHaveBeenCalledWith(expect.any(Number), null);
    expect(openMenu).toHaveBeenCalledWith(expect.anything(), "transport.menu.createMarker", []);
  });
});
