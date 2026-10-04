import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MidiCapabilities } from "../desktopApi";
import { visibleSettingsTabs } from "../settings/visibleSettingsTabs";
import type { SettingsTab } from "../types";
import { useMidiCapabilities } from "./useMidiCapabilities";

const api = vi.hoisted(() => ({
  capabilities: { available: false } as {
    available: boolean;
    bluetoothPairing?: boolean;
    networkSession?: boolean;
    virtualPorts?: boolean;
  },
  devicesChanged: null as (() => void) | null,
  getMidiCapabilities: vi.fn(),
}));

vi.mock("../desktopApi", () => ({
  isTauriApp: true,
  getMidiCapabilities: api.getMidiCapabilities,
  listenToMidiDevicesChanged: vi.fn(async (handler: () => void) => {
    api.devicesChanged = handler;
    return () => {
      api.devicesChanged = null;
    };
  }),
}));

function caps(available: boolean): MidiCapabilities {
  return {
    available,
    bluetoothPairing: false,
    networkSession: false,
    virtualPorts: false,
  };
}

const ALL_TABS: Array<{ id: SettingsTab }> = [
  { id: "audio" },
  { id: "general" },
  { id: "video" },
  { id: "shortcuts" },
  { id: "diagnostics" },
  { id: "midi" },
  { id: "midiLearn" },
];

function ids(tabs: Array<{ id: SettingsTab }>) {
  return tabs.map((tab) => tab.id);
}

describe("useMidiCapabilities + visibleSettingsTabs", () => {
  beforeEach(() => {
    api.devicesChanged = null;
    api.getMidiCapabilities.mockReset();
  });

  it("shows the MIDI tabs on mobile when MIDI is available", async () => {
    api.getMidiCapabilities.mockResolvedValue(caps(true));
    const { result } = renderHook(() => useMidiCapabilities());
    await waitFor(() => expect(result.current?.available).toBe(true));

    expect(
      ids(
        visibleSettingsTabs(ALL_TABS, {
          isMobile: true,
          midiAvailable: result.current?.available ?? false,
        }),
      ),
    ).toEqual(["audio", "general", "diagnostics", "midi", "midiLearn"]);
  });

  it("hides them on mobile when MIDI is not available, as before", async () => {
    api.getMidiCapabilities.mockResolvedValue(caps(false));
    const { result } = renderHook(() => useMidiCapabilities());
    await waitFor(() => expect(result.current).not.toBeNull());

    expect(
      ids(
        visibleSettingsTabs(ALL_TABS, {
          isMobile: true,
          midiAvailable: result.current?.available ?? false,
        }),
      ),
    ).toEqual(["audio", "general", "diagnostics"]);
  });

  it("desktop always shows every tab", () => {
    expect(
      ids(visibleSettingsTabs(ALL_TABS, { isMobile: false, midiAvailable: false })),
    ).toEqual(ids(ALL_TABS));
  });

  it("re-reads the capabilities when MIDI devices change", async () => {
    api.getMidiCapabilities.mockResolvedValue(caps(false));
    const { result } = renderHook(() => useMidiCapabilities());
    await waitFor(() => expect(result.current?.available).toBe(false));
    await waitFor(() => expect(api.devicesChanged).not.toBeNull());

    api.getMidiCapabilities.mockResolvedValue(caps(true));
    await act(async () => {
      api.devicesChanged?.();
    });

    await waitFor(() => expect(result.current?.available).toBe(true));
    expect(api.getMidiCapabilities).toHaveBeenCalledTimes(2);
  });
});
