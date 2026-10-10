import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * En iOS, un :hover que hace aparecer algo dentro del elemento se come el
 * primer toque: seleccionar una canción en la banda de la DAW pedía dos
 * toques desde que los tiradores de fade aparecían con hover (27ce3c7b).
 * Igual que la barra inferior (03bd45e7): el hover de la banda sólo vive
 * dentro de @media (hover: hover). jsdom no simula :hover: se fija la regla.
 */
const here = dirname(fileURLToPath(import.meta.url));
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const sheets = {
  "styles.css": stripComments(readFileSync(resolve(here, "../../../shared/styles.css"), "utf8")),
  "songFades.css": stripComments(readFileSync(resolve(here, "../songs/songFades.css"), "utf8")),
};

function insideHoverMedia(css: string, index: number): boolean {
  const before = css.slice(0, index);
  const lastMedia = before.lastIndexOf("@media (hover: hover)");
  if (lastMedia < 0) return false;
  const between = before.slice(lastMedia);
  return (between.match(/\{/g) ?? []).length - (between.match(/\}/g) ?? []).length > 0;
}

describe("hover de la banda de canción en táctil", () => {
  for (const [name, css] of Object.entries(sheets)) {
    it(`${name}: todo .lt-region-hotspot:hover está dentro de @media (hover: hover)`, () => {
      const rules = [...css.matchAll(/[^{}]*\.lt-region-hotspot:hover[^{}]*\{/g)];
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) {
        expect(insideHoverMedia(css, rule.index ?? 0), rule[0].trim()).toBe(true);
      }
    });
  }

  it("la canción seleccionada sigue mostrando sus tiradores sin hover", () => {
    expect(sheets["styles.css"]).toMatch(/\.lt-region-hotspot\.is-selected \.lt-region-resize-handle/);
    expect(sheets["songFades.css"]).toMatch(/\.lt-region-hotspot\.is-selected \.lt-song-fade-handle/);
  });
});
