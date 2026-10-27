import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MobileTrackSelectionControls } from "./MobileTrackSelectionControls";
import { useClearSelectionOnOutsideClick } from "../hooks/useClearSelectionOnOutsideClick";
import { useTimelineUIStore } from "../uiStore";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  isMobileApp: true,
}));

describe("MobileTrackSelectionControls", () => {
  beforeEach(() => {
    useTimelineUIStore.setState({
      selectedTrackIds: [],
      areaSelectMode: false,
      trackReorderMode: false,
      expandedTrackId: null,
      selectionMixOpen: false,
    });
  });

  it("exposes tap-to-add multi-selection and makes it exclusive with moving", () => {
    render(<MobileTrackSelectionControls />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "mobileTrackActions.selectMultiple",
      }),
    );
    expect(useTimelineUIStore.getState().areaSelectMode).toBe(true);

    fireEvent.click(
      screen.getByRole("button", {
        name: "timelineToolbar.enableTrackReorder",
      }),
    );
    expect(useTimelineUIStore.getState().areaSelectMode).toBe(false);
    expect(useTimelineUIStore.getState().trackReorderMode).toBe(true);
    expect(
      screen.getByRole("button", {
        name: "timelineToolbar.disableTrackReorder",
      }),
    ).toBeTruthy();
  });

  it("clears the selected tracks from its visible selection controls", () => {
    useTimelineUIStore.getState().selectTrack(["one", "two"]);
    render(<MobileTrackSelectionControls />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "mobileTrackActions.clearSelection",
      }),
    );
    expect(useTimelineUIStore.getState().selectedTrackIds).toEqual([]);
  });

  it("uses the Setlist rail's existing action buttons without a toolbar wrapper", () => {
    const { container } = render(
      <MobileTrackSelectionControls placement="setlist-rail" />,
    );

    expect(container.querySelector(".lt-mobile-track-tools")).toBeNull();
    expect(container.querySelectorAll(".lt-setlist-mixer-action")).toHaveLength(2);
    expect(
      screen.getByRole("button", {
        name: "mobileTrackActions.selectMultiple",
      }).querySelector(".material-symbols-outlined")?.textContent,
    ).toBe("checklist");
  });

  it("keeps a multi-selection when enabling track movement in the Setlist rail", () => {
    renderHook(() => useClearSelectionOnOutsideClick());
    useTimelineUIStore.setState({
      selectedTrackIds: ["one", "two"],
      areaSelectMode: true,
    });
    render(<MobileTrackSelectionControls placement="setlist-rail" />);

    const moveButton = screen.getByRole("button", {
      name: "timelineToolbar.enableTrackReorder",
    });
    fireEvent.mouseDown(moveButton);
    fireEvent.click(moveButton);

    expect(useTimelineUIStore.getState().selectedTrackIds).toEqual(["one", "two"]);
    expect(useTimelineUIStore.getState().areaSelectMode).toBe(false);
    expect(useTimelineUIStore.getState().trackReorderMode).toBe(true);
  });
});
