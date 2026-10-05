import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  isTauriApp: false,
}));

const live = vi.hoisted(() => ({ runVideoLiveAction: vi.fn(async () => undefined) }));
vi.mock("./videoLive", () => live);

import i18n from "../../../shared/i18n";
import type { SongView, VideoOutputStatus } from "../desktopApi";
import { useSongStore } from "../songStore";
import { VideoOutputBadge } from "./VideoOutputBadge";
import { INITIAL_VIDEO_STATE, useVideoStore } from "./videoStore";

function status(state: VideoOutputStatus["state"], extra: Partial<VideoOutputStatus> = {}) {
  return {
    state,
    visibleSlot: "a",
    players: [] as unknown as VideoOutputStatus["players"],
    brightness: 0,
    sharesAppDisplay: false,
    monitorName: "\\\\.\\DISPLAY2",
    opens: 1,
    ...extra,
  } satisfies VideoOutputStatus;
}

function songWithVideo(hasVideo: boolean) {
  useSongStore.setState({
    song: { videoClips: hasVideo ? [{ id: "v1" }] : [] } as unknown as SongView,
  });
}

beforeEach(async () => {
  live.runVideoLiveAction.mockClear();
  useVideoStore.setState(INITIAL_VIDEO_STATE);
  songWithVideo(true);
  await i18n.changeLanguage("en");
});

describe("VideoOutputBadge", () => {
  it("is not there when the session has no video, whatever the output does", () => {
    songWithVideo(false);
    const { container } = render(<VideoOutputBadge />);
    act(() => useVideoStore.getState().setOutputStatus(status({ state: "ready" })));
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is only an icon when all is well, and a click hides the window", () => {
    render(<VideoOutputBadge />);
    act(() => useVideoStore.getState().setOutputStatus(status({ state: "ready" })));
    const button = screen.getByRole("button");
    expect(button.textContent).toBe("videocam");
    // The display is named in the tooltip, without the Windows device prefix.
    expect(button.getAttribute("title")).toContain("DISPLAY2 · OK");
    fireEvent.click(button);
    expect(live.runVideoLiveAction).toHaveBeenCalledWith("output");
  });

  it("after closing the window it stays, switched off, to bring it back", () => {
    render(<VideoOutputBadge />);
    act(() => useVideoStore.getState().setOutputStatus(status({ state: "disabled" })));
    const button = screen.getByRole("button");
    expect(button.textContent).toBe("videocam_off");
    expect(button.getAttribute("title")).toContain("Click to show it");
    fireEvent.click(button);
    expect(live.runVideoLiveAction).toHaveBeenCalledWith("output");
  });

  it("on a locked phone says the projector is off and how to get it back", () => {
    render(<VideoOutputBadge />);
    act(() => useVideoStore.getState().setOutputStatus(status({ state: "suspended" })));
    const button = screen.getByRole("button");
    expect(button.textContent).toContain("Projector off");
    expect(button.getAttribute("title")).toContain("Unlock it to bring it back");
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("spells out when the display is gone or libmpv is missing", () => {
    render(<VideoOutputBadge />);
    act(() => useVideoStore.getState().setOutputStatus(status({ state: "displayLost" })));
    expect(screen.getByRole("button").textContent).toContain("display disconnected");
    act(() =>
      useVideoStore
        .getState()
        .setOutputStatus(status({ state: "unavailable", detail: "libmpv-2.dll: not found" })),
    );
    expect(screen.getByRole("button").getAttribute("title")).toContain("libmpv-2.dll");
  });

  it("says BLACK loudly while forced black", () => {
    render(<VideoOutputBadge />);
    act(() => {
      useVideoStore.getState().setOutputStatus(status({ state: "ready" }));
      useVideoStore.getState().setForcedBlack(true);
    });
    expect(screen.getByRole("button").textContent).toContain("BLACKED OUT");
  });
});
