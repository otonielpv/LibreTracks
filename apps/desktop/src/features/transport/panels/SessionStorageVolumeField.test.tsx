// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StorageVolumesInfo } from "@libretracks/shared/desktopApi";

/**
 * Paso 05 del plan de feedback de testers: elegir en qué volumen viven las
 * sesiones.
 *
 * Lo que este test fija es el contrato de la interfaz, que es donde está el
 * riesgo de regresión: **el control no debe existir cuando no hay nada que
 * elegir**. En un teléfono sin ranura de microSD —y en escritorio e iOS, donde
 * la lista viene vacía— enseñar un desplegable con una sola opción sería
 * ruido, y el criterio del paso lo prohíbe explícitamente.
 */
const getStorageVolumes = vi.fn<() => Promise<StorageVolumesInfo>>();
const setSessionStorageVolume = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      typeof options?.defaultValue === "string"
        ? (options.defaultValue as string).replace(
            /\{\{(\w+)\}\}/g,
            (_match, name: string) => String(options[name] ?? ""),
          )
        : key,
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

vi.mock("@libretracks/shared/desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@libretracks/shared/desktopApi")>()),
  isMobileApp: true,
  isAndroidApp: true,
  getStorageVolumes: () => getStorageVolumes(),
  setSessionStorageVolume: (volume: string | null) =>
    setSessionStorageVolume(volume),
}));

const { SessionStorageVolumeField } = await import(
  "./SessionStorageVolumeField"
);

const INTERNAL = "/storage/emulated/0/Android/data/com.libretracks.app/files";
const CARD = "/storage/1A2B-3C4D/Android/data/com.libretracks.app/files";

function info(overrides: Partial<StorageVolumesInfo> = {}): StorageVolumesInfo {
  return {
    volumes: [
      {
        path: INTERNAL,
        index: 0,
        label: "Almacenamiento interno compartido",
        freeBytes: 3 * 1024 ** 3,
        totalBytes: 64 * 1024 ** 3,
      },
      {
        path: CARD,
        index: 1,
        label: "Tarjeta SD SanDisk",
        freeBytes: 100 * 1024 ** 3,
        totalBytes: 128 * 1024 ** 3,
      },
    ],
    selected: null,
    effective: INTERNAL,
    selectedAvailable: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setSessionStorageVolume.mockResolvedValue({});
});
afterEach(cleanup);

describe("dónde guardar las sesiones", () => {
  it("no se enseña cuando el aparato tiene un solo volumen", async () => {
    getStorageVolumes.mockResolvedValue(
      info({ volumes: [info().volumes[0]] }),
    );

    const { container } = render(<SessionStorageVolumeField />);
    await waitFor(() => expect(getStorageVolumes).toHaveBeenCalled());

    expect(container.querySelector("select")).toBeNull();
  });

  it("no se enseña en escritorio, donde no hay volúmenes que listar", async () => {
    getStorageVolumes.mockResolvedValue(
      info({ volumes: [], effective: null }),
    );

    const { container } = render(<SessionStorageVolumeField />);
    await waitFor(() => expect(getStorageVolumes).toHaveBeenCalled());

    expect(container.querySelector("select")).toBeNull();
  });

  it("ofrece los dos volúmenes con su espacio libre", async () => {
    getStorageVolumes.mockResolvedValue(info());

    render(<SessionStorageVolumeField />);
    const select = await screen.findByRole("combobox");

    const options = [...select.querySelectorAll("option")].map(
      (option) => option.textContent,
    );
    expect(options).toEqual([
      "Memoria interna — 3.0 GB libres de 64.0 GB",
      "Tarjeta SD SanDisk — 100 GB libres de 128 GB",
    ]);
  });

  // Visto en el telefono: un pendrive por OTG salia como "Tarjeta SD". El
  // indice solo distingue interno/extraible; el nombre de un extraible lo da
  // Android, y sin el se usa uno generico que no mienta.
  it("nombra cada extraible como lo llama Android, no siempre tarjeta SD", async () => {
    const USB = "/storage/5E1F-0A9B/Android/data/com.libretracks.app/files";
    getStorageVolumes.mockResolvedValue(
      info({
        volumes: [
          ...info().volumes,
          { path: USB, index: 2, label: "Unidad USB Kingston", freeBytes: null, totalBytes: null },
          { path: USB + "2", index: 3, label: null, freeBytes: null, totalBytes: null },
        ],
      }),
    );

    render(<SessionStorageVolumeField />);
    const select = await screen.findByRole("combobox");

    const options = [...select.querySelectorAll("option")].map(
      (option) => option.textContent,
    );
    expect(options.slice(2)).toEqual([
      "Unidad USB Kingston",
      "Almacenamiento externo",
    ]);
  });

  it("guarda la tarjeta cuando se elige, y el primario como null", async () => {
    getStorageVolumes.mockResolvedValue(info());

    render(<SessionStorageVolumeField />);
    const select = await screen.findByRole("combobox");

    fireEvent.change(select, { target: { value: CARD } });
    await waitFor(() =>
      expect(setSessionStorageVolume).toHaveBeenCalledWith(CARD),
    );

    // El primario se guarda como `null`, no como su ruta: así una ruta que
    // cambie de nombre entre versiones de Android no deja el ajuste apuntando
    // a un sitio que ya no existe.
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() =>
      expect(setSessionStorageVolume).toHaveBeenLastCalledWith(null),
    );
  });

  it("avisa cuando el volumen elegido no está (tarjeta fuera)", async () => {
    getStorageVolumes.mockResolvedValue(
      info({ selected: CARD, selectedAvailable: false, effective: INTERNAL }),
    );

    render(<SessionStorageVolumeField />);

    expect((await screen.findByRole("status")).textContent).toMatch(
      /no está disponible/i,
    );
  });

  it("no avisa de nada cuando el volumen elegido sí está", async () => {
    getStorageVolumes.mockResolvedValue(
      info({ selected: CARD, selectedAvailable: true, effective: CARD }),
    );

    render(<SessionStorageVolumeField />);
    await screen.findByRole("combobox");

    expect(screen.queryByRole("status")).toBeNull();
  });
});
