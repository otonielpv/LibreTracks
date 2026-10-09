import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Contrato de color de las filas de la vista Live. jsdom no pinta, así que no
 * se puede mirar el resultado: se fijan las reglas que lo producen.
 */
const css = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "LivePerformanceView.css"),
  "utf8",
);

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`).exec(css);
  expect(match, `falta la regla ${selector}`).toBeTruthy();
  return match?.[1] ?? "";
}

describe("colores de las marcas en la vista Live", () => {
  it("el color de la marca tiñe el fondo de la fila, no solo una franja", () => {
    // Antes el color solo salía en una franja de 3 px y en el número: todas
    // las filas parecían iguales sobre fondo casi negro.
    expect(rule(".lt-live-cue-row")).toMatch(
      /background:[^;]*var\(--lt-live-marker-color\)/,
    );
    expect(rule(".lt-live-cue-row::before")).toContain("width: 6px");
  });

  it("los estados conservan el tinte y se distinguen por el borde", () => {
    // Pintar el fondo de turquesa o ámbar taparía el color de la marca.
    expect(rule(".lt-live-cue-row.is-active")).toMatch(
      /background:[^;]*var\(--lt-live-marker-color\)/,
    );
    expect(rule(".lt-live-cue-row.is-active")).toContain("border-color: #57f1db");
    expect(rule(".lt-live-cue-row.is-pending")).toContain("border-color: #f4c95d");
    expect(rule(".lt-live-cue-row.is-pending")).not.toContain("background");
  });

  it("no usa color-mix(), que Safari 15 no soporta", () => {
    // Sin comentarios: el propio CSS explica por qué no lo usa.
    const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toContain("color-mix(");
  });
});
