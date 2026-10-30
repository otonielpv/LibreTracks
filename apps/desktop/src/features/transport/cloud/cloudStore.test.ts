import { beforeEach, describe, expect, it, vi } from "vitest";

import { getCloudStatus, listCloudFiles } from "../desktopApi";
import { newTransfer, useCloudStore } from "./cloudStore";

vi.mock("../../telemetry/telemetry", () => ({ recordProductEvent: vi.fn() }));
vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  listCloudFiles: vi.fn(),
  getCloudStatus: vi.fn(),
}));

describe("selector de importar con varias cuentas", () => {
  beforeEach(() => {
    useCloudStore.getState().reset();
    vi.mocked(listCloudFiles).mockReset();
    vi.mocked(getCloudStatus).mockResolvedValue([
      { provider: "google-drive", name: "Google Drive", configured: true, connected: true },
      { provider: "onedrive", name: "OneDrive", configured: true, connected: false },
      { provider: "dropbox", name: "Dropbox", configured: true, connected: true },
    ]);
  });

  it("junta las cuentas conectadas, etiqueta cada archivo y ordena por fecha", async () => {
    vi.mocked(listCloudFiles).mockImplementation(async (provider) =>
      provider === "google-drive"
        ? [{ id: "g1", name: "vieja.ltpkg", sizeBytes: 1, modified: "2026-01-01T00:00:00Z" }]
        : [{ id: "d1", name: "nueva.ltpkg", sizeBytes: 1, modified: "2026-10-01T00:00:00Z" }],
    );
    await useCloudStore.getState().refreshPickerFiles("songs");

    // La cuenta sin conectar no se consulta.
    expect(listCloudFiles).toHaveBeenCalledTimes(2);
    const files = useCloudStore.getState().pickerFiles;
    expect(files.map((file) => [file.id, file.provider, file.providerName])).toEqual([
      ["d1", "dropbox", "Dropbox"],
      ["g1", "google-drive", "Google Drive"],
    ]);
  });

  it("una cuenta que falla no oculta las demas", async () => {
    vi.mocked(listCloudFiles).mockImplementation(async (provider) => {
      if (provider === "dropbox") throw new Error("the account is not connected");
      return [{ id: "g1", name: "a.ltpkg", sizeBytes: 1, modified: null }];
    });
    await useCloudStore.getState().refreshPickerFiles("songs");

    const state = useCloudStore.getState();
    expect(state.pickerFiles.map((file) => file.id)).toEqual(["g1"]);
    expect(state.error).toContain("not connected");
    expect(state.pickerLoading).toBe(false);
  });
});

describe("progreso de transferencia de nube", () => {
  beforeEach(() => {
    useCloudStore.getState().reset();
  });

  function startAt(atMs: number) {
    const transfer = { ...newTransfer("set.ltset", "upload"), sampledAtMs: atMs };
    useCloudStore.setState({ transfer });
  }

  it("calcula la velocidad a partir de dos muestras", () => {
    startAt(1_000);
    // 10 MiB en 2 s = 5 MiB/s.
    useCloudStore.getState().setTransferProgress(10_485_760, 104_857_600, 3_000);

    const transfer = useCloudStore.getState().transfer;
    expect(transfer?.bytesPerSecond).toBeCloseTo(5_242_880, 0);
    // Quedan 90 MiB a 5 MiB/s = 18 s.
    expect(transfer?.etaSeconds).toBeCloseTo(18, 0);
    expect(transfer?.percent).toBe(10);
  });

  /// Sin esta guarda, dos eventos separados por milisegundos dan una velocidad
  /// disparatada (un delta minúsculo entre un intervalo minúsculo) y el tiempo
  /// restante salta de forma ilegible.
  it("ignora muestras demasiado seguidas para el calculo de velocidad", () => {
    startAt(1_000);
    useCloudStore.getState().setTransferProgress(1_000, 104_857_600, 1_050);

    const transfer = useCloudStore.getState().transfer;
    expect(transfer?.bytesPerSecond).toBeNull();
    expect(transfer?.etaSeconds).toBeNull();
    // Los totales sí avanzan aunque la velocidad no se recalcule.
    expect(transfer?.doneBytes).toBe(1_000);
  });

  it("suaviza en vez de saltar al ultimo valor instantaneo", () => {
    startAt(0);
    useCloudStore.getState().setTransferProgress(10_485_760, 104_857_600, 1_000);
    const first = useCloudStore.getState().transfer?.bytesPerSecond ?? 0;

    // Segundo tramo diez veces más lento: el valor mostrado debe moverse hacia
    // él, no reemplazarlo de golpe.
    useCloudStore.getState().setTransferProgress(11_534_336, 104_857_600, 2_000);
    const second = useCloudStore.getState().transfer?.bytesPerSecond ?? 0;

    expect(second).toBeLessThan(first);
    expect(second).toBeGreaterThan(1_048_576);
  });

  /// Un evento que llega justo después de terminar no debe resucitar la barra.
  it("descarta progreso sin transferencia en curso", () => {
    useCloudStore.setState({ transfer: null });
    useCloudStore.getState().setTransferProgress(50, 100, Date.now());
    expect(useCloudStore.getState().transfer).toBeNull();
  });

  it("no divide por cero con un total desconocido", () => {
    startAt(0);
    useCloudStore.getState().setTransferProgress(0, 0, 1_000);
    expect(useCloudStore.getState().transfer?.percent).toBe(0);
  });
});

describe("cuenta activa", () => {
  beforeEach(() => {
    useCloudStore.getState().reset();
  });

  it("cambiar de cuenta vacia las listas de la anterior", () => {
    useCloudStore.setState({
      provider: "google-drive",
      quota: { usedBytes: 1, limitBytes: 2, freeBytes: 1 },
      files: { songs: [{ id: "g1", name: "a.ltpkg", sizeBytes: 1, modified: null }], sessions: [] },
    });
    useCloudStore.getState().setProvider("dropbox");
    const state = useCloudStore.getState();
    expect(state.provider).toBe("dropbox");
    expect(state.quota).toBeNull();
    expect(state.files.songs).toEqual([]);
  });

  it("una lista que llega despues de cambiar de cuenta se descarta", async () => {
    let answer!: (files: never[]) => void;
    vi.mocked(listCloudFiles).mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve as never)),
    );
    const pending = useCloudStore.getState().refreshFiles("songs");
    useCloudStore.getState().setProvider("onedrive");
    answer([{ id: "g1", name: "de-drive.ltpkg", sizeBytes: 1, modified: null }] as never);
    await pending;

    expect(listCloudFiles).toHaveBeenCalledWith("google-drive", "songs");
    expect(useCloudStore.getState().files.songs).toEqual([]);
  });
});
