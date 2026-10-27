import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  invokeCommand, sessionEventName, setGuestMirrorMode, setGuestRole,
} from "@libretracks/shared/desktopApi";

const invoke = vi.fn(async () => null);
beforeEach(() => vi.stubGlobal("__TAURI_INTERNALS__", { invoke }));

afterEach(() => {
  setGuestMirrorMode(false);
  setGuestRole(null);
  invoke.mockClear();
  vi.unstubAllGlobals();
});

describe("guest command bridge", () => {
  it("refuses forbidden commands before sending them to the host", async () => {
    setGuestMirrorMode(true);
    setGuestRole("controller");
    await expect(invokeCommand("update_track_mix_realtime", { trackId: "t", volume: 0 }))
      .rejects.toThrow("guest:forbidden");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses the current role on every call, including revocation", async () => {
    setGuestMirrorMode(true);
    setGuestRole("editor");
    await invokeCommand("update_track_mix_realtime", { trackId: "t", volume: 1 });
    expect(invoke).toHaveBeenCalledWith("link_proxy_invoke", {
      command: "update_track_mix_realtime", args: { trackId: "t", volume: 1 },
    }, undefined);
    invoke.mockClear();
    setGuestRole("viewer");
    await expect(invokeCommand("play_transport")).rejects.toThrow("guest:forbidden");
    setGuestRole(null);
    await expect(invokeCommand("play_transport")).rejects.toThrow("guest:forbidden");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("sends video controls to the host and listens to its mirrored video events", async () => {
    setGuestMirrorMode(true);
    setGuestRole("controller");
    await invokeCommand("video_live_action", { action: "black" });
    expect(invoke).toHaveBeenCalledWith("link_proxy_invoke", {
      command: "video_live_action", args: { action: "black" },
    }, undefined);
    expect(sessionEventName("video:live-state")).toBe("link-mirror://video:live-state");
    expect(sessionEventName("video:output-status")).toBe("link-mirror://video:output-status");
  });

  it("leaves ordinary local-mode commands unchanged", async () => {
    setGuestMirrorMode(false);
    await invokeCommand("play_transport");
    expect(invoke).toHaveBeenCalledWith("play_transport", {}, undefined);
  });
});
