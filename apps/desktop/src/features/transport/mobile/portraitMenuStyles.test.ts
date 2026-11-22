import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Menús de escribir texto en vertical en el teléfono (plan
 * portrait-text-modals, paso 4). jsdom no maqueta: se fijan las reglas que
 * evitan cortes y scroll lateral en vertical.
 */
const here = dirname(fileURLToPath(import.meta.url));
const chartCss = readFileSync(resolve(here, "../charts/LiveChartPanel.css"), "utf8");
const lyricsCss = readFileSync(resolve(here, "../../lyrics/lyrics.css"), "utf8");

const PORTRAIT = "@media (orientation: portrait) and (max-width: 500px) {";

/** El cuerpo del bloque `@media` vertical (llaves equilibradas). */
function portraitBlock(css: string): string {
  const start = css.indexOf(PORTRAIT);
  expect(start, "falta el bloque @media vertical").toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = start + PORTRAIT.length - 1; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    if (depth === 0) return css.slice(start + PORTRAIT.length, index);
  }
  throw new Error("bloque @media sin cerrar");
}

function rule(block: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n|,)\\s*${escaped}\\s*(?:,[^{]*)?\\{([^}]+)\\}`).exec(block);
  expect(match, `falta la regla ${selector}`).toBeTruthy();
  return match?.[1] ?? "";
}

describe("Editor de letra y acordes en vertical", () => {
  const block = portraitBlock(chartCss);

  it("una sola columna: texto arriba, enlaces de marcas debajo", () => {
    expect(rule(block, ".lt-chart-editor-body")).toContain("grid-template-columns: minmax(0, 1fr)");
  });

  it("el cuadro de texto a todo el ancho y sin scroll lateral", () => {
    const textarea = rule(block, ".lt-chart-editor-text textarea");
    expect(textarea).toContain("width: 100%");
    expect(textarea).toContain("white-space: pre-wrap");
  });

  it("la marca en su línea y desplegable debajo, sin la columna fija de escritorio", () => {
    expect(rule(block, ".lt-chart-editor-links li")).toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(rule(block, ".lt-chart-editor-links li .lt-chart-editor-marker")).toContain("grid-column: 1 / -1");
  });

  it("los botones se parten en líneas si no caben", () => {
    expect(rule(block, ".lt-chart-editor-actions")).toContain("flex-wrap: wrap");
  });

  it("cabe en el alto que dejan las zonas seguras", () => {
    const frame = rule(block, ".lt-settings-modal.lt-chart-editor");
    expect(frame).toContain("width: 100%");
    expect(frame).toContain("var(--lt-safe-area-top)");
    expect(frame).toContain("var(--lt-safe-area-bottom)");
  });
});

describe("Letra en proyección, diapositivas y Vincular canciones en vertical", () => {
  const block = portraitBlock(lyricsCss);

  it("el panel a pantalla completa apartado del notch y de la barra de inicio", () => {
    const frame = rule(block, ".lt-settings-modal.lt-lyrics-modal");
    expect(frame).toContain("width: 100%");
    expect(frame).toContain("height: 100%");
    for (const side of ["top", "right", "bottom", "left"]) {
      expect(frame).toContain(`var(--lt-safe-area-${side})`);
    }
    expect(rule(block, ".lt-modal-backdrop.lt-lyrics-backdrop")).toContain("padding: 0");
  });

  it("la tabla de marcas pasa a filas apiladas sin scroll lateral", () => {
    expect(rule(block, ".lt-lyrics-table thead")).toContain("display: none");
    const row = rule(block, ".lt-lyrics-table tr");
    expect(row).toContain("display: flex");
    expect(row).toContain("flex-wrap: wrap");
    expect(rule(block, ".lt-lyrics-table td:nth-child(-n + 2)")).toContain("flex: 1 1 100%");
    // El desplegable de grupo tenía un mínimo de 12rem: se lo quita.
    const select = rule(block, ".lt-lyrics-table select.lt-lyrics-select");
    expect(select).toContain("width: 100%");
    expect(select).toContain("min-width: 0");
  });

  // Vistos en el emulador con tamaño de iPhone 13: Cerrar a media cabecera
  // cortando el título, el pie a media pantalla y cada casilla en su fila.
  it("cabecera, pie y casillas aprovechan el ancho y el alto", () => {
    const close = rule(block, ".lt-lyrics-modal .lt-settings-modal-close");
    expect(close).toContain("width: auto");
    expect(close).toContain("flex: 0 0 auto");
    expect(rule(block, ".lt-lyrics-modal .lt-lyrics-modal-body")).toContain("flex: 1 1 auto");
    expect(rule(block, ".lt-lyrics-modal .lt-lyrics-modal-footer")).toContain("margin-top: auto");
    expect(rule(block, ".lt-lyrics-modal .lt-settings-toggle")).toContain("grid-template-columns: auto minmax(0, 1fr)");
  });

  it("presentación y «Cambiar…» bajan de línea si no caben", () => {
    expect(rule(block, ".lt-lyrics-modal-body > .lt-lyrics-row")).toContain("flex-wrap: wrap");
  });

  it("el editor de diapositivas va en una columna", () => {
    expect(rule(block, ".lt-lyrics-fields")).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(rule(block, ".lt-lyrics-section-header")).toContain("flex-wrap: wrap");
  });
});
