import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTimelineUIStore } from "../uiStore";
import { SetlistView } from "./SetlistView";
import { INITIAL_SETLIST_STATE, useSetlistStore } from "./setlistStore";
import { testSetlistProps } from "./testBindings";
import { setlistTour } from "../../tutorial/tours/setlist";
import { TOUR_TARGETS, findTourTarget } from "../../tutorial/tourTargets";

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
  it("short: opens the waveform by default and can switch to the mixer and back", () => {
    const { container } = render(
      <SetlistView {...testSetlistProps()} layoutClass="short" />,
    );
    expect(zones(container)).toEqual(["songs", "overview"]);

    const toggle = screen.getByRole("button", { name: "setlistView.pane.mixer" });
    // A way to the other view, never lit: lit, «Mix» looked like the view you were in.
    expect(toggle.getAttribute("aria-pressed")).toBeNull();
    expect(toggle.classList.contains("is-active")).toBe(false);
    fireEvent.click(toggle);
    expect(zones(container)).toEqual(["songs", "mixer"]);
    const back = screen.getByRole("button", { name: "setlistView.pane.song" });
    expect(back.getAttribute("aria-pressed")).toBeNull();
    expect(back.classList.contains("is-active")).toBe(false);
    fireEvent.click(back);
    expect(zones(container)).toEqual(["songs", "overview"]);
  });

  // The iPhone report: the faders were too short. «Enlarge» hides the song
  // row so the console takes the whole view; it comes back with the same button.
  it("short: enlarging the console hides the songs, and shrinking brings them back", () => {
    useSetlistStore.getState().setShortPane("mixer");
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

  it.each(["wide", "medium"] as const)("%s keeps view controls above the full-width song list", (layoutClass) => {
    const { container } = render(<SetlistView {...testSetlistProps()} layoutClass={layoutClass} />);
    const songs = container.querySelector("[data-setlist-zone='songs']")!;
    const toolbar = songs.querySelector(".lt-setlist-song-toolbar")!;
    expect(toolbar).not.toBeNull();
    expect(toolbar.querySelector(".lt-setlist-edit-button")).not.toBeNull();
    expect(toolbar.nextElementSibling?.classList.contains("lt-setlist-songs")
      || toolbar.nextElementSibling?.classList.contains("lt-setlist-songs-resize")).toBe(true);
    expect(songs.querySelector(":scope > .lt-setlist-edit-button")).toBeNull();
    expect(songs.querySelector(":scope > .lt-setlist-pane-toggle")).toBeNull();
  });

  it.each(["automation", "midi", "video"] as const)(
    "wide keeps the track timeline visible while editing %s",
    (mode) => {
      const props = testSetlistProps();
      props.menus = { globalTrackListContextMenu: () => [] } as never;
      const { container } = render(<SetlistView {...props} layoutClass="wide" />);
      act(() => useSetlistStore.getState().setEditMode(mode));
      expect(container.querySelector("[data-setlist-zone='mixer'] .lt-setlist-lanes")).not.toBeNull();
    },
  );

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

  it("short: editing marks keeps the primary waveform and its handles, not a second scrub view", () => {
    const { container } = render(<SetlistView {...testSetlistProps()} layoutClass="short" />);
    act(() => useSetlistStore.getState().setShortPane("mixer"));
    act(() => useSetlistStore.getState().setEditMode("sections"));
    expect(zones(container)).toEqual(["songs", "overview", "drawer"]);
    expect(container.querySelector(".lt-setlist-view.is-wave-editing")).not.toBeNull();
    expect(container.querySelector("[data-setlist-zone='overview'] .lt-setlist-section-layer")).not.toBeNull();
    expect(container.querySelector(".lt-setlist-scrub-view")).toBeNull();
    expect(screen.getByRole("button", { name: "setlistView.sections.add" })).toBeTruthy();
    act(() => useSetlistStore.getState().setEditMode(null));
    expect(zones(container)).toEqual(["songs", "mixer"]);
  });
});

describe("SetlistView tour anchors (paso 19, C3)", () => {
  it.each(["wide", "medium"] as const)("%s: every Setlist tour step finds its control", (layoutClass) => {
    render(<SetlistView {...testSetlistProps()} layoutClass={layoutClass} />);
    const targets = setlistTour.steps
      .map((step) => step.target)
      .filter((target) => target && target !== TOUR_TARGETS.sideNavHelp);
    expect(targets.length).toBeGreaterThanOrEqual(4);
    for (const target of targets) {
      expect(findTourTarget(target!), target).not.toBeNull();
    }
  });

  it("every step opens the Setlist view", () => {
    expect(setlistTour.steps.every((step) => step.viewMode === "setlist")).toBe(true);
  });
});
