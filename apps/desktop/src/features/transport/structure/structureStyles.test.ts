import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Contrato de estilos del editor de arreglos. jsdom no maqueta, así que el
 * desbordamiento no se puede medir en un test: se fija la regla que lo evita.
 */
const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "structure.css"), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`).exec(css);
  expect(match, `falta la regla ${selector}`).toBeTruthy();
  return match?.[1] ?? "";
}

describe("estilos del editor de arreglos", () => {
  it("la columna del editor no crece con la tira de bloques", () => {
    // Sin esto la tira ensanchaba el editor más que el panel: la paleta se
    // salía por la derecha sin scroll y el final de la tira quedaba cortado.
    expect(rule(".lt-structure-editor")).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(rule(".lt-structure-panel")).toContain("overflow-x: hidden");
  });

  it("la paleta hace scroll propio en escritorio y ninguno en móvil", () => {
    const chips = rule(".lt-structure-chips");
    expect(chips).toContain("max-height");
    expect(chips).toContain("overflow-y: auto");
    // Móvil: un solo scroller por superficie.
    expect(rule(".lt-structure-chips.is-tap")).toContain("overflow: visible");
  });

  it("los botones primarios usan el degradado de la app", () => {
    expect(css).toContain("background: linear-gradient(to bottom, #57f1db, #2dd4bf)");
  });

  it("en la tablet la lista ocupa todo el ancho (no queda una rejilla de paleta)", () => {
    // Sin paleta lateral, una rejilla de dos columnas dejaba la lista en el
    // tercio izquierdo de la pantalla.
    expect(css).not.toMatch(/\.lt-structure-mobile\.is-wide \.lt-structure-mobile-split\s*\{/);
  });
});
