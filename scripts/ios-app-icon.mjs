/**
 * Mete el icono de la app en el proyecto de Xcode generado.
 *
 * `tauri ios init` NO lee `src-tauri/icons/ios`: genera el proyecto desde la
 * plantilla de cargo-mobile2, iconos de relleno incluidos, y quien escribe en
 * ese catalogo es `tauri icon` —que nadie vuelve a ejecutar despues—. Como la
 * CI genera el proyecto en cada build, el IPA salia SIEMPRE con el icono de la
 * plantilla: es el "otro icono totalmente distinto" que aparecia en el iPhone.
 *
 * Trabaja contra el `Contents.json` que acaba de generarse, no contra una lista
 * de nombres nuestra: la plantilla es libre de llamarlos como quiera. Para cada
 * entrada calcula el lado en pixeles (medida x escala) y copia el PNG de ese
 * lado que hay en `icons/ios`.
 *
 * Solo usa el nucleo de Node: la CI lo ejecuta sin depender de nada instalado.
 *
 *   node scripts/ios-app-icon.mjs
 */
import { existsSync } from "node:fs";
import { copyFile, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const IOS_ICONS_DIR = resolve(
  here,
  "../apps/desktop/src-tauri/icons/ios",
);
export const APP_ICON_SET = resolve(
  here,
  "../apps/desktop/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset",
);

/** Lado en pixeles de un PNG, leido de su cabecera IHDR. */
async function pngSide(path) {
  return (await readFile(path)).readUInt32BE(16);
}

/**
 * Copia los iconos de `iconsDir` sobre el catalogo `appIconSet`, siguiendo su
 * `Contents.json`. Devuelve cuantos ficheros ha escrito.
 */
export async function syncXcodeAppIcon(
  iconsDir = IOS_ICONS_DIR,
  appIconSet = APP_ICON_SET,
) {
  const contentsPath = join(appIconSet, "Contents.json");
  if (!existsSync(contentsPath)) {
    return 0;
  }

  const bySide = new Map();
  for (const name of await readdir(iconsDir)) {
    if (!name.endsWith(".png")) continue;
    const path = join(iconsDir, name);
    bySide.set(await pngSide(path), path);
  }

  const contents = JSON.parse(await readFile(contentsPath, "utf8"));
  const missing = [];
  let written = 0;
  let renamed = false;
  for (const image of contents.images ?? []) {
    // "83.5x83.5" y "2x" -> 167.
    const side = Math.round(
      Number.parseFloat(image.size) * Number.parseFloat(image.scale),
    );
    const source = bySide.get(side);
    if (!Number.isFinite(side) || !source) {
      missing.push(`${image.idiom} ${image.size}@${image.scale} (${side}px)`);
      continue;
    }
    if (!image.filename) {
      // Una entrada sin fichero es una casilla vacia del catalogo: se le pone
      // nombre, o el icono no llegaria al .app. El idioma entra en el nombre
      // porque iPhone y iPad repiten medidas.
      image.filename = `AppIcon-${image.idiom}-${image.size}@${image.scale}.png`;
      renamed = true;
    }
    await copyFile(source, join(appIconSet, image.filename));
    written += 1;
  }

  if (missing.length) {
    throw new Error(
      `Faltan iconos de iOS para: ${missing.join(", ")}. ` +
        "Regeneralos con scripts/make-ios-icons.mjs.",
    );
  }
  // Un catalogo que no recibe nada es el fallo silencioso que esto viene a
  // evitar: el IPA saldria con el icono de la plantilla.
  if (written === 0) {
    throw new Error(
      `El catalogo ${appIconSet} no declara ningun icono; el IPA saldria con el de la plantilla.`,
    );
  }
  if (renamed) {
    await writeFile(contentsPath, `${JSON.stringify(contents, null, 2)}\n`);
  }
  return written;
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  if (!existsSync(APP_ICON_SET)) {
    console.log(`Sin proyecto de Xcode (${APP_ICON_SET}); nada que sincronizar.`);
  } else {
    console.log(`${await syncXcodeAppIcon()} iconos copiados a ${APP_ICON_SET}`);
  }
}
