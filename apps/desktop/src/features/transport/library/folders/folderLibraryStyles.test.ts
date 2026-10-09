import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * jsdom no maqueta: el desbordamiento no se puede medir en un test, así que se
 * fija la regla que lo evita.
 */
const css = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "folderLibrary.css"),
  "utf8",
);

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`).exec(css);
  expect(match, `falta la regla ${selector}`).toBeTruthy();
  return match?.[1] ?? "";
}

describe("biblioteca clásica dentro de «En esta sesión»", () => {
  it("encoge con la columna en vez de salirse por la derecha", () => {
    // Sin min-width: 0 el hijo flex no bajaba de su contenido y cortaba
    // «Importar audio» y los nombres de las carpetas.
    const nested = rule(".lt-folder-library .lt-folder-library-session-body > .lt-library-panel");
    expect(nested).toContain("min-width: 0");
    expect(nested).toContain("width: auto");
  });

  // iPhone: the classic library squeezed under the folders was unusable.
  it("en el móvil, abierta, ocupa todo el alto de la biblioteca", () => {
    expect(rule(".lt-mobile .lt-folder-library.is-session-open .lt-folder-library-session")).toContain(
      "flex: 1 1 auto",
    );
    expect(css).toMatch(
      /\.lt-mobile \.lt-folder-library\.is-session-open \.lt-folder-library-places[^{]*\{\s*display: none/,
    );
  });
});
