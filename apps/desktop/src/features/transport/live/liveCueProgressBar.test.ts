import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * La barra de progreso de la fila de marcas tiene que sobrevivir al caso denso.
 *
 * La fila es una columna flex de contenido variable: nombre, insignia de aviso,
 * la lista de avisos, la cuenta atras de "siguiente en" y la barra. La barra es
 * el ultimo hijo y el mas bajo, asi que es lo primero que flexbox comprime
 * cuando la fila va apretada — justo el caso en que hace falta verla. Un tester
 * la reporto "pegada abajo y casi invisible" en un Oppo Reno 11.
 *
 * Esto se fija leyendo el CSS, y no montando el componente, a proposito: jsdom
 * no calcula maquetacion, asi que un test de DOM daria verde con el fallo
 * puesto. Lo que si se puede fijar es la decision.
 */
// Igual que `fileSizeBudget.test.ts`: la ruta se resuelve desde el directorio
// del propio test. `new URL(..., import.meta.url)` no vale aqui, porque bajo la
// configuracion de la suite `import.meta.url` no siempre es un `file:`.
const css = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "LivePerformanceView.css"),
  "utf8",
)
  // Fuera los comentarios antes de mirar nada: llevan dos puntos y punto y coma
  // dentro, y el lector de abajo los confundiria con declaraciones.
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** La declaracion `property` del primer bloque cuyo selector es `selector`. */
function declaration(selector: string, property: string): string | null {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return null;
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  if (open < 0 || close < 0) return null;
  const body = css.slice(open + 1, close);
  for (const line of body.split(";")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    if (line.slice(0, colon).trim() !== property) continue;
    return line.slice(colon + 1).trim();
  }
  return null;
}

describe("barra de progreso de la fila de marcas de la vista Live", () => {
  it("la fila sigue reservando su alto de siempre cuando el contenido es corto", () => {
    // El minimo es lo que mantiene uniformes las filas normales; si se perdiera,
    // la lista quedaria irregular aunque ya no recortara nada.
    expect(declaration(".lt-live-cue-row", "min-height")).toBe("3.8rem");
  });

  it("la barra de progreso no encoge cuando la fila va apretada", () => {
    // Sin esto, flexbox la comprime hasta hacerla desaparecer justo en el caso
    // denso, que es precisamente cuando hace falta verla.
    expect(declaration(".lt-live-cue-progress", "flex")).toBe("0 0 auto");
  });

  // El carril —el fondo sobre el que corre el relleno— tiene que verse entero,
  // lleno o no: es lo unico que dice DONDE ACABA el recorrido, o sea cuanto
  // queda. Las dos barras de la vista lo tenian en negro translucido sobre un
  // fondo casi negro, asi que solo se distinguia el trozo lleno.
  for (const selector of [
    ".lt-live-cue-progress",
    ".lt-live-song-progress-track",
  ]) {
    it(`el carril de ${selector} contrasta con el fondo oscuro`, () => {
      const background = declaration(selector, "background");
      expect(background).not.toBeNull();
      expect(background).toContain("255 255 255");
    });
  }
});
