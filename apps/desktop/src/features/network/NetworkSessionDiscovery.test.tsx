import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NetworkDiscoveredHost } from "@libretracks/shared/networkApi";

const api = vi.hoisted(() => ({
  discoveredHandler: null as ((hosts: NetworkDiscoveredHost[]) => void) | null,
  startDiscovery: vi.fn(async (): Promise<NetworkDiscoveredHost[]> => []),
  stopDiscovery: vi.fn(async () => undefined),
  listenToDiscoveredHosts: vi.fn(async (handler: (hosts: NetworkDiscoveredHost[]) => void) => {
    api.discoveredHandler = handler;
    return () => {
      api.discoveredHandler = null;
    };
  }),
  joinHost: vi.fn(async () => undefined),
  getNetworkSessionSettings: vi.fn(async () => ({
    deviceName: "Tablet",
    controlPin: "",
    editPin: "",
    keepHostingAfterRestart: false,
  })),
}));

vi.mock("@libretracks/shared/networkApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@libretracks/shared/networkApi")>();
  return { ...actual, ...api };
});
vi.mock("@libretracks/shared/desktopApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@libretracks/shared/desktopApi")>();
  return {
    ...actual,
    isTauriApp: true,
    // The firewall notice asks; off Windows it shows nothing.
    getRemoteFirewallStatus: vi.fn(async () => ({ supported: false })),
  };
});
vi.mock("../transport/desktopApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../transport/desktopApi")>();
  return {
    ...actual,
    isTauriApp: true,
    getRemoteFirewallStatus: vi.fn(async () => ({ supported: false })),
  };
});

import i18n from "../../shared/i18n";
import { NetworkSessionModal } from "./NetworkSessionModal";
import { INITIAL_NETWORK_SESSION_STATE, useNetworkSessionStore } from "./networkSessionStore";
import { NOT_FOUND_HINT_MS } from "./useHostDiscovery";

function found(overrides: Partial<NetworkDiscoveredHost> = {}): NetworkDiscoveredHost {
  return {
    hostId: "pc-1",
    name: "PC del director",
    addresses: ["192.168.1.20:3040"],
    protocol: 1,
    appVersion: "1.15.0",
    requiresPin: true,
    compatible: true,
    ...overrides,
  };
}

beforeEach(async () => {
  await i18n.changeLanguage("es");
  useNetworkSessionStore.setState({ ...INITIAL_NETWORK_SESSION_STATE, isModalOpen: true });
  for (const mock of [api.startDiscovery, api.stopDiscovery, api.joinHost]) mock.mockClear();
  api.startDiscovery.mockResolvedValue([]);
});

afterEach(() => cleanup());

async function openJoinTab() {
  render(<NetworkSessionModal />);
  fireEvent.click(screen.getByRole("tab", { name: "Unirse" }));
  await waitFor(() => expect(api.startDiscovery).toHaveBeenCalled());
}

describe("finding hosts", () => {
  it("lists hosts found on the network and joins one with the PIN typed", async () => {
    api.startDiscovery.mockResolvedValue([found()]);
    await openJoinTab();
    expect(await screen.findByText("PC del director")).toBeTruthy();
    expect(screen.getByText(/192\.168\.1\.20:3040/, { selector: "small" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/^PIN \(opcional\)/), { target: { value: "2222" } });
    fireEvent.click(screen.getByRole("button", { name: "Unirse: PC del director" }));
    await waitFor(() =>
      expect(api.joinHost).toHaveBeenCalledWith("192.168.1.20:3040", "2222", true, "pc-1"),
    );
  });

  it("updates as hosts appear and go", async () => {
    await openJoinTab();
    expect(screen.getByText("Buscando anfitriones en la Wi-Fi…")).toBeTruthy();
    await waitFor(() => expect(api.discoveredHandler).not.toBeNull());
    act(() => api.discoveredHandler?.([found({ hostId: "ipad", name: "iPad de Ana" })]));
    expect(screen.getByText("iPad de Ana")).toBeTruthy();
    act(() => api.discoveredHandler?.([]));
    expect(screen.queryByText("iPad de Ana")).toBeNull();
  });

  it("an incompatible host is shown but cannot be joined", async () => {
    api.startDiscovery.mockResolvedValue([found({ compatible: false })]);
    await openJoinTab();
    expect(await screen.findByText("Versión incompatible: actualiza LibreTracks")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Unirse: PC del director" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("explains what to check when nothing shows up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await openJoinTab();
      expect(screen.queryByText("¿No aparece el anfitrión?")).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(NOT_FOUND_HINT_MS + 10);
      });
      expect(screen.getByText("¿No aparece el anfitrión?")).toBeTruthy();
      expect(screen.getByText(/Red local/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops looking when leaving the tab", async () => {
    await openJoinTab();
    fireEvent.click(screen.getByRole("tab", { name: "Hospedar" }));
    await waitFor(() => expect(api.stopDiscovery).toHaveBeenCalled());
  });

  it("does not look while joined", async () => {
    useNetworkSessionStore.setState({
      guest: { ...INITIAL_NETWORK_SESSION_STATE.guest, joined: true, state: "connected" },
    });
    render(<NetworkSessionModal />);
    expect(api.startDiscovery).not.toHaveBeenCalled();
  });
});

describe("host paused in the background", () => {
  it("says it reopens by itself", async () => {
    useNetworkSessionStore.setState({
      host: {
        hosting: false,
        suspended: true,
        hostName: "iPad",
        port: 0,
        addresses: [],
        joinUrl: null,
        guests: [],
        trusted: [],
      },
    });
    render(<NetworkSessionModal />);
    expect(screen.getByRole("status").textContent).toMatch(/se reabre sola/);
  });
});
