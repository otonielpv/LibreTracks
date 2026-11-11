import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  discardStagedPackage,
  downloadFromCloud,
  importSessionTemplateFrom,
  pickAndImportSessionTemplate,
  saveSessionAsTemplate,
  saveSessionAsTemplateAt,
  uploadToCloud,
} from "../desktopApi";
import { useCloudStore } from "../cloud/cloudStore";
import {
  importTemplateWithChoice,
  saveTemplateWithChoice,
  templateFileName,
  uploadTemplateToCloud,
  useTemplateCatalogStore,
} from "./templateTransfer";

vi.mock("../../telemetry/telemetry", () => ({ recordProductEvent: vi.fn() }));

vi.mock("../desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../desktopApi")>()),
  getCloudStagingDir: vi.fn(async () => "/cache/cloud-staging"),
  downloadFromCloud: vi.fn(),
  discardStagedPackage: vi.fn(async () => {}),
  uploadToCloud: vi.fn(),
  listCloudFiles: vi.fn(async () => []),
  getCloudQuota: vi.fn(async () => ({ usedBytes: 0, limitBytes: null, freeBytes: null })),
  pickAndImportSessionTemplate: vi.fn(),
  importSessionTemplateFrom: vi.fn(),
  saveSessionAsTemplate: vi.fn(),
  saveSessionAsTemplateAt: vi.fn(async () => true),
}));

const BANDA = { name: "Banda", path: "/data/templates/Banda.lttemplate" };

/** Responde la pregunta «este equipo o la nube» como haria el modal. */
async function answer(choice: "local" | "cloud" | "google-drive" | null) {
  await vi.waitFor(() => expect(useCloudStore.getState().pendingChoice).not.toBeNull());
  useCloudStore.getState().pendingChoice!.resolve(choice);
}

describe("plantillas en la nube", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCloudStore.getState().reset();
    useTemplateCatalogStore.setState({ version: 0 });
  });

  it("importar desde este equipo abre el selector y refresca las listas", async () => {
    vi.mocked(pickAndImportSessionTemplate).mockResolvedValue(BANDA);

    const flow = importTemplateWithChoice();
    expect(useCloudStore.getState().pendingChoice?.kind).toBe("template");
    await answer("local");

    expect(await flow).toEqual(BANDA);
    expect(useTemplateCatalogStore.getState().version).toBe(1);
  });

  it("cancelar el selector de archivo no toca las listas", async () => {
    vi.mocked(pickAndImportSessionTemplate).mockResolvedValue(null);

    const flow = importTemplateWithChoice();
    await answer("local");

    expect(await flow).toBeNull();
    expect(useTemplateCatalogStore.getState().version).toBe(0);
  });

  it("importar desde la nube busca en Templates, copia al catalogo y borra la descarga", async () => {
    useCloudStore.setState({ refreshPickerFiles: async () => {} });
    vi.mocked(downloadFromCloud).mockResolvedValue("/cache/cloud-staging/Banda.lttemplate");
    vi.mocked(importSessionTemplateFrom).mockResolvedValue(BANDA);

    const flow = importTemplateWithChoice();
    await answer("cloud");
    await vi.waitFor(() => expect(useCloudStore.getState().pendingPick).not.toBeNull());
    expect(useCloudStore.getState().pendingPick!.folder).toBe("templates");
    useCloudStore.getState().pendingPick!.resolve({
      id: "f1",
      name: "Banda.lttemplate",
      sizeBytes: 900,
      modified: null,
      provider: "google-drive",
      providerName: "Google Drive",
    });

    expect(await flow).toEqual(BANDA);
    expect(importSessionTemplateFrom).toHaveBeenCalledWith("/cache/cloud-staging/Banda.lttemplate");
    expect(discardStagedPackage).toHaveBeenCalledWith("/cache/cloud-staging/Banda.lttemplate");
  });

  it("subir una plantilla pregunta solo la cuenta y sube el archivo del catalogo", async () => {
    vi.mocked(uploadToCloud).mockResolvedValue({
      id: "u1",
      name: "Banda.lttemplate",
      sizeBytes: 900,
      modified: null,
    });

    const flow = uploadTemplateToCloud(BANDA);
    expect(useCloudStore.getState().pendingChoice?.cloudOnly).toBe(true);
    await answer("google-drive");

    expect(await flow).toBe(true);
    expect(uploadToCloud).toHaveBeenCalledWith("google-drive", BANDA.path);
  });

  it("guardar como plantilla en este equipo usa el dialogo de siempre", async () => {
    vi.mocked(saveSessionAsTemplate).mockResolvedValue(true);

    const flow = saveTemplateWithChoice("Domingo");
    await answer("local");

    expect(await flow).toBe(true);
    expect(saveSessionAsTemplateAt).not.toHaveBeenCalled();
    expect(uploadToCloud).not.toHaveBeenCalled();
  });

  it("guardar como plantilla en la nube deja copia en el catalogo y la sube", async () => {
    vi.mocked(importSessionTemplateFrom).mockResolvedValue(BANDA);
    vi.mocked(uploadToCloud).mockResolvedValue({
      id: "u2",
      name: "Domingo.lttemplate",
      sizeBytes: 900,
      modified: null,
    });

    const flow = saveTemplateWithChoice("Domingo");
    await answer("google-drive");

    expect(await flow).toBe(true);
    const staged = "/cache/cloud-staging/Domingo.lttemplate";
    expect(saveSessionAsTemplateAt).toHaveBeenCalledWith(staged);
    expect(importSessionTemplateFrom).toHaveBeenCalledWith(staged);
    expect(uploadToCloud).toHaveBeenCalledWith("google-drive", staged);
    expect(discardStagedPackage).toHaveBeenCalledWith(staged);
    expect(useTemplateCatalogStore.getState().version).toBe(1);
  });

  it("el nombre de archivo no lleva caracteres prohibidos", () => {
    expect(templateFileName('Banda: "A/B"')).toBe("Banda- -A-B-.lttemplate");
    expect(templateFileName("   ")).toBe("Plantilla.lttemplate");
  });
});
