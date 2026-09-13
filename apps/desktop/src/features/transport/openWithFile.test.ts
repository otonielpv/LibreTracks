import { describe, expect, it, vi } from "vitest";

import type { OpenWithFile } from "./desktopApi";
import {
  dispatchOpenWithFile,
  openWithFileName,
  type OpenWithDeps,
} from "./openWithFile";

function makeDeps(overrides: Partial<OpenWithDeps> = {}) {
  const deps: OpenWithDeps = {
    hasOpenSession: () => true,
    openSession: vi.fn(),
    importSet: vi.fn(),
    createFromTemplate: vi.fn(),
    importSongPackage: vi.fn(),
    warnSongPackageNeedsSession: vi.fn(),
    ...overrides,
  };
  return deps;
}

/** Todos los flujos que NO deberían haberse disparado. */
function othersUntouched(deps: OpenWithDeps, ...called: (keyof OpenWithDeps)[]) {
  const flows = [
    "openSession",
    "importSet",
    "createFromTemplate",
    "importSongPackage",
    "warnSongPackageNeedsSession",
  ] as const;
  for (const flow of flows) {
    if (called.includes(flow)) {
      continue;
    }
    expect(deps[flow], `${flow} no debería haberse llamado`).not.toHaveBeenCalled();
  }
}

describe("dispatchOpenWithFile", () => {
  it("abre una sesión .ltsession tal cual", () => {
    const deps = makeDeps();
    const file: OpenWithFile = {
      path: "D:/Sesiones/Domingo/Domingo.ltsession",
      kind: "session",
    };

    dispatchOpenWithFile(file, deps);

    expect(deps.openSession).toHaveBeenCalledWith(
      "D:/Sesiones/Domingo/Domingo.ltsession",
    );
    othersUntouched(deps, "openSession");
  });

  it("importa un .ltset en vez de intentar abrirlo", () => {
    // Un .ltset es un zip: no se abre en sitio, hay que descomprimirlo antes.
    const deps = makeDeps();

    dispatchOpenWithFile({ path: "D:/Directo.ltset", kind: "set" }, deps);

    expect(deps.importSet).toHaveBeenCalledWith("D:/Directo.ltset");
    othersUntouched(deps, "importSet");
  });

  it("crea una sesión nueva desde una .lttemplate", () => {
    const deps = makeDeps();

    dispatchOpenWithFile({ path: "D:/Banda.lttemplate", kind: "template" }, deps);

    expect(deps.createFromTemplate).toHaveBeenCalledWith("D:/Banda.lttemplate");
    othersUntouched(deps, "createFromTemplate");
  });

  it("mete un .ltpkg en la sesión abierta", () => {
    const deps = makeDeps({ hasOpenSession: () => true });

    dispatchOpenWithFile({ path: "D:/Cancion.ltpkg", kind: "songPackage" }, deps);

    expect(deps.importSongPackage).toHaveBeenCalledWith("D:/Cancion.ltpkg");
    othersUntouched(deps, "importSongPackage");
  });

  it("sin sesión abierta, un .ltpkg avisa y no importa nada", () => {
    // Es el único tipo que puede no tener destino: una canción necesita una
    // sesión que la aloje, y crearla por nuestra cuenta sería adivinar.
    const deps = makeDeps({ hasOpenSession: () => false });

    dispatchOpenWithFile(
      { path: "D:/Musica/Sublime Gracia.ltpkg", kind: "songPackage" },
      deps,
    );

    expect(deps.warnSongPackageNeedsSession).toHaveBeenCalledWith(
      "Sublime Gracia.ltpkg",
    );
    othersUntouched(deps, "warnSongPackageNeedsSession");
  });

  it("consulta la sesión en el momento del despacho, no al construirse", () => {
    // El oyente vive todo el proceso: si la respuesta se congelara al montarlo,
    // el primer .ltpkg tras abrir una sesión seguiría diciendo que no hay.
    let sessionOpen = false;
    const deps = makeDeps({ hasOpenSession: () => sessionOpen });
    const file: OpenWithFile = { path: "D:/Cancion.ltpkg", kind: "songPackage" };

    dispatchOpenWithFile(file, deps);
    expect(deps.importSongPackage).not.toHaveBeenCalled();

    sessionOpen = true;
    dispatchOpenWithFile(file, deps);
    expect(deps.importSongPackage).toHaveBeenCalledWith("D:/Cancion.ltpkg");
  });
});

describe("openWithFileName", () => {
  it("recorta la ruta con las dos barras", () => {
    // El mismo front corre en los tres sistemas y la ruta llega tal cual la dio
    // el sistema operativo.
    expect(openWithFileName("D:\\Sesiones\\Domingo.ltsession")).toBe(
      "Domingo.ltsession",
    );
    expect(openWithFileName("/Users/ana/Musica/Domingo.ltset")).toBe(
      "Domingo.ltset",
    );
  });

  it("deja pasar un nombre suelto", () => {
    expect(openWithFileName("Domingo.ltpkg")).toBe("Domingo.ltpkg");
  });
});
