import { beforeEach, describe, expect, it, vi } from "vitest";

import { discardStagedPackage, downloadFromCloud } from "../desktopApi";
import {
  beginExportWithChoice,
  cancelExportChoice,
  finishExportWithChoice,
  importFromCloud,
  importSongWithChoice,
} from "./cloudFlows";
import { useCloudStore } from "./cloudStore";
import { recordProductEvent } from "../../telemetry/telemetry";

vi.mock("../../telemetry/telemetry", () => ({ recordProductEvent: vi.fn() }));

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  getCloudStagingDir: vi.fn(async () => "/cache/cloud-staging"),
  downloadFromCloud: vi.fn(),
  discardStagedPackage: vi.fn(async () => {}),
}));

/**
 * El destino de una exportacion vive en el store porque se pregunta ANTES de
 * abrir el selector de modo y se usa DESPUES de cerrarlo. Ese hueco es donde
 * se puede quedar pegado, y de ahi estos tests.
 */
describe("destino de exportacion", () => {
  beforeEach(() => {
    useCloudStore.getState().reset();
  });

  /** Responde la pregunta local/nube como haria el modal. */
  function answer(choice: "local" | "google-drive" | "dropbox" | null) {
    const pending = useCloudStore.getState().pendingChoice;
    if (!pending) throw new Error("no hay pregunta pendiente");
    pending.resolve(choice);
  }

  it("guarda la eleccion y abre el selector de modo", async () => {
    const openModeChooser = vi.fn();
    const flow = beginExportWithChoice("session", openModeChooser);
    answer("google-drive");
    await flow;

    expect(useCloudStore.getState().exportTarget).toBe("google-drive");
    expect(openModeChooser).toHaveBeenCalledOnce();
  });

  it("no abre el selector de modo si se cierra la pregunta", async () => {
    const openModeChooser = vi.fn();
    const flow = beginExportWithChoice("session", openModeChooser);
    answer(null);
    await flow;

    expect(openModeChooser).not.toHaveBeenCalled();
    expect(useCloudStore.getState().exportTarget).toBeNull();
  });

  /// El bug real: cancelar el selector de MODO dejaba el destino puesto, y la
  /// siguiente exportacion se iba a Drive sin preguntar nada.
  it("cancelar el selector de modo olvida el destino", async () => {
    const flow = beginExportWithChoice("session", () => {});
    answer("google-drive");
    await flow;
    expect(useCloudStore.getState().exportTarget).toBe("google-drive");

    cancelExportChoice();
    expect(useCloudStore.getState().exportTarget).toBeNull();
  });

  it("sin destino, exporta en local: no toca la nube", async () => {
    const runExport = vi.fn();
    await finishExportWithChoice("x.ltset", runExport);

    // Sin ruta = dialogo de guardar de siempre. Recibirla significaria que se
    // ha ido a la carpeta de paso para subirla.
    expect(runExport).toHaveBeenCalledWith();
  });

  it("gastar el destino lo deja limpio para la siguiente", async () => {
    const flow = beginExportWithChoice("song", () => {});
    answer("local");
    await flow;

    await finishExportWithChoice("x.ltpkg", vi.fn());
    expect(useCloudStore.getState().exportTarget).toBeNull();
  });
});

/**
 * El paquete bajado de Drive solo existe para importarlo. Antes se quedaba en
 * la carpeta de paso para siempre: una sesion de 10 canciones ocupaba su
 * tamano entero en la cache, junto a la sesion en la que se habia convertido.
 */
