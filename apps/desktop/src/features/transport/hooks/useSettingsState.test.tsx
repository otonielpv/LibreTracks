import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APP_SETTINGS } from "@libretracks/shared/models";

import {
  getAudioOutputDevices,
  getMidiInputs,
  getMidiOutputs,
  getSettings,
} from "../desktopApi";
import { useSettingsState } from "./useSettingsState";

vi.mock("../desktopApi", () => ({
  getAudioOutputDevices: vi.fn(),
  getMidiInputs: vi.fn(),
  getMidiOutputs: vi.fn(),
  getSettings: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("useSettingsState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hydrates the click state before slow hardware discovery completes", async () => {
    const audioDevices =
      deferred<Awaited<ReturnType<typeof getAudioOutputDevices>>>();
    const midiInputs = deferred<string[]>();
    const midiOutputs = deferred<string[]>();

    vi.mocked(getSettings).mockResolvedValue({
      ...DEFAULT_APP_SETTINGS,
      metronomeEnabled: true,
    });
    vi.mocked(getAudioOutputDevices).mockReturnValue(audioDevices.promise);
    vi.mocked(getMidiInputs).mockReturnValue(midiInputs.promise);
    vi.mocked(getMidiOutputs).mockReturnValue(midiOutputs.promise);

    const { result } = renderHook(() =>
      useSettingsState({
        syncSettingsLanguage: vi.fn().mockResolvedValue(undefined),
      }),
    );

    let refresh!: ReturnType<typeof result.current.refreshAudioSettings>;
    act(() => {
      refresh = result.current.refreshAudioSettings();
    });

    await waitFor(() =>
      expect(result.current.appSettings.metronomeEnabled).toBe(true),
    );

    let settled = false;
    void refresh.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    audioDevices.resolve({
      devices: [],
      deviceDescriptors: [],
      channelCounts: {},
      defaultDevice: null,
    });
    midiInputs.resolve([]);
    midiOutputs.resolve([]);
    await act(async () => {
      await refresh;
    });
  });

  it("keeps loaded settings when optional hardware discovery fails", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ...DEFAULT_APP_SETTINGS,
      metronomeEnabled: true,
    });
    vi.mocked(getAudioOutputDevices).mockRejectedValue(new Error("no audio scan"));
    vi.mocked(getMidiInputs).mockRejectedValue(new Error("no MIDI input"));
    vi.mocked(getMidiOutputs).mockRejectedValue(new Error("no MIDI output"));

    const { result } = renderHook(() =>
      useSettingsState({
        syncSettingsLanguage: vi.fn().mockResolvedValue(undefined),
      }),
    );

    await act(async () => {
      await result.current.refreshAudioSettings();
    });

    expect(result.current.appSettings.metronomeEnabled).toBe(true);
  });
});
