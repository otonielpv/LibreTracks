import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  isTauriApp: false,
}));

import i18n from "../../../shared/i18n";
import type { VideoOutputStatus } from "../desktopApi";
import { VideoOutputBadge } from "./VideoOutputBadge";
import { INITIAL_VIDEO_STATE, useVideoStore } from "./videoStore";

function status(state: VideoOutputStatus["state"], extra: Partial<VideoOutputStatus> = {}) {
  return {
    state,
    visibleSlot: "a",
    players: [] as unknown as VideoOutputStatus["players"],
    brightness: 0,
    sharesAppDisplay: false,
    monitorName: "\\.\DISPLAY2",
    opens: 1,
    ...extra,
  } satisfies VideoOutputStatus;
}

beforeEach(async () => {
  useVideoStore.setState(INITIAL_VIDEO_STATE);
  await i18n.changeLanguage("en");
});

describe("VideoOutputBadge", () => {
  it("shows nothing while the output is off", () => {
    const { container } = render(<VideoOutputBadge />);
    expect(container.textContent).toBe("");
    act(() => useVideoStore.getState().setOutputStatus(status({ state: "disabled" })));
    expect(container.textContent).toBe("");
  });

  it("names the display without the Windows device prefix", () => {
    render(<VideoOutputBadge />);
    act(() => useVideoStore.getState().setOutputStatus(status({ state: "ready" })));
    expect(screen.getByRole("status").textContent).toContain("DISPLAY2 · OK");
  });

  it("warns when the display is gone or libmpv is missing", () => {
    render(<VideoOutputBadge />);
    act(() => useVideoStore.getState().setOutputStatus(status({ state: "displayLost" })));
    expect(screen.getByRole("status").textContent).toContain("display disconnected");
    act(() =>
      useVideoStore
        .getState()
        .setOutputStatus(status({ state: "unavailable", detail: "libmpv-2.dll: not found" })),
    );
    expect(screen.getByRole("status").getAttribute("title")).toContain("libmpv-2.dll");
  });

  it("says BLACK loudly while forced black", () => {
    render(<VideoOutputBadge />);
    act(() => {
      useVideoStore.getState().setOutputStatus(status({ state: "ready" }));
      useVideoStore.getState().setForcedBlack(true);
    });
    expect(screen.getByRole("status").textContent).toContain("BLACKED OUT");
  });
});
