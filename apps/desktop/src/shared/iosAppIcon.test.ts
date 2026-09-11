import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

// El script es JS sin tipos a proposito: la CI lo ejecuta con el Node pelado,
// sin pasar por el build.
// @ts-expect-error -- sin declaraciones
import { syncXcodeAppIcon } from "../../../../scripts/ios-app-icon.mjs";

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

/**
 * El catalogo del proyecto de Xcode, que la CI genera en cada build. Se imita
 * con un directorio temporal porque `gen/apple` no existe fuera del Mac.
 */
function fakeAppIconSet(images: Array<Record<string, string>>) {
  const dir = mkdtempSync(join(tmpdir(), "lt-appicon-"));
  writeFileSync(
    join(dir, "Contents.json"),
    JSON.stringify({ images, info: { version: 1, author: "xcode" } }, null, 2),
  );
  return dir;
}

describe("meter el icono en el proyecto de Xcode", () => {
  // `tauri ios init` no lee icons/ios: el proyecto nace con los iconos de
  // relleno de la plantilla, y en la CI —que lo genera en cada build— el IPA
  // salia siempre con ellos.
  it("copia por TAMANO, no por nombre: la plantilla los llama como quiere", async () => {
    const dir = fakeAppIconSet([
      { idiom: "iphone", size: "60x60", scale: "3x", filename: "loquesea.png" },
      { idiom: "ios-marketing", size: "1024x1024", scale: "1x", filename: "big.png" },
    ]);

    expect(await syncXcodeAppIcon(iconsDir, dir)).toBe(2);
    expect(readFileSync(join(dir, "loquesea.png")).readUInt32BE(16)).toBe(180);
    expect(readFileSync(join(dir, "big.png")).readUInt32BE(16)).toBe(1024);
  });

  it("da nombre a las casillas vacias, o el icono no llegaria al .app", async () => {
    const dir = fakeAppIconSet([{ idiom: "ipad", size: "83.5x83.5", scale: "2x" }]);

    expect(await syncXcodeAppIcon(iconsDir, dir)).toBe(1);
    const contents = JSON.parse(
      readFileSync(join(dir, "Contents.json"), "utf8"),
    ) as { images: Array<{ filename: string }> };
    expect(contents.images[0].filename).toBe("AppIcon-ipad-83.5x83.5@2x.png");
    expect(
      readFileSync(join(dir, contents.images[0].filename)).readUInt32BE(16),
    ).toBe(167);
  });

  // Un catalogo que no recibe nada es el fallo SILENCIOSO que esto viene a
  // evitar: la CI seguiria y el IPA saldria con el icono de la plantilla.
  it("falla si el catalogo se queda sin icono", async () => {
    await expect(syncXcodeAppIcon(iconsDir, fakeAppIconSet([]))).rejects.toThrow(
      /no declara ningun icono/,
    );
    await expect(
      syncXcodeAppIcon(iconsDir, fakeAppIconSet([
        { idiom: "iphone", size: "13x13", scale: "1x", filename: "raro.png" },
      ])),
    ).rejects.toThrow(/Faltan iconos/);
  });
});
