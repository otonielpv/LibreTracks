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

  // Playback on an iPhone: songs on top and, under them, the console or the
  // song's waveform, never both.
  it("short: songs and the console; «Waveform» swaps the console for the song band", () => {
    const { container } = render(
      <SetlistView {...testSetlistProps()} layoutClass="short" />,
    );
    expect(zones(container)).toEqual(["songs", "mixer"]);

    const toggle = screen.getByRole("button", { name: "setlistView.pane.song" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(zones(container)).toEqual(["songs", "overview"]);
    const back = screen.getByRole("button", { name: "setlistView.pane.mixer" });
    expect(back.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(back);
    expect(zones(container)).toEqual(["songs", "mixer"]);
  });

  // The iPhone report: the faders were too short. «Enlarge» hides the song
  // row so the console takes the whole view; it comes back with the same button.
  it("short: enlarging the console hides the songs, and shrinking brings them back", () => {
    const { container } = render(<SetlistView {...testSetlistProps()} layoutClass="short" />);
    fireEvent.click(screen.getByRole("button", { name: "setlistView.mixer.enlarge" }));
    expect(zones(container)).toEqual(["mixer"]);
    expect(container.querySelector(".lt-setlist-view.is-mixer-expanded")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "setlistView.mixer.shrink" }));
    expect(zones(container)).toEqual(["songs", "mixer"]);
  });

  it.each(["wide", "medium"] as const)("%s shows songs, band and console together", (layoutClass) => {
    const { container } = render(<SetlistView {...testSetlistProps()} layoutClass={layoutClass} />);
    expect(zones(container)).toEqual(["songs", "overview", "mixer"]);
    expect(screen.queryByRole("button", { name: "setlistView.pane.song" })).toBeNull();
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
