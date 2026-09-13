import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import type { RemoteFirewallStatus } from "../desktopApi";
import { RemoteFirewallNotice } from "./RemoteFirewallNotice";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const active = options?.active ?? "";
      const allowed = options?.allowed ?? "";
      if (options?.defaultValue) return options.defaultValue as string;
      return `${key}|${active}|${allowed}`;
    },
  }),
}));

const getRemoteFirewallStatus = vi.fn();
const allowRemoteThroughFirewall = vi.fn();

vi.mock("../desktopApi", () => ({
  isTauriApp: true,
  getRemoteFirewallStatus: (...args: unknown[]) =>
    getRemoteFirewallStatus(...args),
  allowRemoteThroughFirewall: (...args: unknown[]) =>
    allowRemoteThroughFirewall(...args),
}));

function status(overrides: Partial<RemoteFirewallStatus> = {}): RemoteFirewallStatus {
  return {
    supported: true,
    known: true,
    covered: true,
    activeProfiles: [],
    allowedProfiles: [],
    ...overrides,
  };
}

/** El boton del arreglo, que es lo unico que dispara el UAC. */
const allowButton = () =>
  screen.queryByRole("button", { name: /remoteAccess\.firewall\.allow/ });

describe("RemoteFirewallNotice", () => {
  beforeEach(() => {
    getRemoteFirewallStatus.mockReset();
    allowRemoteThroughFirewall.mockReset();
  });

  it("no enseña nada cuando la regla cubre la red conectada", async () => {
    getRemoteFirewallStatus.mockResolvedValue(
      status({ covered: true, activeProfiles: ["Private"], allowedProfiles: ["Any"] }),
    );

    const { container } = render(<RemoteFirewallNotice />);

    await waitFor(() => expect(getRemoteFirewallStatus).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("no enseña nada fuera de Windows", async () => {
    getRemoteFirewallStatus.mockResolvedValue(
      status({ supported: false, covered: true }),
    );

    const { container } = render(<RemoteFirewallNotice />);

    await waitFor(() => expect(getRemoteFirewallStatus).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("avisa cuando la regla solo cubre otra red", async () => {
    // El fallo real: el aviso de Windows dejo una regla solo de Public y el
    // wifi de casa es Private.
    getRemoteFirewallStatus.mockResolvedValue(
      status({
        covered: false,
        activeProfiles: ["Private"],
        allowedProfiles: ["Public"],
      }),
    );

    render(<RemoteFirewallNotice />);

    expect(await screen.findByText(/remoteAccess\.firewall\.blocked/)).toBeTruthy();
    expect(allowButton()).toBeTruthy();
  });

  it("sin ninguna regla lo dice de otra manera", async () => {
    getRemoteFirewallStatus.mockResolvedValue(
      status({ covered: false, activeProfiles: ["Private"], allowedProfiles: [] }),
    );

    render(<RemoteFirewallNotice />);

    expect(await screen.findByText(/remoteAccess\.firewall\.noRule/)).toBeTruthy();
  });

  it("ofrece el arreglo aunque no haya podido comprobarlo", async () => {
    // No saber no es motivo para esconder el boton: el coste de ofrecerlo de
    // mas es un clic, y el de esconderlo es un Remote que no conecta.
    getRemoteFirewallStatus.mockResolvedValue(status({ known: false, covered: false }));

    render(<RemoteFirewallNotice />);

    expect(await screen.findByText(/remoteAccess\.firewall\.unknown/)).toBeTruthy();
    expect(allowButton()).toBeTruthy();
  });

  it("nunca eleva por su cuenta: solo al pulsar el boton", async () => {
    getRemoteFirewallStatus.mockResolvedValue(
      status({ covered: false, activeProfiles: ["Private"], allowedProfiles: ["Public"] }),
    );
    allowRemoteThroughFirewall.mockResolvedValue(status({ covered: true }));

    render(<RemoteFirewallNotice />);
    const button = await screen.findByRole("button", {
      name: /remoteAccess\.firewall\.allow/,
    });

    // Montar y renderizar el aviso no puede sacar un UAC.
    expect(allowRemoteThroughFirewall).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(button);
    });

    expect(allowRemoteThroughFirewall).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/remoteAccess\.firewall\.done/)).toBeTruthy();
  });

  it("si el usuario rechaza el UAC lo dice y deja reintentar", async () => {
    getRemoteFirewallStatus.mockResolvedValue(status({ covered: false }));
    allowRemoteThroughFirewall.mockRejectedValue(
      new Error("Hay que aceptar el aviso de Windows"),
    );

    render(<RemoteFirewallNotice />);
    const button = await screen.findByRole("button", {
      name: /remoteAccess\.firewall\.allow/,
    });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(
      await screen.findByText(/Hay que aceptar el aviso de Windows/),
    ).toBeTruthy();
    expect(allowButton()).toBeTruthy();
  });

  it("no canta victoria si la regla se creo pero sigue sin cubrir", async () => {
    getRemoteFirewallStatus.mockResolvedValue(status({ covered: false }));
    allowRemoteThroughFirewall.mockResolvedValue(status({ covered: false }));

    render(<RemoteFirewallNotice />);
    const button = await screen.findByRole("button", {
      name: /remoteAccess\.firewall\.allow/,
    });
    await act(async () => {
      fireEvent.click(button);
    });

    await waitFor(() => expect(allowRemoteThroughFirewall).toHaveBeenCalled());
    expect(screen.queryByText(/remoteAccess\.firewall\.done/)).toBeNull();
  });

  it("una consulta que falla deja el panel como estaba", async () => {
    getRemoteFirewallStatus.mockRejectedValue(new Error("comando no encontrado"));

    const { container } = render(<RemoteFirewallNotice />);

    await waitFor(() => expect(getRemoteFirewallStatus).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });
});
