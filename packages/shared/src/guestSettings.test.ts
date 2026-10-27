import { describe, expect, it, vi } from "vitest";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "./models";
import { createGuestSettingsBridge } from "./guestSettings";

function setup(canEdit = true) {
  let localSettings: AppSettings = {
    ...DEFAULT_APP_SETTINGS, locale: "es", selectedOutputDevice: "guest",
  };
  let hostSettings: AppSettings = {
    ...DEFAULT_APP_SETTINGS, locale: "en", selectedOutputDevice: "host",
  };
  const local = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "save_settings") localSettings = args?.settings as AppSettings;
    return { ...localSettings };
  });
  const host = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "save_settings") hostSettings = args?.settings as AppSettings;
    return { ...hostSettings };
  });
  return {
    bridge: createGuestSettingsBridge(local, host, () => canEdit),
    local, host,
    localSettings: () => localSettings,
    hostSettings: () => hostSettings,
    updateHost: (patch: Partial<AppSettings>) => { hostSettings = { ...hostSettings, ...patch }; },
  };
}

describe("guest settings", () => {
  it("reads the host session with this device's language and navigation", async () => {
    const { bridge } = setup();
    const settings = await bridge.read();
    expect(settings.locale).toBe("es");
    expect(settings.selectedOutputDevice).toBe("host");
  });

  it("persists preferences locally without sending a host save (including viewers)", async () => {
    const state = setup(false);
    const settings = await state.bridge.read();
    const saved = await state.bridge.save({ ...settings, locale: "en", timelinePlayheadFollowMode: "center" });
    expect(saved.locale).toBe("en");
    expect(state.localSettings().locale).toBe("en");
    expect(state.localSettings().selectedOutputDevice).toBe("guest");
    expect(state.host.mock.calls.filter(([command]) => command === "save_settings")).toHaveLength(0);
    expect(state.hostSettings().selectedOutputDevice).toBe("host");
  });

  it("saves meter measurement mode on the host engine, not the guest", async () => {
    const state = setup();
    const settings = await state.bridge.read();
    const saved = await state.bridge.save({ ...settings, trackMeterMode: "preFader" });
    expect(saved.trackMeterMode).toBe("preFader");
    expect(state.hostSettings().trackMeterMode).toBe("preFader");
    expect(state.localSettings().trackMeterMode).toBe(DEFAULT_APP_SETTINGS.trackMeterMode);
  });

  it("rejects controller mix-setting changes instead of silently ignoring them", async () => {
    const state = setup(false);
    const settings = await state.bridge.read();
    await expect(state.bridge.save({ ...settings, metronomeEnabled: !settings.metronomeEnabled }))
      .rejects.toThrow("guest:forbidden");
    await expect(state.bridge.save({ ...settings, trackMeterMode: "preFader" }))
      .rejects.toThrow("guest:forbidden");
    expect(state.host.mock.calls.filter(([command]) => command === "save_settings")).toHaveLength(0);
  });

  it("saves playback settings on the host without overwriting concurrent changes", async () => {
    const state = setup();
    const settings = await state.bridge.read();
    state.updateHost({ globalJumpBars: 16 });
    const saved = await state.bridge.save({
      ...settings, pauseAtSongEnd: !settings.pauseAtSongEnd,
      vampBetweenSongs: !settings.vampBetweenSongs, fadeOutStopSeconds: 8,
    });
    expect(saved.globalJumpBars).toBe(16);
    expect(saved.pauseAtSongEnd).toBe(!settings.pauseAtSongEnd);
    expect(saved.vampBetweenSongs).toBe(!settings.vampBetweenSongs);
    expect(saved.fadeOutStopSeconds).toBe(8);
    expect(state.local.mock.calls.filter(([command]) => command === "save_settings")).toHaveLength(0);
  });

  it("keeps local preferences when a host update or realtime reply arrives", async () => {
    const state = setup();
    await state.bridge.read();
    const saved = await state.bridge.overlay({ ...DEFAULT_APP_SETTINGS, locale: "en", vampBars: 8 });
    expect(saved.locale).toBe("es");
    expect(saved.vampBars).toBe(8);
  });

  it("rejects unsupported configuration changes instead of reporting success", async () => {
    const state = setup();
    const settings = await state.bridge.read();
    await expect(state.bridge.save({ ...settings, selectedOutputDevice: "other" }))
      .rejects.toThrow("guest:notAvailable");
    expect(state.host.mock.calls.filter(([command]) => command === "save_settings")).toHaveLength(0);
    expect(state.local.mock.calls.filter(([command]) => command === "save_settings")).toHaveLength(0);
  });
});
