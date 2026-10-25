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
    "%s stacks songs, map, overview and mixer",
    (layoutClass) => {
      const { container } = render(
        <SetlistView {...testSetlistProps()} layoutClass={layoutClass} />,
      );
      expect(zones(container)).toEqual(["songs", "map", "overview", "mixer"]);
      expect(
        container.querySelector(`.lt-setlist-view.is-${layoutClass}`),
      ).not.toBeNull();
    },
  );

  it("short never shows the map and the mixer at once: they are tabs", () => {
    const { container } = render(
      <SetlistView {...testSetlistProps()} layoutClass="short" />,
    );
    expect(zones(container)).toEqual(["songs", "map", "overview"]);

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
});
