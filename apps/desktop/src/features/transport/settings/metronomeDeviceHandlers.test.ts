import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
} from "@libretracks/shared/models";

import {
  createMetronomeDeviceHandlers,
  type MetronomeDeviceHandlerDeps,
} from "./metronomeDeviceHandlers";

function setup(overrides: Partial<MetronomeDeviceHandlerDeps> = {}) {
  const appSettingsRef = { current: { ...DEFAULT_APP_SETTINGS } };
  const metronomeLiveRequestIdRef = { current: 0 };
  // runAction here just awaits the action so the realtime/save chain runs.
  const runAction = vi.fn(async (action: () => Promise<void>) => {
    await action();
  });

  const deps: MetronomeDeviceHandlerDeps = {
    appSettingsRef,
    persistAudioSettings: vi.fn(),
    setAppSettings: vi.fn((s: AppSettings) => {
      appSettingsRef.current = s;
    }),
    setMetronomeVolumeDraft: vi.fn(),
    setIsSettingsLoading: vi.fn(),
    setIsMidiInputRefreshing: vi.fn(),
    setAudioDeviceDescriptors: vi.fn(),
    setAudioOutputChannelCounts: vi.fn(),
    setDefaultAudioOutputDevice: vi.fn(),
    setMidiInputDevices: vi.fn(),
    metronomeLiveRequestIdRef,
    isTauriApp: true,
    isMidiInputRefreshing: () => false,
    runAction,
    setStatus: vi.fn(),
    formatErrorStatus: (error: unknown) => `error:${String(error)}`,
    t: (key) => key,
    getAudioOutputDevices: vi.fn(async () => ({
      deviceDescriptors: [],
      channelCounts: {},
      defaultDevice: null,
    })),
    getMidiInputs: vi.fn(async () => []),
    setMetronomeSoundRealtime: vi.fn(async (s: AppSettings) => s),
    setMetronomeEnabledRealtime: vi.fn(async () => {}),
    setMetronomeVolumeRealtime: vi.fn(async () => {}),
    setVoiceGuideConfigRealtime: vi.fn(async (s: AppSettings) => s),
    setPadConfigRealtime: vi.fn(async (s: AppSettings) => s),
    loadPadKey: vi.fn(async (s: AppSettings) => s),
    saveSettings: vi.fn(async (s: AppSettings) => s),
    ...overrides,
  };

  return { handlers: createMetronomeDeviceHandlers(deps), deps, appSettingsRef };
}

describe("createMetronomeDeviceHandlers", () => {
  it("handleMetronomeEnabledChange applies locally then persists via saveSettings", async () => {
    const { handlers, deps } = setup();
    handlers.handleMetronomeEnabledChange(true);
    // applyLocal happens synchronously.
    const firstApply = (deps.setAppSettings as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as AppSettings;
    expect(firstApply.metronomeEnabled).toBe(true);

    await Promise.resolve();
    await Promise.resolve();
    expect(deps.setMetronomeEnabledRealtime).toHaveBeenCalledWith(true);
    expect(deps.saveSettings).toHaveBeenCalled();
  });

  it("handleMetronomeVolumeDraftChange does NOT reopen the device (no saveSettings)", () => {
    const { handlers, deps } = setup();
    handlers.handleMetronomeVolumeDraftChange(0.4);
    expect(deps.setMetronomeVolumeDraft).toHaveBeenCalledWith(0.4);
    expect(deps.setMetronomeVolumeRealtime).toHaveBeenCalledWith(0.4);
    // Live drag path must not hit the persist/reopen path.
    expect(deps.saveSettings).not.toHaveBeenCalled();
  });

  it("volume draft clamps to [0, +20 dB headroom]", () => {
    const { handlers, deps } = setup();
    // The click fader reaches +20 dB (linear gain ≈ 10); values within that
    // headroom pass through, values above it clamp to it.
    handlers.handleMetronomeVolumeDraftChange(5);
    expect(deps.setMetronomeVolumeRealtime).toHaveBeenLastCalledWith(5);
    handlers.handleMetronomeVolumeDraftChange(50);
    expect(deps.setMetronomeVolumeRealtime).toHaveBeenLastCalledWith(10);
    handlers.handleMetronomeVolumeDraftChange(-2);
    expect(deps.setMetronomeVolumeRealtime).toHaveBeenLastCalledWith(0);
  });

  it("stale realtime volume responses are ignored (request-id guard)", async () => {
    let resolveFirst: (() => void) | undefined;
    const setMetronomeVolumeRealtime = vi
      .fn()
      // First call hangs until we resolve it; second resolves immediately.
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => (resolveFirst = resolve)),
      )
      .mockImplementationOnce(() => Promise.resolve());
    const setStatus = vi.fn();
    const { handlers } = setup({ setMetronomeVolumeRealtime, setStatus });

    handlers.handleMetronomeVolumeDraftChange(0.3); // request 1 (pending)
    handlers.handleMetronomeVolumeDraftChange(0.6); // request 2 (latest)
    // Now let request 1 reject-ish path settle; it should be a no-op because
    // it is no longer the latest request id.
    resolveFirst?.();
    await Promise.resolve();
    // No error surfaced from the superseded request.
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("handleRefreshMidiInputDevices is a no-op while already refreshing", async () => {
    const getMidiInputs = vi.fn(async () => ["dev"]);
    const { handlers, deps } = setup({
      isMidiInputRefreshing: () => true,
      getMidiInputs,
    });
    await handlers.handleRefreshMidiInputDevices();
    expect(getMidiInputs).not.toHaveBeenCalled();
    expect(deps.setIsMidiInputRefreshing).not.toHaveBeenCalled();
  });

  it("handleRefreshAudioDevices fans device data into the right setters", async () => {
    const getAudioOutputDevices = vi.fn(async () => ({
      deviceDescriptors: [{ stableId: "a" }] as never,
      channelCounts: { a: 2 },
      defaultDevice: "a",
    }));
    const { handlers, deps } = setup({ getAudioOutputDevices });
    handlers.handleRefreshAudioDevices();
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.setAudioOutputChannelCounts).toHaveBeenCalledWith({ a: 2 });
    expect(deps.setDefaultAudioOutputDevice).toHaveBeenCalledWith("a");
    expect(deps.setIsSettingsLoading).toHaveBeenLastCalledWith(false);
  });
});
