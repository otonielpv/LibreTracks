import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../../../shared/i18n";
import type { BluetoothMidiDevice } from "../desktopApi";
import { BluetoothMidiModal } from "./BluetoothMidiModal";

const api = vi.hoisted(() => ({
  scan: vi.fn<() => Promise<BluetoothMidiDevice[]>>(),
  connect: vi.fn<(address: string) => Promise<void>>(),
}));

vi.mock("../desktopApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../desktopApi")>();
  return {
    ...actual,
    scanBluetoothMidi: api.scan,
    connectBluetoothMidi: api.connect,
  };
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("BluetoothMidiModal (Android)", () => {
  beforeEach(() => {
    api.scan.mockReset();
    api.connect.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("scans on open, lists what it found and connects the tapped device", async () => {
    api.scan.mockResolvedValue([{ address: "AA:BB", name: "FS-1-WL" }]);
    api.connect.mockResolvedValue();
    render(<BluetoothMidiModal onClose={() => {}} />);
    expect(screen.getByText("Searching for Bluetooth MIDI devices…")).toBeTruthy();
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "Connect: FS-1-WL" }));
    await flush();

    expect(api.connect).toHaveBeenCalledWith("AA:BB");
    expect(screen.getByText(/FS-1-WL is connected/)).toBeTruthy();
  });

  it("explains a denied permission and that USB keeps working", async () => {
    api.scan.mockRejectedValue("bluetooth_permission_denied");
    render(<BluetoothMidiModal onClose={() => {}} />);
    await flush();
    expect(screen.getByRole("alert").textContent).toMatch(
      /needs the Bluetooth permission.*USB MIDI keeps working/,
    );
  });

  it("says when Bluetooth is off", async () => {
    api.scan.mockRejectedValue(new Error("bluetooth_off"));
    render(<BluetoothMidiModal onClose={() => {}} />);
    await flush();
    expect(screen.getByRole("alert").textContent).toBe(
      "Bluetooth is off. Switch it on and search again.",
    );
  });

  it("says when nothing was found", async () => {
    api.scan.mockResolvedValue([]);
    render(<BluetoothMidiModal onClose={() => {}} />);
    await flush();
    expect(screen.getByText(/No Bluetooth MIDI device found/)).toBeTruthy();
  });
});
