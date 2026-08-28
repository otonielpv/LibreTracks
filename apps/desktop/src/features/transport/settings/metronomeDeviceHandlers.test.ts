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
    setIsAudioRefreshing: vi.fn(),
    setAudioDeviceDescriptors: vi.fn(),
    setAudioOutputChannelCounts: vi.fn(),
    setDefaultAudioOutputDevice: vi.fn(),
    setMidiInputDevices: vi.fn(),
    setMidiOutputDevices: vi.fn(),
    metronomeLiveRequestIdRef,
    isTauriApp: true,
    isMidiInputRefreshing: () => false,
    isAudioRefreshing: () => false,
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
    getMidiOutputs: vi.fn(async () => []),
    sendMidiTestNote: vi.fn(async () => {}),
    setMetronomeSoundRealtime: vi.fn(async (s: AppSettings) => s),
    setMetronomeEnabledRealtime: vi.fn(async () => {}),
    setMetronomeVolumeRealtime: vi.fn(async () => {}),
    setVoiceGuideVolumeRealtime: vi.fn(async () => {}),
    setPadVolumeRealtime: vi.fn(async () => {}),
    setVoiceGuideConfigRealtime: vi.fn(async (s: AppSettings) => s),
    setPadConfigRealtime: vi.fn(async (s: AppSettings) => s),
    loadPadKey: vi.fn(async (s: AppSettings) => s),
    saveSettings: vi.fn(async (s: AppSettings) => s),
    ...overrides,
  };

  return { handlers: createMetronomeDeviceHandlers(deps), deps, appSettingsRef };
}

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

  it("volume draft clamps to [0, +20 dB headroom]", async () => {
    const { handlers, deps } = setup();
    // The click fader reaches +20 dB (linear gain ≈ 10); values within that
    // headroom pass through, values above it clamp to it.
    //
    // Awaiting between moves is not incidental: the draft path runs through a
    // last-wins stream (see ../latestWinsStream), so back-to-back moves are
    // deliberately coalesced into one backend call. Let each one land before
    // asserting on the next.
    handlers.handleMetronomeVolumeDraftChange(5);
    await flushMicrotasks();
    expect(deps.setMetronomeVolumeRealtime).toHaveBeenLastCalledWith(5);
    handlers.handleMetronomeVolumeDraftChange(50);
    await flushMicrotasks();
    expect(deps.setMetronomeVolumeRealtime).toHaveBeenLastCalledWith(10);
    handlers.handleMetronomeVolumeDraftChange(-2);
    await flushMicrotasks();
    expect(deps.setMetronomeVolumeRealtime).toHaveBeenLastCalledWith(0);
  });

  it("coalesces a volume drag into one backend call at a time", async () => {
    // A drag emits an event per pointer move. Each one takes the session lock
    // and reaches the engine, and `(async)` commands can be applied out of
    // order, so only one may be outstanding: first value out, last value last.
    let releaseFirst: (() => void) | undefined;
    const setMetronomeVolumeRealtime = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<void>((resolve) => (releaseFirst = resolve)),
      )
      .mockImplementation(() => Promise.resolve());
    const { handlers } = setup({ setMetronomeVolumeRealtime });

    handlers.handleMetronomeVolumeDraftChange(0.2);
    handlers.handleMetronomeVolumeDraftChange(0.4);
    handlers.handleMetronomeVolumeDraftChange(0.6);
    expect(setMetronomeVolumeRealtime.mock.calls).toEqual([[0.2]]);

    releaseFirst?.();
    await flushMicrotasks();
    expect(setMetronomeVolumeRealtime.mock.calls).toEqual([[0.2], [0.6]]);
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

  it("does not let an old voice-guide response move the optimistic slider backwards", async () => {
    let resolveFirst!: (settings: AppSettings) => void;
    const first = new Promise<AppSettings>((resolve) => {
      resolveFirst = resolve;
    });
    const setVoiceGuideConfigRealtime = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockImplementation(async (settings: AppSettings) => settings);
    const { handlers, appSettingsRef } = setup({ setVoiceGuideConfigRealtime });

    handlers.handleVoiceGuideChange({ voiceGuideVolume: 0.2 });
    handlers.handleVoiceGuideChange({ voiceGuideVolume: 0.8 });
    resolveFirst({ ...DEFAULT_APP_SETTINGS, voiceGuideVolume: 0.2 });
    await flushMicrotasks();

    expect(appSettingsRef.current.voiceGuideVolume).toBe(0.8);
    expect(setVoiceGuideConfigRealtime.mock.calls.map(([s]) => s.voiceGuideVolume)).toEqual([
      0.2,
      0.8,
    ]);
  });

  it.each([
    {
      name: "voice guide",
      draft: (handlers: ReturnType<typeof createMetronomeDeviceHandlers>, value: number) =>
        handlers.handleVoiceGuideVolumeDraftChange(value),
      commit: (handlers: ReturnType<typeof createMetronomeDeviceHandlers>, value: number) =>
        handlers.commitVoiceGuideVolumeDraft(value),
      fastKey: "setVoiceGuideVolumeRealtime" as const,
      fullKey: "setVoiceGuideConfigRealtime" as const,
      settingKey: "voiceGuideVolume" as const,
    },
    {
      name: "pad",
      draft: (handlers: ReturnType<typeof createMetronomeDeviceHandlers>, value: number) =>
        handlers.handlePadVolumeDraftChange(value),
      commit: (handlers: ReturnType<typeof createMetronomeDeviceHandlers>, value: number) =>
        handlers.commitPadVolumeDraft(value),
      fastKey: "setPadVolumeRealtime" as const,
      fullKey: "setPadConfigRealtime" as const,
      settingKey: "padVolume" as const,
    },
  ])("keeps $name volume live moves engine-only and persists the final value once", async ({
    draft,
    commit,
    fastKey,
    fullKey,
    settingKey,
  }) => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fast = vi.fn().mockReturnValueOnce(first).mockResolvedValue(undefined);
    const { handlers, deps, appSettingsRef } = setup({ [fastKey]: fast });

    draft(handlers, 0.2);
    draft(handlers, 0.4);
    commit(handlers, 0.7);

    expect(fast).toHaveBeenCalledTimes(1);
    expect(deps[fullKey]).not.toHaveBeenCalled();
    expect(appSettingsRef.current[settingKey]).toBe(0.7);

    releaseFirst();
    await flushMicrotasks();

    expect(fast).toHaveBeenCalledTimes(1);
    expect(deps[fullKey]).toHaveBeenCalledTimes(1);
    expect((deps[fullKey] as ReturnType<typeof vi.fn>).mock.calls[0][0][settingKey]).toBe(0.7);
    expect(deps.saveSettings).not.toHaveBeenCalled();
  });

  it("enabling a selected pad decodes its clip via loadPadKey (not just realtime config)", async () => {
    // Regression: the cheap realtime path never calls set_clip, so on the first
    // enable the renderer stayed silent until an unrelated key change. Enabling
    // must route through loadPadKey so the clip is actually decoded/swapped in.
    const appSettingsRef = {
      current: { ...DEFAULT_APP_SETTINGS, padId: "warm", padKey: 3 },
    };
    const { handlers, deps } = setup({ appSettingsRef });
    handlers.handlePadEnabledChange(true);
    await Promise.resolve();
    await Promise.resolve();
    const loadArg = (deps.loadPadKey as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as AppSettings;
    expect(loadArg.padEnabled).toBe(true);
    expect(deps.loadPadKey).toHaveBeenCalledTimes(1);
    expect(deps.setPadConfigRealtime).not.toHaveBeenCalled();
  });

  it("disabling the pad uses the cheap realtime path (silences immediately)", async () => {
    const appSettingsRef = {
      current: {
        ...DEFAULT_APP_SETTINGS,
        padId: "warm",
        padKey: 3,
        padEnabled: true,
      },
    };
    const { handlers, deps } = setup({ appSettingsRef });
    handlers.handlePadEnabledChange(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.loadPadKey).not.toHaveBeenCalled();
    expect(deps.setPadConfigRealtime).toHaveBeenCalledTimes(1);
  });

  it("enabling with no pad selected stays on the realtime path (nothing to decode)", async () => {
    const { handlers, deps } = setup();
    handlers.handlePadEnabledChange(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.loadPadKey).not.toHaveBeenCalled();
    expect(deps.setPadConfigRealtime).toHaveBeenCalledTimes(1);
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

  it("handleRefreshAudioDevices forces a rescan and toggles the refreshing flag", async () => {
    const getAudioOutputDevices = vi.fn(async () => ({
      deviceDescriptors: [],
      channelCounts: {},
      defaultDevice: null,
    }));
    const { handlers, deps } = setup({ getAudioOutputDevices });
    handlers.handleRefreshAudioDevices();
    await Promise.resolve();
    await Promise.resolve();
    // The button must send force:true so the backend re-scans the active
    // backend + reopens the device (the whole point of this fix).
    expect(getAudioOutputDevices).toHaveBeenCalledWith({ force: true });
    expect(deps.setIsAudioRefreshing).toHaveBeenNthCalledWith(1, true);
    expect(deps.setIsAudioRefreshing).toHaveBeenLastCalledWith(false);
  });

  it("handleRefreshAudioDevices is a no-op while already refreshing", async () => {
    const getAudioOutputDevices = vi.fn(async () => ({
      deviceDescriptors: [],
      channelCounts: {},
      defaultDevice: null,
    }));
    const { handlers, deps } = setup({
      isAudioRefreshing: () => true,
      getAudioOutputDevices,
    });
    handlers.handleRefreshAudioDevices();
    await Promise.resolve();
    expect(getAudioOutputDevices).not.toHaveBeenCalled();
    expect(deps.setIsAudioRefreshing).not.toHaveBeenCalled();
  });
});
