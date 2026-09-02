import { beforeEach, describe, expect, it, vi } from "vitest";

import { beginExportWithChoice, cancelExportChoice, finishExportWithChoice } from "./cloudFlows";
import { useCloudStore } from "./cloudStore";

/**
 * El destino de una exportacion vive en el store porque se pregunta ANTES de
 * abrir el selector de modo y se usa DESPUES de cerrarlo. Ese hueco es donde
 * se puede quedar pegado, y de ahi estos tests.
 */
describe("destino de exportacion", () => {
  beforeEach(() => {
    useCloudStore.getState().reset();
  });

  /** Responde la pregunta local/Drive como haria el modal. */
  function answer(choice: "local" | "cloud" | null) {
    const pending = useCloudStore.getState().pendingChoice;
    if (!pending) throw new Error("no hay pregunta pendiente");
    pending.resolve(choice);
  }

  it("guarda la eleccion y abre el selector de modo", async () => {
    const openModeChooser = vi.fn();
    const flow = beginExportWithChoice("session", openModeChooser);
    answer("cloud");
    await flow;

    expect(useCloudStore.getState().exportTarget).toBe("cloud");
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
    answer("cloud");
    await flow;
    expect(useCloudStore.getState().exportTarget).toBe("cloud");

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
