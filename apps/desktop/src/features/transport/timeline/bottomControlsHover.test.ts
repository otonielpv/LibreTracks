import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * En la barra inferior el hover luce igual que «encendido». En táctil el
 * :hover se queda pegado al último botón tocado, así que al apagar el
 * seguimiento del playhead en el móvil el botón seguía pareciendo encendido
 * hasta tocar fuera. jsdom no simula :hover: se fija la regla en el CSS.
 */
const css = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../shared/styles.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

describe("hover de la barra inferior en táctil", () => {
  it("el hover de los botones solo existe dentro de @media (hover: hover)", () => {
    const hoverRules = [...css.matchAll(/\.lt-bottom-controls [^{}]*:hover[^{}]*\{/g)];
    expect(hoverRules.length).toBeGreaterThan(0);
    for (const match of hoverRules) {
      const before = css.slice(0, match.index);
      const lastMedia = before.lastIndexOf("@media (hover: hover)");
      // Dentro del bloque @media: no se ha cerrado desde que se abrió.
      const between = before.slice(lastMedia);
      const opens = (between.match(/\{/g) ?? []).length;
      const closes = (between.match(/\}/g) ?? []).length;
      expect(lastMedia, match[0]).toBeGreaterThan(-1);
      expect(opens - closes, match[0]).toBeGreaterThan(0);
    }
  });

  it("el estado encendido no comparte regla con el hover", () => {
    expect(css).toMatch(/\n\.lt-bottom-controls button\.is-active \{/);
  });
});
