import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const iconsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../src-tauri/icons/ios",
);

/** Cabecera PNG: lado y tipo de color (2 = RGB, 6 = RGBA). */
function pngHeader(file: string) {
  const data = readFileSync(join(iconsDir, file));
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
    colorType: data.readUInt8(25),
  };
}

const EXPECTED_SIDES: Record<string, number> = {
  "AppIcon-20x20@1x.png": 20,
  "AppIcon-20x20@2x.png": 40,
  "AppIcon-20x20@2x-1.png": 40,
  "AppIcon-20x20@3x.png": 60,
  "AppIcon-29x29@1x.png": 29,
  "AppIcon-29x29@2x.png": 58,
  "AppIcon-29x29@2x-1.png": 58,
  "AppIcon-29x29@3x.png": 87,
  "AppIcon-40x40@1x.png": 40,
  "AppIcon-40x40@2x.png": 80,
  "AppIcon-40x40@2x-1.png": 80,
  "AppIcon-40x40@3x.png": 120,
  "AppIcon-60x60@2x.png": 120,
  "AppIcon-60x60@3x.png": 180,
  "AppIcon-76x76@1x.png": 76,
  "AppIcon-76x76@2x.png": 152,
  "AppIcon-83.5x83.5@2x.png": 167,
  "AppIcon-512@2x.png": 1024,
};

describe("icono de la app en iOS", () => {
  it("estan los tamanos que pide el catalogo", () => {
    expect(readdirSync(iconsDir).filter((name) => name.endsWith(".png")).sort())
      .toEqual(Object.keys(EXPECTED_SIDES).sort());

    for (const [file, side] of Object.entries(EXPECTED_SIDES)) {
      const header = pngHeader(file);
      expect({ file, ...header }).toMatchObject({
        file,
        width: side,
        height: side,
      });
    }
  });

  // Apple rechaza la subida si el icono trae canal alfa ("can't be transparent
  // nor contain an alpha channel"), y `tauri icon` lo genera CON alfa desde el
  // icono de escritorio, que ademas lleva marco y esquina redondeada: en la
  // pantalla de inicio salia una baldosa blanca con el logo pequeno en medio,
  // porque la mascara de iOS recortaba sobre el margen. Se generan aparte con
  // scripts/make-ios-icons.mjs; esto es el guardarrail de volver a pasar
  // `tauri icon` por encima.
  it("van a sangre y sin canal alfa", () => {
    const withAlpha = Object.keys(EXPECTED_SIDES).filter(
      (file) => pngHeader(file).colorType !== 2,
    );
    expect(withAlpha).toEqual([]);
  });
});
