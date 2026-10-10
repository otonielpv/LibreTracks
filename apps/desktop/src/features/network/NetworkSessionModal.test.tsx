import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "../../shared/i18n";
import type {
  NetworkGuestStatus,
  NetworkHostStatus,
} from "@libretracks/shared/networkApi";

import { NetworkSessionBadge } from "./NetworkSessionBadge";
import { NetworkSessionModal } from "./NetworkSessionModal";
import {
  EMPTY_GUEST_STATUS,
  INITIAL_NETWORK_SESSION_STATE,
  useNetworkSessionStore,
} from "./networkSessionStore";

const api = vi.hoisted(() => ({
  getNetworkSessionSettings: vi.fn(async () => ({
    deviceName: "PC del director",
    controlPin: "1111",
    editPin: "2222",
    keepHostingAfterRestart: false,
  })),
  saveNetworkSessionSettings: vi.fn(async (settings: unknown) => settings),
  startHosting: vi.fn(async () => undefined),
  stopHosting: vi.fn(async () => undefined),
  setGuestRole: vi.fn(async () => true),
  kickGuest: vi.fn(async () => true),
  revokeTrustedDevice: vi.fn(async () => true),
  joinHost: vi.fn(async () => undefined),
  leaveHost: vi.fn(async () => undefined),
}));

vi.mock("@libretracks/shared/networkApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@libretracks/shared/networkApi")>();
  return { ...actual, ...api };
});

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,QR") },
}));

function hosting(overrides: Partial<NetworkHostStatus> = {}): NetworkHostStatus {
  return {
    hosting: true,
    hostName: "PC del director",
    port: 3040,
    addresses: ["192.168.1.20:3040"],
    joinUrl: "libretracks://join?host=192.168.1.20:3040&name=PC",
    guests: [
      {
        deviceId: "ipad",
        deviceName: "iPad de Ana",
        platform: "ios",
        appVersion: "1.15.0",
        grants: { role: "viewer" },
        connectedAtMs: 0,
        rttMs: 24,
        trusted: false,
      },
    ],
    trusted: [{ deviceId: "phone", deviceName: "Móvil de Luis", role: "editor" }],
    ...overrides,
  };
}

function guest(overrides: Partial<NetworkGuestStatus>): NetworkGuestStatus {
  return { ...EMPTY_GUEST_STATUS, joined: true, address: "192.168.1.20:3040", ...overrides };
}

beforeEach(async () => {
  await i18n.changeLanguage("es");
  useNetworkSessionStore.setState({ ...INITIAL_NETWORK_SESSION_STATE, isModalOpen: true });
  for (const mock of Object.values(api)) mock.mockClear();
});

afterEach(() => cleanup());