describe("paquete de paso de una importacion desde Drive", () => {
  const file = {
    id: "f1",
    name: "testanalisis.ltset",
    sizeBytes: 1,
    provider: "google-drive",
    providerName: "Google Drive",
  } as never;
  const staged = "/cache/cloud-staging/testanalisis.ltset";

  beforeEach(() => {
    useCloudStore.getState().reset();
    useCloudStore.setState({
      refreshPickerFiles: async () => {},
      refreshQuota: async () => {},
    } as never);
    vi.mocked(downloadFromCloud).mockReset().mockResolvedValue(staged);
    vi.mocked(discardStagedPackage).mockClear();
    vi.mocked(recordProductEvent).mockClear();
  });

  /** Elige el archivo en el selector como haria el modal. */
  async function pick() {
    await vi.waitFor(() => expect(useCloudStore.getState().pendingPick).not.toBeNull());
    useCloudStore.getState().pendingPick!.resolve(file);
  }

  it("se borra cuando la importacion ha terminado, no antes", async () => {
    let finishImport!: () => void;
    const runImport = vi.fn(
      () => new Promise<void>((resolve) => (finishImport = resolve)),
    );
    const flow = importFromCloud("sessions", runImport);
    await pick();
    await vi.waitFor(() => expect(runImport).toHaveBeenCalledWith(staged));

    // Aun descomprimiendo: borrarlo ahora romperia la importacion.
    expect(discardStagedPackage).not.toHaveBeenCalled();

    finishImport();
    expect(await flow).toBe(true);
    expect(discardStagedPackage).toHaveBeenCalledWith(staged);
    expect(recordProductEvent).toHaveBeenCalledWith("feature_cloud");
  });

  it("la importacion de una cancion pregunta el origen y reusa el importador con la ruta descargada", async () => {
    const runImport = vi.fn(async (_sourcePath?: string) => {});
    const flow = importSongWithChoice(runImport);
    const choice = useCloudStore.getState().pendingChoice;
    expect(choice).toMatchObject({ intent: "import", kind: "song" });

    choice!.resolve("cloud");
    await pick();
    await flow;

    expect(runImport).toHaveBeenCalledWith(staged);
    expect(discardStagedPackage).toHaveBeenCalledWith(staged);
  });

  it("se borra tambien si la importacion falla", async () => {
    const flow = importFromCloud("sessions", async () => {
      throw new Error("zip corrupto");
    });
    await pick();

    expect(await flow).toBe(false);
    expect(discardStagedPackage).toHaveBeenCalledWith(staged);
  });
});

/**
 * Con varias cuentas conectadas, la eleccion del usuario decide a cual se
 * habla. Equivocarse aqui sube la sesion a Drive cuando se eligio Dropbox.
 */
describe("varias cuentas", () => {
  beforeEach(() => {
    useCloudStore.getState().reset();
    vi.mocked(downloadFromCloud).mockReset().mockResolvedValue("/cache/cloud-staging/x.ltset");
  });

  /// El selector de importar mezcla todas las cuentas: lo que manda es la
  /// cuenta del archivo elegido, no la que tenga abierta el panel.
  it("importar descarga de la cuenta del archivo elegido", async () => {
    useCloudStore.setState({
      refreshPickerFiles: async () => {},
      refreshQuota: async () => {},
    } as never);
    const flow = importSongWithChoice(async () => {});
    useCloudStore.getState().pendingChoice!.resolve("cloud");
    // "cloud" no es una cuenta: no cambia la cuenta de trabajo del panel.
    expect(useCloudStore.getState().provider).toBe("google-drive");

    await vi.waitFor(() => expect(useCloudStore.getState().pendingPick).not.toBeNull());
    useCloudStore.getState().pendingPick!.resolve({
      id: "id:a",
      name: "x.ltpkg",
      sizeBytes: 1,
      provider: "dropbox",
      providerName: "Dropbox",
    } as never);
    await flow;

    expect(downloadFromCloud).toHaveBeenCalledWith("dropbox", "id:a", "x.ltpkg", "/cache/cloud-staging");
  });

  it("una exportacion va a la cuenta elegida aunque se cambie de cuenta en medio", async () => {
    const upload = vi.fn(async () => null);
    useCloudStore.setState({ upload } as never);
    const opened = vi.fn();
    const begun = beginExportWithChoice("session", opened);
    useCloudStore.getState().pendingChoice!.resolve("onedrive");
    await begun;
    expect(opened).toHaveBeenCalled();

    // Entre el selector de modo y la exportacion, el panel cambia a Drive.
    useCloudStore.getState().setProvider("google-drive");
    let providerAtUpload: string | null = null;
    upload.mockImplementation(async () => {
      providerAtUpload = useCloudStore.getState().provider;
      return null;
    });
    await finishExportWithChoice("Set.ltset", async () => {});

    expect(upload).toHaveBeenCalledWith("/cache/cloud-staging/Set.ltset");
    expect(providerAtUpload).toBe("onedrive");
  });
});
