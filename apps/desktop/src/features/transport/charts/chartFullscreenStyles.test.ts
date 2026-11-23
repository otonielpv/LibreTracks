import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Letra y acordes a pantalla completa, igual en Live y en Setlist.
 *
 * En Live la letra «expandida» solo cambiaba la rejilla de la vista y dejaba
 * la barra de transporte y la cabecera; en Setlist el contenedor ponía las
 * zonas seguras como relleno y en un iPhone 13 la letra quedaba en un recuadro
 * con franjas negras a los lados y abajo. jsdom no maqueta: se fija la regla.
 */
const here = dirname(fileURLToPath(import.meta.url));
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const chartCss = strip(readFileSync(resolve(here, "LiveChartPanel.css"), "utf8"));
const setlistCss = strip(readFileSync(resolve(here, "../setlist/setlist.css"), "utf8"));

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n|,)\\s*${escaped}\\s*\\{([^}]+)\\}`).exec(css);
  expect(match, `falta la regla ${selector}`).toBeTruthy();
  return match?.[1] ?? "";
}

describe("letra y acordes a pantalla completa", () => {
  it("el panel expandido cubre toda la ventana en las dos vistas", () => {
    const panel = rule(chartCss, ".lt-live-chart.is-expanded");
    expect(panel).toContain("position: fixed");
    expect(panel).toContain("inset: 0");
    expect(panel).toContain("border-radius: 0");
    // Por encima de la barra de transporte y la cabecera de Live.
    expect(panel).toMatch(/z-index:\s*\d+/);
  });

  it("las zonas seguras se apartan por dentro del panel, no encogiéndolo", () => {
    const toolbar = rule(chartCss, ".lt-live-chart.is-expanded > .lt-live-chart-toolbar");
    for (const side of ["top", "right", "left"]) expect(toolbar).toContain(`--lt-safe-area-${side}`);
    const scroller = rule(chartCss, ".lt-live-chart.is-expanded > .lt-live-chart-scroller");
    for (const side of ["right", "bottom", "left"]) expect(scroller).toContain(`--lt-safe-area-${side}`);
    expect(rule(setlistCss, ".lt-setlist-lyrics.is-expanded")).not.toContain("safe-area");
  });
});

describe("barra de reproducción de la letra a pantalla completa", () => {
  it("se ve en vertical y en horizontal: la regla base no está dentro de un @media", () => {
    // Al principio de línea = nivel superior; dentro de un @media va sangrada.
    const match = /\n\.lt-live-chart\.is-expanded > \.lt-chart-dock \{([^}]+)\}/.exec(chartCss);
    expect(match, "falta la regla de nivel superior de la barra").toBeTruthy();
    expect(match?.[1]).toContain("display: flex");
    expect(chartCss).not.toMatch(/\.lt-chart-dock \{\s*display: none/);
  });
});