describe("NetworkSessionModal — host", () => {
  it("starts hosting", async () => {
    render(<NetworkSessionModal />);
    fireEvent.click(await screen.findByRole("button", { name: "Hospedar" }));
    await waitFor(() => expect(api.startHosting).toHaveBeenCalled());
  });

  it("shows the address, the QR, the guests and the remembered devices", async () => {
    useNetworkSessionStore.setState({ host: hosting() });
    render(<NetworkSessionModal />);
    expect(screen.getByText("192.168.1.20:3040")).toBeTruthy();
    expect(await screen.findByAltText("Código QR para unirse a esta sesión")).toBeTruthy();
    expect(screen.getByText("Conectados (1)")).toBeTruthy();
    expect(screen.getByText("iPad de Ana")).toBeTruthy();
    // Latency shown one-way: half the round trip.
    expect(screen.getByText(/12 ms/)).toBeTruthy();
    expect(screen.getByText("Móvil de Luis")).toBeTruthy();
  });

  it("changes a guest's role live", async () => {
    useNetworkSessionStore.setState({ host: hosting() });
    render(<NetworkSessionModal />);
    fireEvent.change(screen.getByLabelText("Rol de iPad de Ana"), {
      target: { value: "controller" },
    });
    await waitFor(() => expect(api.setGuestRole).toHaveBeenCalledWith("ipad", "controller"));
  });

  it("kicks a guest and forgets a remembered device", async () => {
    useNetworkSessionStore.setState({ host: hosting() });
    render(<NetworkSessionModal />);
    fireEvent.click(screen.getByLabelText("Expulsar a iPad de Ana"));
    await waitFor(() => expect(api.kickGuest).toHaveBeenCalledWith("ipad"));
    fireEvent.click(screen.getByRole("button", { name: "Olvidar" }));
    await waitFor(() => expect(api.revokeTrustedDevice).toHaveBeenCalledWith("phone"));
  });

  it("saves the PINs only when they changed", async () => {
    render(<NetworkSessionModal />);
    const control = await screen.findByLabelText(/^PIN de Control/);
    expect(screen.queryByRole("button", { name: "Guardar cambios" })).toBeNull();
    fireEvent.change(control, { target: { value: "4321" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await waitFor(() =>
      expect(api.saveNetworkSessionSettings).toHaveBeenCalledWith(
        expect.objectContaining({ controlPin: "4321", editPin: "2222" }),
      ),
    );
  });
});

describe("NetworkSessionModal — join", () => {
  it("joins with address, PIN and remember", async () => {
    render(<NetworkSessionModal />);
    fireEvent.click(screen.getByRole("tab", { name: "Unirse" }));
    fireEvent.change(screen.getByLabelText(/^Dirección del anfitrión/), {
      target: { value: "192.168.1.20" },
    });
    fireEvent.change(screen.getByLabelText(/^PIN \(opcional\)/), { target: { value: " 1111 " } });
    fireEvent.click(screen.getByRole("button", { name: "Unirse" }));
    await waitFor(() => expect(api.joinHost).toHaveBeenCalledWith("192.168.1.20", "1111", true));
  });

  it("joins as viewer without a PIN", async () => {
    render(<NetworkSessionModal />);
    fireEvent.click(screen.getByRole("tab", { name: "Unirse" }));
    fireEvent.change(screen.getByLabelText(/^Dirección del anfitrión/), {
      target: { value: "10.0.0.2:3041" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Unirse" }));
    await waitFor(() => expect(api.joinHost).toHaveBeenCalledWith("10.0.0.2:3041", null, true));
  });

  it("explains an invalid address", async () => {
    api.joinHost.mockRejectedValueOnce("invalidAddress" as never);
    render(<NetworkSessionModal />);
    fireEvent.click(screen.getByRole("tab", { name: "Unirse" }));
    fireEvent.change(screen.getByLabelText(/^Dirección del anfitrión/), {
      target: { value: "no vale" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Unirse" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/no es válida/);
  });

  it("shows a bad PIN rejection readably", () => {
    useNetworkSessionStore.setState({
      guest: guest({ state: "rejected", reason: "badPin", hostName: "PC del director" }),
    });
    render(<NetworkSessionModal />);
    expect(screen.getByRole("alert").textContent).toBe("PIN incorrecto.");
    fireEvent.click(screen.getByRole("button", { name: "Salir de la sesión" }));
    expect(api.leaveHost).toHaveBeenCalled();
  });

  it("cannot join while hosting", () => {
    useNetworkSessionStore.setState({ host: hosting() });
    render(<NetworkSessionModal />);
    fireEvent.click(screen.getByRole("tab", { name: "Unirse" }));
    fireEvent.change(screen.getByLabelText(/^Dirección del anfitrión/), {
      target: { value: "10.0.0.2" },
    });
    expect((screen.getByRole("button", { name: "Unirse" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe("NetworkSessionBadge", () => {
  it("is hidden with no session", () => {
    const { container } = render(<NetworkSessionBadge />);
    expect(container.textContent).toBe("");
  });

  it("shows host, guest and lost states", () => {
    useNetworkSessionStore.setState({ host: hosting() });
    const { rerender } = render(<NetworkSessionBadge />);
    expect(screen.getByRole("button").textContent).toContain("Anfitrión · 1");

    act(() =>
      useNetworkSessionStore.setState({
        host: hosting({ hosting: false }),
        guest: guest({ state: "connected", role: "controller", rttMs: 30 }),
      }),
    );
    rerender(<NetworkSessionBadge />);
    expect(screen.getByRole("button").textContent).toContain("Invitado · Control · 15 ms");

    act(() => useNetworkSessionStore.setState({ guest: guest({ state: "lost" }) }));
    rerender(<NetworkSessionBadge />);
    const badge = screen.getByRole("button");
    expect(badge.textContent).toContain("Conexión perdida");
    expect(badge.className).toContain("is-error");
  });
});

describe("i18n", () => {
  it("es and en have the same networkSession keys", async () => {
    const { default: es } = await import("../../shared/i18n/es");
    const { default: en } = await import("../../shared/i18n/en");
    const keys = (value: unknown, prefix = ""): string[] =>
      value && typeof value === "object"
        ? Object.entries(value).flatMap(([key, inner]) => keys(inner, `${prefix}${key}.`))
        : [prefix];
    expect(keys(en.networkSession).sort()).toEqual(keys(es.networkSession).sort());
  });
});
