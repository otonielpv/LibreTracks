import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CloudPanel } from "./CloudPanel";
import { useCloudStore } from "./cloudStore";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "es" },
  }),
}));

describe("panel de nube con varias cuentas", () => {
  const disconnect = vi.fn(async () => {});

  beforeEach(() => {
    useCloudStore.getState().reset();
    disconnect.mockClear();
    useCloudStore.setState({
      isPanelOpen: true,
      statuses: [
        { provider: "google-drive", name: "Google Drive", configured: true, connected: false },
        { provider: "onedrive", name: "OneDrive", configured: true, connected: true },
        { provider: "dropbox", name: "Dropbox", configured: true, connected: true },
      ],
      refreshStatus: async () => {},
      refreshQuota: async () => {},
      refreshFiles: async () => {},
      disconnect,
    } as never);
  });

  /// Quien solo conecto OneDrive no debe abrir el panel en una seccion de
  /// Drive vacia.
  it("abre en una cuenta conectada aunque la de trabajo fuera Drive", async () => {
    render(<CloudPanel />);
    await waitFor(() => expect(useCloudStore.getState().provider).toBe("onedrive"));
  });

  it("lista cada cuenta y desconecta solo la pulsada", async () => {
    render(<CloudPanel />);
    await waitFor(() => expect(useCloudStore.getState().provider).toBe("onedrive"));

    const buttons = screen.getAllByText("transport.cloud.disconnect");
    expect(buttons).toHaveLength(2);
    // Filas en orden: Drive (sin conectar), OneDrive, Dropbox.
    fireEvent.click(buttons[1]);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith("dropbox");
  });

  it("ver archivos cambia la cuenta mostrada", async () => {
    render(<CloudPanel />);
    await waitFor(() => expect(useCloudStore.getState().provider).toBe("onedrive"));
    fireEvent.click(screen.getByText("transport.cloud.showFiles"));
    expect(useCloudStore.getState().provider).toBe("dropbox");
  });
});
