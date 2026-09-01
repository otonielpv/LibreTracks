// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * El ajuste de caché de audio en un teléfono.
 *
 * "Cambiar…" abre `open({ directory: true })`, y en móvil el plugin de
 * diálogos devuelve `FolderPickerNotImplemented`: el botón sólo sabía fallar.
 * Y aunque existiera el selector, escribir fuera del almacenamiento propio de
 * la app pediría MANAGE_EXTERNAL_STORAGE, que Google Play no concede a un DAW
 * (ver AndroidManifest.xml). Lo que sí sigue siendo accionable — el límite de
 * tamaño y vaciar la caché — se queda.
 */

const getDecodingCacheInfo = vi.fn();
const purgeDecodingCache = vi.fn();
const setDecodingCacheDir = vi.fn();
const setDecodingCacheMaxGb = vi.fn();

const platform = { isMobileApp: false };

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => {
    throw new Error("folder picker not implemented on mobile");
  }),
}));

vi.mock("@libretracks/shared/desktopApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@libretracks/shared/desktopApi")>()),
  get isMobileApp() {
    return platform.isMobileApp;
  },
  isAndroidApp: false,
  getDecodingCacheInfo: () => getDecodingCacheInfo(),
  purgeDecodingCache: () => purgeDecodingCache(),
  setDecodingCacheDir: (dir: string | null) => setDecodingCacheDir(dir),
  setDecodingCacheMaxGb: (gb: number | null) => setDecodingCacheMaxGb(gb),
}));

const { DecodingCacheField } = await import("./SettingsPanel");

describe("DecodingCacheField / móvil", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.isMobileApp = false;
    getDecodingCacheInfo.mockResolvedValue({
      dir: "/storage/emulated/0/Android/data/com.libretracks.app/files/cache",
      sizeBytes: 1024,
      maxGb: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("no ofrece elegir carpeta en el móvil, pero sí el límite y el vaciado", async () => {
    platform.isMobileApp = true;
    render(<DecodingCacheField />);
    await waitFor(() => expect(getDecodingCacheInfo).toHaveBeenCalled());

    expect(screen.queryByRole("button", { name: "Change…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Default" })).toBeNull();
    expect(screen.getByRole("button", { name: "Set limit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear cache" })).toBeTruthy();
    // La ruta sigue a la vista: saber DÓNDE ocupa sitio es la mitad de por qué
    // se abre este ajuste.
    expect(
      screen.getByLabelText("Cache location").getAttribute("value") ??
        (screen.getByLabelText("Cache location") as HTMLInputElement).value,
    ).toContain("/files/cache");
  });

  it("mantiene el selector de carpeta en escritorio", async () => {
    render(<DecodingCacheField />);
    await waitFor(() => expect(getDecodingCacheInfo).toHaveBeenCalled());

    expect(screen.getByRole("button", { name: "Change…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Default" })).toBeTruthy();
  });
});
