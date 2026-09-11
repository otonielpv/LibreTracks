/**
 * Rasteriza el icono de iOS desde `icons/icon-ios.svg`.
 *
 * No lo hace `tauri icon`: ese parte de `icon.png`, que lleva el marco y la
 * esquina redondeada del icono de escritorio. Apple pide justo lo contrario
 * —arte a sangre, cuadrado y SIN canal alfa, porque la mascara la pone iOS— y
 * un PNG con alfa tumba la subida a App Store Connect ("can't be transparent
 * nor contain an alpha channel"). Con el marco dentro, ademas, la pantalla de
 * inicio mostraba una baldosa blanca con el logo pequeno en medio.
 *
 * Solo hay que ejecutarlo cuando cambia el ARTE. Meterlos en el proyecto de
 * Xcode es otra cosa y la hace scripts/ios-app-icon.mjs, que no necesita
 * rasterizar nada (la CI lo llama tras generar el proyecto).
 *
 *   node scripts/make-ios-icons.mjs
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import { APP_ICON_SET, syncXcodeAppIcon } from "./ios-app-icon.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = resolve(here, "../apps/desktop/src-tauri/icons");
const source = join(iconsDir, "icon-ios.svg");
const outDir = join(iconsDir, "ios");

/** Los nombres que espera el catalogo que genera Tauri, con su lado en px. */
const TARGETS = [
  ["AppIcon-20x20@1x.png", 20],
  ["AppIcon-20x20@2x.png", 40],
  ["AppIcon-20x20@2x-1.png", 40],
  ["AppIcon-20x20@3x.png", 60],
  ["AppIcon-29x29@1x.png", 29],
  ["AppIcon-29x29@2x.png", 58],
  ["AppIcon-29x29@2x-1.png", 58],
  ["AppIcon-29x29@3x.png", 87],
  ["AppIcon-40x40@1x.png", 40],
  ["AppIcon-40x40@2x.png", 80],
  ["AppIcon-40x40@2x-1.png", 80],
  ["AppIcon-40x40@3x.png", 120],
  ["AppIcon-60x60@2x.png", 120],
  ["AppIcon-60x60@3x.png", 180],
  ["AppIcon-76x76@1x.png", 76],
  ["AppIcon-76x76@2x.png", 152],
  ["AppIcon-83.5x83.5@2x.png", 167],
  ["AppIcon-512@2x.png", 1024],
];

await mkdir(outDir, { recursive: true });

for (const [name, size] of TARGETS) {
  const png = await sharp(source, { density: 512 })
    .resize(size, size, { fit: "fill" })
    // Sin alfa: `flatten` compone sobre un fondo opaco y el PNG sale RGB.
    .flatten({ background: "#0F172A" })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(join(outDir, name), png);
}

console.log(`${TARGETS.length} iconos escritos en ${outDir}`);

if (existsSync(APP_ICON_SET)) {
  console.log(`${await syncXcodeAppIcon()} copiados al catalogo de Xcode`);
} else {
  console.log(
    "Sin proyecto de Xcode aqui; la CI los mete con scripts/ios-app-icon.mjs.",
  );
}
