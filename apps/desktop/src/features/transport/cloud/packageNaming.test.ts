import { describe, expect, it } from "vitest";

import {
  buildPackageFileName,
  describePackageMeta,
  parsePackageFileName,
} from "./packageNaming";
import {
  filterCloudFiles,
  availableKeys,
  availableTimeSignatures,
  NO_FILTERS,
} from "./cloudFileFilter";
import type { CloudFile } from "../desktopApi";

describe("nombres de paquete con metadatos", () => {
  it("escribe tempo, tonalidad y metrica en el nombre", () => {
    expect(
      buildPackageFileName("Cuan grande es El", ".ltpkg", {
        bpm: 72,
        key: "Am",
        timeSignature: "4/4",
      }),
    ).toBe("Cuan grande es El [72bpm Am 4-4].ltpkg");
  });

  /// `/` no puede aparecer en un nombre de archivo en ningun sistema.
  it("convierte la metrica a una forma valida como nombre", () => {
    const name = buildPackageFileName("X", ".ltpkg", { timeSignature: "6/8" });
    expect(name).toBe("X [6-8].ltpkg");
    expect(parsePackageFileName(name).timeSignature).toBe("6/8");
  });

  it("omite lo que no se sabe en vez de fallar", () => {
    expect(buildPackageFileName("Solo titulo", ".ltset", {})).toBe(
      "Solo titulo.ltset",
    );
    expect(buildPackageFileName("Medio", ".ltpkg", { bpm: 90 })).toBe(
      "Medio [90bpm].ltpkg",
    );
  });

  it("redondea el tempo y descarta valores absurdos", () => {
    expect(buildPackageFileName("X", ".ltpkg", { bpm: 128.4 })).toBe(
      "X [128bpm].ltpkg",
    );
    expect(buildPackageFileName("X", ".ltpkg", { bpm: 0 })).toBe("X.ltpkg");
    expect(buildPackageFileName("X", ".ltpkg", { bpm: NaN })).toBe("X.ltpkg");
  });

  /// Los caracteres prohibidos se sustituyen, no se borran: dos canciones que
  /// solo se diferencian en la puntuacion no deben acabar con el mismo nombre.
  it("sanea caracteres invalidos del titulo", () => {
    expect(buildPackageFileName('A/B: "C"', ".ltpkg", {})).toBe("A-B- -C-.ltpkg");
  });

  it("hace ida y vuelta", () => {
    const meta = { bpm: 140, key: "F#m", timeSignature: "3/4" };
    const parsed = parsePackageFileName(
      buildPackageFileName("Titulo", ".ltpkg", meta),
    );
    expect(parsed).toEqual({ title: "Titulo", ...meta });
  });

  it("lee un nombre sin metadatos como solo titulo", () => {
    expect(parsePackageFileName("Cancion vieja.ltpkg")).toEqual({
      title: "Cancion vieja",
    });
  });

  /// La gente renombra archivos en Drive a mano. Un grupo desordenado o
  /// incompleto debe rendir lo que si trae, no descartarse entero.
  it("tolera tokens desordenados o parciales", () => {
    expect(parsePackageFileName("X [Am 100bpm].ltpkg")).toEqual({
      title: "X",
      key: "Am",
      bpm: 100,
    });
    expect(parsePackageFileName("X [basura 4-4].ltpkg")).toEqual({
      title: "X",
      timeSignature: "4/4",
    });
  });

  it("describe lo conocido en una linea", () => {
    expect(describePackageMeta({ bpm: 72, key: "Am", timeSignature: "4/4" })).toBe(
      "72 bpm · Am · 4/4",
    );
    expect(describePackageMeta({})).toBe("");
  });
});

describe("filtrado de la nube", () => {
  const file = (name: string): CloudFile => ({
    id: name,
    name,
    sizeBytes: 1,
    modified: null,
  });
  const files = [
    file("Cuan grande es El [72bpm Am 4-4].ltpkg"),
    file("Canción nueva [120bpm C 4-4].ltpkg"),
    file("Vals [90bpm Am 3-4].ltpkg"),
    file("Sin datos.ltpkg"),
  ];

  it("sin filtros devuelve todo", () => {
    expect(filterCloudFiles(files, NO_FILTERS)).toHaveLength(4);
  });

  /// Escribir acentos con prisa, en el movil o en el portatil del escenario,
  /// es justo lo que no queremos exigir.
  it("busca ignorando acentos y mayusculas", () => {
    const found = filterCloudFiles(files, { ...NO_FILTERS, search: "CANCION" });
    expect(found.map((f) => f.meta.title)).toEqual(["Canción nueva"]);
  });

  it("filtra por tonalidad y por metrica", () => {
    expect(
      filterCloudFiles(files, { ...NO_FILTERS, key: "Am" }).map((f) => f.meta.title),
    ).toEqual(["Cuan grande es El", "Vals"]);
    expect(
      filterCloudFiles(files, { ...NO_FILTERS, timeSignature: "3/4" }).map(
        (f) => f.meta.title,
      ),
    ).toEqual(["Vals"]);
  });

  it("filtra por rango de tempo", () => {
    const found = filterCloudFiles(files, {
      ...NO_FILTERS,
      bpmMin: 80,
      bpmMax: 100,
    });
    expect(found.map((f) => f.meta.title)).toEqual(["Vals"]);
  });

  /// Un paquete sin tempo no puede demostrar que cumple el rango. Incluirlo en
  /// silencio haria el filtro poco fiable justo cuando importa.
  it("excluye lo que no declara tempo cuando se pide un rango", () => {
    const found = filterCloudFiles(files, { ...NO_FILTERS, bpmMin: 1 });
    expect(found.map((f) => f.meta.title)).not.toContain("Sin datos");
  });

  it("ofrece solo las tonalidades y metricas presentes", () => {
    const all = filterCloudFiles(files, NO_FILTERS);
    expect(availableKeys(all)).toEqual(["Am", "C"]);
    expect(availableTimeSignatures(all)).toEqual(["3/4", "4/4"]);
  });
});
