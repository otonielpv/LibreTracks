import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../../../shared/i18n";
import type { MidiCapabilities } from "../desktopApi";
import { MidiSettingsTab, type MidiOutputSettings } from "./MidiSettingsTab";

/**
 * Platform MIDI settings in the MIDI tab (plan mobile-midi, pasos 07 y 10):
 * each toggle appears only where the platform can do it, so desktop keeps the
 * tab exactly as it was.
 */

const caps = vi.hoisted(() => ({ value: null as MidiCapabilities | null }));

vi.mock("../hooks/useMidiCapabilities", () => ({
  useMidiCapabilities: () => caps.value,
}));

function capabilities(overrides: Partial<MidiCapabilities>): MidiCapabilities {
  return {
    available: true,
    bluetoothPairing: false,
    networkSession: false,
    virtualPorts: false,
    ...overrides,
  };
}

function renderTab(onChange = vi.fn()) {
  const midiOutput: MidiOutputSettings = {
    devices: [],
    selected: "",
    selectedMissing: false,
    onChange: () => {},
    onRefresh: () => {},
    onSendTestNote: () => {},
    platform: { networkSession: false, virtualPort: false, onChange },
  };
  render(
    <MidiSettingsTab
      isLoading={false}
      isSaving={false}
      midiInputDevices={["Pedal"]}
      isMidiInputRefreshing={false}
      selectedMidiInputDevice=""
      selectedMidiInputDeviceMissing={false}
      onMidiInputDeviceChange={() => {}}
      onRefreshMidiInputDevices={() => {}}
      midiOutput={midiOutput}
    />,
  );
  return onChange;
}

describe("MidiSettingsTab platform toggles", () => {
  beforeEach(() => {
    caps.value = null;
  });

  afterEach(() => {
    cleanup();
  });

  it("desktop (no virtual ports, no network session) shows neither", () => {
    caps.value = capabilities({});
    renderTab();
    expect(screen.queryByLabelText(/virtual MIDI port/i)).toBeNull();
    expect(screen.queryByLabelText(/Network MIDI session/i)).toBeNull();
  });

  it("iOS shows both and saves each one", () => {
    caps.value = capabilities({ virtualPorts: true, networkSession: true });
    const onChange = renderTab();

    fireEvent.click(screen.getByLabelText(/virtual MIDI port/i));
    expect(onChange).toHaveBeenLastCalledWith({ midiVirtualPort: true });

    fireEvent.click(screen.getByLabelText(/Network MIDI session/i));
    expect(onChange).toHaveBeenLastCalledWith({ midiNetworkSession: true });
  });

  it("Android shows the virtual port but no network session", () => {
    caps.value = capabilities({ virtualPorts: true });
    renderTab();
    expect(screen.getByLabelText(/virtual MIDI port/i)).toBeTruthy();
    expect(screen.queryByLabelText(/Network MIDI session/i)).toBeNull();
  });
});
