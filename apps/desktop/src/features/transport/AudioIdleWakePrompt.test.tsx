import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../../shared/i18n";
import { AudioIdleWakePrompt } from "./AudioIdleWakePrompt";

const api = vi.hoisted(() => ({
  wakeHandler: null as (() => void) | null,
  pending: false,
  takeAudioIdleWake: vi.fn(async () => {
    const value = api.pending;
    api.pending = false;
    return value;
  }),
  reopenAudioOutput: vi.fn(async () => {}),
  setAppHidden: vi.fn(async (_hidden: boolean) => {}),
}));

vi.mock("./desktopApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./desktopApi")>();
  return {
    ...actual,
    isTauriApp: true,
    listenToAudioIdleWake: vi.fn(async (handler: () => void) => {
      api.wakeHandler = handler;
      return () => {
        api.wakeHandler = null;
      };
    }),
    takeAudioIdleWake: api.takeAudioIdleWake,
    reopenAudioOutput: api.reopenAudioOutput,
    setAppHidden: api.setAppHidden,
    appendFrontendError: vi.fn(async () => {}),
  };
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("AudioIdleWakePrompt", () => {
  beforeEach(() => {
    api.pending = false;
    api.takeAudioIdleWake.mockClear();
    api.setAppHidden.mockClear();
    api.reopenAudioOutput.mockReset();
    api.reopenAudioOutput.mockImplementation(async () => {});
  });

  afterEach(() => {
    cleanup();
  });

  it("stays hidden while the app was not idle for long", async () => {
    render(<AudioIdleWakePrompt />);
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows on the wake event and reopens the output on Resume", async () => {
    render(<AudioIdleWakePrompt />);
    await flush();

    api.pending = true;
    act(() => api.wakeHandler?.());
    await flush();
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByRole("button"));
    await flush();
    expect(api.reopenAudioOutput).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows when the page becomes visible with a wake pending", async () => {
    render(<AudioIdleWakePrompt />);
    await flush();

    api.pending = true;
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("reports the window's visibility so desktop and iOS know when it is away", async () => {
    let state: DocumentVisibilityState = "visible";
    const spy = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => state);
    try {
      render(<AudioIdleWakePrompt />);
      await flush();
      expect(api.setAppHidden).toHaveBeenLastCalledWith(false);

      state = "hidden";
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(api.setAppHidden).toHaveBeenLastCalledWith(true);

      state = "visible";
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(api.setAppHidden).toHaveBeenLastCalledWith(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("stays open with a retry when reopening fails", async () => {
    api.pending = true;
    api.reopenAudioOutput.mockRejectedValueOnce(new Error("open failed"));
    render(<AudioIdleWakePrompt />);
    await flush();

    const [resume] = screen.getAllByRole("button");
    fireEvent.click(resume);
    await flush();
    expect(screen.getByRole("dialog")).toBeTruthy();
    // Close + Resume once it failed.
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });
});
