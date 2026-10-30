import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CloudFlowModals } from "./CloudFlowModals";
import { useCloudStore } from "./cloudStore";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && "providers" in options ? `${key}:${options.providers}` : key,
    i18n: { language: "es" },
  }),
}));

const STATUSES = [
  { provider: "google-drive", name: "Google Drive", configured: true, connected: true },
  { provider: "onedrive", name: "OneDrive", configured: false, connected: false },
  { provider: "dropbox", name: "Dropbox", configured: true, connected: true },
] as const;

function ask(intent: "import" | "export") {
  const resolve = vi.fn();
  useCloudStore.setState({
    statuses: STATUSES.map((s) => ({ ...s })),
    refreshStatus: async () => {},
    pendingChoice: { intent, kind: "session", resolve },
  } as never);
  render(<CloudFlowModals />);
  return resolve;
}

describe("eleccion de origen y destino", () => {
  beforeEach(() => {
    useCloudStore.getState().reset();
  });

  /// Importar no pregunta de que cuenta: el selector las lista todas.
  it("al importar hay una sola tarjeta de nube que nombra las cuentas conectadas", () => {
    const resolve = ask("import");
    expect(screen.queryByText("Google Drive")).toBeNull();
    expect(screen.queryByText("Dropbox")).toBeNull();
    const card = screen.getByText("transport.cloud.cloudImportFrom:Google Drive, Dropbox");
    fireEvent.click(card);
    expect(resolve).toHaveBeenCalledWith("cloud");
  });

  /// Como antes: primero este equipo o la nube; la cuenta, despues.
  it("al exportar, elegir nube pregunta despues a que cuenta", () => {
    const resolve = ask("export");
    expect(screen.queryByText("Dropbox")).toBeNull();
    fireEvent.click(screen.getByText("transport.cloud.cloudExportPick"));
    expect(resolve).not.toHaveBeenCalled();

    expect(screen.getByText("transport.cloud.chooseAccount")).toBeTruthy();
    // Solo las configuradas: OneDrive no viene en esta compilacion.
    expect(screen.queryByText("OneDrive")).toBeNull();
    fireEvent.click(screen.getByText("Dropbox"));
    expect(resolve).toHaveBeenCalledWith("dropbox");
  });

  it("atras vuelve a la primera pregunta", () => {
    ask("export");
    fireEvent.click(screen.getByText("transport.cloud.cloudExportPick"));
    fireEvent.click(screen.getByText("common.back"));
    expect(screen.getByText("transport.cloud.chooseExportTarget")).toBeTruthy();
  });

  it("este equipo sigue devolviendo local", () => {
    const resolve = ask("export");
    fireEvent.click(screen.getByText("transport.cloud.thisDevice"));
    expect(resolve).toHaveBeenCalledWith("local");
  });

  it("importar sin ninguna cuenta conectada lleva al panel", () => {
    const resolve = vi.fn();
    useCloudStore.setState({
      statuses: STATUSES.map((s) => ({ ...s, connected: false })),
      refreshStatus: async () => {},
      pendingChoice: { intent: "import", kind: "song", resolve },
    } as never);
    render(<CloudFlowModals />);
    fireEvent.click(screen.getByText("transport.cloud.connectInPanel"));
    expect(resolve).toHaveBeenCalledWith(null);
    expect(useCloudStore.getState().isPanelOpen).toBe(true);
  });
});

describe("selector de importar", () => {
  beforeEach(() => {
    useCloudStore.getState().reset();
  });

  it("cada archivo lleva la etiqueta de la cuenta de la que viene", () => {
    const resolve = vi.fn();
    const dropboxFile = {
      id: "id:1",
      name: "Domingo.ltset",
      sizeBytes: 2048,
      modified: null,
      provider: "dropbox",
      providerName: "Dropbox",
    } as const;
    useCloudStore.setState({
      pickerFiles: [
        dropboxFile,
        {
          id: "g1",
          name: "Ensayo.ltset",
          sizeBytes: 1024,
          modified: null,
          provider: "google-drive",
          providerName: "Google Drive",
        },
      ],
      pendingPick: { folder: "sessions", resolve },
    } as never);
    render(<CloudFlowModals />);

    expect(screen.getByText("Dropbox")).toBeTruthy();
    expect(screen.getByText("Google Drive")).toBeTruthy();
    fireEvent.click(screen.getByText("Dropbox"));
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ id: "id:1", provider: "dropbox" }));
  });
});
