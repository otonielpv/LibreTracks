import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings,
  type AppSettings,
} from "@libretracks/shared/models";

import {
  createSettingsHandlers,
  type SettingsHandlerDeps,
} from "./settingsHandlers";

function setup(overrides: Partial<SettingsHandlerDeps> = {}) {
  const persistAudioSettings = vi.fn();
  const setEnabledOutputChannelsDraft = vi.fn();
  const appSettingsRef = { current: { ...DEFAULT_APP_SETTINGS } };

  const handlers = createSettingsHandlers({
    appSettingsRef,
    persistAudioSettings,
    getSelectedOutputChannelCount: () => 8,
    getAudioDeviceDescriptors: () => [],
    setMidiLearnFeedback: vi.fn(),
    setEnabledOutputChannelsDraft,
    t: (key) => key,
    translateLocaleMessage: (saved) => `locale:${saved.locale ?? "system"}`,
    ...overrides,
  });

  return {
    handlers,
    persistAudioSettings,
    setEnabledOutputChannelsDraft,
    appSettingsRef,
  };
}

/** The patch persistAudioSettings was last called with. */
function lastPatch(persist: ReturnType<typeof vi.fn>): AppSettings {
  return persist.mock.calls.at(-1)?.[0] as AppSettings;
}

describe("createSettingsHandlers", () => {
  it("reads the current appSettingsRef at call time, not at creation time", () => {
    const { handlers, persistAudioSettings, appSettingsRef } = setup();
    // Mutate the ref *after* the handlers were built.
    appSettingsRef.current = normalizeAppSettings({
      ...DEFAULT_APP_SETTINGS,
      vampBars: 99,
    });

    handlers.handleAudioSafeModeChange(true);

    const patch = lastPatch(persistAudioSettings);
    expect(patch.audioSafeMode).toBe(true);
    // The unrelated field from the mutated ref is preserved → ref read is live.
    expect(patch.vampBars).toBe(99);
  });

  it("handleAudioBackendChange clears the selected device", () => {
    const { handlers, persistAudioSettings } = setup();
    handlers.handleAudioBackendChange("wasapi");
    const patch = lastPatch(persistAudioSettings);
    expect(patch.selectedAudioBackend).toBe("wasapi");
    expect(patch.selectedOutputDevice).toBeNull();
    expect(patch.selectedOutputDeviceId).toBeNull();
    expect(patch.selectedOutputDeviceName).toBeNull();
  });

  it("handleAudioBackendChange maps an empty string to a null backend", () => {
    const { handlers, persistAudioSettings } = setup();
    handlers.handleAudioBackendChange("");
    expect(lastPatch(persistAudioSettings).selectedAudioBackend).toBeNull();
  });

  it("handleOutputBufferSizeChange uses a fixed size or falls back to default", () => {
    const { handlers, persistAudioSettings } = setup();
    handlers.handleOutputBufferSizeChange("256");
    expect(lastPatch(persistAudioSettings).outputBufferSize).toEqual({
      fixed: 256,
    });
    handlers.handleOutputBufferSizeChange("");
    expect(lastPatch(persistAudioSettings).outputBufferSize).toBe("default");
  });

  it("handleSelectAllOutputChannels fills the draft up to the channel count", () => {
    const { handlers, setEnabledOutputChannelsDraft } = setup({
      getSelectedOutputChannelCount: () => 4,
    });
    handlers.handleSelectAllOutputChannels();
    expect(setEnabledOutputChannelsDraft).toHaveBeenCalledWith([0, 1, 2, 3]);
  });

  it("handleClearOutputChannels empties the draft", () => {
    const { handlers, setEnabledOutputChannelsDraft } = setup();
    handlers.handleClearOutputChannels();
    expect(setEnabledOutputChannelsDraft).toHaveBeenCalledWith([]);
  });

  it("jump/vamp handlers floor and clamp bar counts to at least 1", () => {
    const { handlers, persistAudioSettings } = setup();
    handlers.handleGlobalJumpBarsChange(2.9);
    expect(lastPatch(persistAudioSettings).globalJumpBars).toBe(2);
    handlers.handleVampBarsChange(0);
    expect(lastPatch(persistAudioSettings).vampBars).toBe(1);
    handlers.handleSongJumpBarsChange(-5);
    expect(lastPatch(persistAudioSettings).songJumpBars).toBe(1);
  });

  it("handleResetMidiMappings clears mappings and the learn feedback toast", () => {
    const setMidiLearnFeedback = vi.fn();
    const { handlers, persistAudioSettings } = setup({ setMidiLearnFeedback });
    handlers.handleResetMidiMappings();
    expect(lastPatch(persistAudioSettings).midiMappings).toEqual({});
    expect(setMidiLearnFeedback).toHaveBeenCalledWith(null);
  });

  it("handleAudioOutputDeviceChange resets an unsupported sample rate to Auto", () => {
    const descriptor = {
      stableId: "dev-1",
      name: "Dev 1",
      maxOutputChannels: 2,
      supportedSampleRates: [48000],
    } as never;
    const { handlers, persistAudioSettings, appSettingsRef } = setup({
      getAudioDeviceDescriptors: () => [descriptor],
    });
    appSettingsRef.current = {
      ...DEFAULT_APP_SETTINGS,
      outputSampleRate: 96000, // not in supportedSampleRates
    };
    handlers.handleAudioOutputDeviceChange("dev-1");
    const patch = lastPatch(persistAudioSettings);
    expect(patch.selectedOutputDeviceId).toBe("dev-1");
    expect(patch.outputSampleRate).toBeNull();
  });

  it("handleLocaleChange forwards a null locale and a derived message", () => {
    const { handlers, persistAudioSettings } = setup();
    handlers.handleLocaleChange("");
    const [patch, message] = persistAudioSettings.mock.calls.at(-1)!;
    expect((patch as AppSettings).locale).toBeNull();
    expect((message as (s: AppSettings) => string)(DEFAULT_APP_SETTINGS)).toBe(
      "locale:system",
    );
  });
});
