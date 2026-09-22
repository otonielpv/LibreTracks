import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { TIMELINE_COLOR_PRESETS } from "./timelineColors";

/**
 * El reparto de color automático para pistas nuevas (paso 02 del plan de
 * feedback de testers) vive en Rust, en `state/track_colors.rs`, porque es ahí
 * donde nacen las pistas. La paleta, en cambio, la enseña el frontend en el
 * selector de color.
 *
 * Están por fuerza duplicadas. Este test es lo único que impide que se
 * separen: si alguien añade un color al selector y no al repartidor, el color
 * automático deja de ser uno de los que el usuario reconoce.
 */
const RUST_PALETTE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../src-tauri/src/state/track_colors.rs",
);

function rustPaletteHexes(): string[] {
  const source = readFileSync(RUST_PALETTE_PATH, "utf8");
  const block = source.match(
    /AUTO_TRACK_COLORS:\s*\[&str;\s*\d+\]\s*=\s*\[([\s\S]*?)\];/,
  );
  if (!block) {
    throw new Error(
      `no encuentro AUTO_TRACK_COLORS en ${RUST_PALETTE_PATH}; ¿se ha renombrado?`,
    );
  }
  return [...block[1].matchAll(/"(#[0-9A-Fa-f]{6})"/g)].map(
    (match) => match[1],
  );
}

describe("paleta de color automático", () => {
  it("es la misma en Rust y en el selector del frontend, en el mismo orden", () => {
    expect(rustPaletteHexes()).toEqual(
      TIMELINE_COLOR_PRESETS.map((preset) => preset.value),
    );
  });

  it("no repite ningún color, o el reparto daría dos pistas iguales", () => {
    const hexes = rustPaletteHexes();
    expect(new Set(hexes).size).toBe(hexes.length);
  });
});
