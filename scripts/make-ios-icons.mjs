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
 * Si el proyecto de Xcode ya esta generado (`gen/apple`, solo en el Mac), los
 * copia tambien a su catalogo: es de donde salen los iconos del .app, y
 * refrescar `icons/ios` a secas no lo toca.
 *
 *   node scripts/make-ios-icons.mjs
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = resolve(here, "../apps/desktop/src-tauri/icons");
const source = join(iconsDir, "icon-ios.svg");
const outDir = join(iconsDir, "ios");
const appIconSet = resolve(
  here,
  "../apps/desktop/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset",
);

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

if (existsSync(appIconSet)) {
  const present = new Set(await readdir(appIconSet));
  for (const [name] of TARGETS) {
    if (present.has(name)) {
      await copyFile(join(outDir, name), join(appIconSet, name));
    }
  }
  console.log(`Copiados al catalogo de Xcode: ${appIconSet}`);
} else {
  console.log(
    "Sin proyecto de Xcode aqui: al generarlo (`tauri ios init`) tomara estos.",
  );
}

console.log(`${TARGETS.length} iconos escritos en ${outDir}`);
