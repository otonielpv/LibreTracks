import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../../shared/i18n";
import type { MidiDevicesStatus } from "./desktopApi";
import { MidiDeviceStatusBadge } from "./MidiDeviceStatusBadge";

const api = vi.hoisted(() => ({
  handler: null as ((status: MidiDevicesStatus) => void) | null,
  initial: null as MidiDevicesStatus | null,
}));

vi.mock("./desktopApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./desktopApi")>();
  return {
    ...actual,
    isTauriApp: true,
    getMidiStatus: vi.fn(async () => api.initial),
    listenToMidiDevicesChanged: vi.fn(
      async (handler: (status: MidiDevicesStatus) => void) => {
        api.handler = handler;
        return () => {
          api.handler = null;
        };
      },
    ),
  };
});

function status(overrides: Partial<MidiDevicesStatus> = {}): MidiDevicesStatus {
  return {
    inputs: ["Pedal"],
    outputs: [],
    inputConnected: true,
    inputWaiting: false,
    outputConnected: false,
    outputWaiting: false,
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("MidiDeviceStatusBadge", () => {
  beforeEach(() => {
    api.handler = null;
    api.initial = status();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows nothing while the selected devices are connected", async () => {
    render(<MidiDeviceStatusBadge />);
    await flush();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the pill at startup when the selected controller is missing", async () => {
    api.initial = status({ inputs: [], inputConnected: false, inputWaiting: true });
    render(<MidiDeviceStatusBadge />);
    await flush();
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe(
      "MIDI controller disconnected",
    );
  });

  it("follows hot-plug events: unplug shows it, replug hides it", async () => {
    render(<MidiDeviceStatusBadge />);
    await flush();
    expect(screen.queryByRole("status")).toBeNull();

    await act(async () => {
      api.handler?.(status({ inputs: [], inputConnected: false, inputWaiting: true }));
    });
    expect(screen.getByRole("status")).toBeTruthy();

    await act(async () => {
      api.handler?.(status());
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("names the output when only the output is missing", async () => {
    api.initial = status({ outputWaiting: true });
    render(<MidiDeviceStatusBadge />);
    await flush();
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe(
      "MIDI output disconnected",
    );
  });
});
