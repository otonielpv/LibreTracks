import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../../shared/i18n";
import { useSongStore } from "../transport/songStore";
import { AppCloseGuard, SAVED_NOTICE_MS } from "./AppCloseGuard";
import { requestAppClose } from "./appCloseService";

const api = vi.hoisted(() => ({
  closeHandler: null as (() => void) | null,
  saveProject: vi.fn(),
  exitApp: vi.fn(async () => {}),
  cancelAppClose: vi.fn(async () => {}),
}));

vi.mock("../transport/desktopApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../transport/desktopApi")>();
  return {
    ...actual,
    isTauriApp: true,
    isMobileApp: false,
    listenToAppCloseRequested: vi.fn(async (handler: () => void) => {
      api.closeHandler = handler;
      return () => {
        api.closeHandler = null;
      };
    }),
    saveProject: api.saveProject,
    exitApp: api.exitApp,
    cancelAppClose: api.cancelAppClose,
  };
});

function setSongLoaded(loaded: boolean) {
  useSongStore.setState({
    song: loaded ? ({ id: "song" } as never) : null,
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("AppCloseGuard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    api.saveProject.mockReset();
    api.exitApp.mockClear();
    api.cancelAppClose.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    setSongLoaded(false);
  });

  it("saves, shows the saved notice, then quits when the window X is pressed", async () => {
    setSongLoaded(true);
    api.saveProject.mockResolvedValue({ songFilePath: "/music/set.ltsession" });
    render(<AppCloseGuard />);
    await flush();

    await act(async () => {
      api.closeHandler?.();
    });
    await flush();

    expect(api.saveProject).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Project saved")).toBeTruthy();
    expect(screen.getByText(/\/music\/set\.ltsession/)).toBeTruthy();
    expect(api.exitApp).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(SAVED_NOTICE_MS);
    });
    expect(api.exitApp).toHaveBeenCalledTimes(1);
  });

  it("FILE > Exit goes through the same save-and-notify flow", async () => {
    setSongLoaded(true);
    api.saveProject.mockResolvedValue({ songFilePath: null });
    render(<AppCloseGuard />);
    await flush();

    await act(async () => {
      requestAppClose();
    });
    await flush();

    expect(screen.getByText("Project saved")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close now" }));
    expect(api.exitApp).toHaveBeenCalledTimes(1);
  });

  it("quits straight away when no session is open", async () => {
    setSongLoaded(false);
    render(<AppCloseGuard />);
    await flush();

    await act(async () => {
      requestAppClose();
    });

    expect(api.saveProject).not.toHaveBeenCalled();
    expect(api.exitApp).toHaveBeenCalledTimes(1);
  });

  it("does not close blindly when the save fails", async () => {
    setSongLoaded(true);
    api.saveProject.mockRejectedValue(new Error("disk full"));
    render(<AppCloseGuard />);
    await flush();

    await act(async () => {
      api.closeHandler?.();
    });
    await flush();

    expect(screen.getByText("The project could not be saved")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(SAVED_NOTICE_MS * 4);
    });
    expect(api.exitApp).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.cancelAppClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("The project could not be saved")).toBeNull();

    // A later close tries again instead of staying stuck.
    api.saveProject.mockResolvedValue({ songFilePath: null });
    await act(async () => {
      api.closeHandler?.();
    });
    await flush();
    expect(screen.getByText("Project saved")).toBeTruthy();
  });
});
