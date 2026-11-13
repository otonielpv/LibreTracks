#!/usr/bin/env node
// Descarga la libmpv que se empaqueta con LibreTracks (plan de vídeo, paso 02).
//
//   node scripts/libmpv-fetch.mjs [--into <carpeta>]
//
// Deja la librería en vendor/bin/libmpv/<plataforma>/ y, con --into, además la
// copia a esa carpeta (la CI usa --into vendor/bin/native para que el glob de
// recursos de tauri.conf.json la ponga junto al exe).
//
// Por plataforma:
//   Windows x64  build fijada de mpv-winbuild-cmake (shinchiro), verificada por
//                SHA-256. libmpv-2.dll trae su FFmpeg ESTÁTICO y solo exporta
//                mpv_*: no choca con los avcodec-*.dll del motor.
//   Linux        no se empaqueta: se usa la libmpv del sistema (libmpv.so.2 o
//                .so.1), declarada como "recommends" en el .deb/.rpm.
//   macOS        build PROPIA universal (x86_64 + arm64), LGPL, macOS 12.0,
//                dependencias estáticas y solo mpv_* exportados:
//                scripts/libmpv-macos.sh (paso 15a). Se construye una vez (la
//                caché de la CI guarda el resultado) y se verifica siempre con
//                scripts/verify-libmpv-macos.sh. LT_LIBMPV_ARCH=x86_64|arm64
//                construye solo una arquitectura (pruebas locales).
// En Linux el script termina con éxito sin hacer nada: sin libmpv la app
// arranca igual y el vídeo aparece desactivado con el motivo.
//
// El nombre no empieza por "build": el `build*` del .gitignore raíz se lo
// tragaría (ver docs/plans/completed/video-output/00-DISENO.md, sección 7).

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Subir de versión: cambiar las tres constantes, ejecutar el script en
// Windows, y actualizar la entrada de mpv en THIRD-PARTY-NOTICES.md con el
// commit de mpv y la versión de FFmpeg que imprime. Ver docs/RELEASE_PROCESS.md.
export const LIBMPV_WINDOWS = {
  tag: "20261110",
  asset: "mpv-dev-x86_64-20261110-git-a61f6c3abd.7z",
  sha256: "f07b97a72f2394a7798d6e1d36d952bbfd63577e25cef051f716751ea5dc9688",
  mpvCommit: "a61f6c3abd",
};

// Upstream solo conserva sus builds recientes (la 20260926 desapareció y rompió
// la release de 1.17.0), así que el .7z fijado se sirve desde un release propio
// `libmpv-<tag>` (prerelease, nunca «latest»). Al subir de versión: crear ese
// release con el .7z nuevo. El SHA-256 sigue mandando; LT_LIBMPV_ARCHIVE
// fuerza otra URL.
const archiveUrl =
  process.env.LT_LIBMPV_ARCHIVE ||
  `https://github.com/otonielpv/LibreTracks/releases/download/libmpv-${LIBMPV_WINDOWS.tag}/${LIBMPV_WINDOWS.asset}`;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const intoIndex = args.indexOf("--into");
const intoDir = intoIndex >= 0 ? path.resolve(args[intoIndex + 1]) : null;

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const run = (command, commandArgs, options = {}) => {
  const result = spawnSync(command, commandArgs, { stdio: "inherit", ...options });
  return result.status === 0;
};

function fetchWindows() {
  const outDir = path.join(repoRoot, "vendor", "bin", "libmpv", "windows");
  const dll = path.join(outDir, "libmpv-2.dll");
  const stamp = path.join(outDir, "VERSION");
  const wanted = `${LIBMPV_WINDOWS.asset} ${LIBMPV_WINDOWS.sha256}`;

  if (existsSync(dll) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === wanted) {
    console.log(`libmpv ${LIBMPV_WINDOWS.tag} ya está en ${outDir}`);
  } else {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const archive = path.join(outDir, LIBMPV_WINDOWS.asset);
    console.log(`Descargando ${archiveUrl}`);
    if (!run("curl", ["-fL", "--retry", "3", "-o", archive, archiveUrl])) {
      throw new Error("no se pudo descargar libmpv");
    }
    const actual = sha256(archive);
    if (actual !== LIBMPV_WINDOWS.sha256) {
      throw new Error(`SHA-256 de libmpv no coincide: ${actual} (esperado ${LIBMPV_WINDOWS.sha256})`);
    }
    // bsdtar (el tar.exe de Windows) lee .7z. Por ruta absoluta: en Git Bash
    // `tar` es GNU tar, que toma "C:" por un host remoto. 7z como respaldo.
    const windowsTar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    const extracted =
      run(windowsTar, ["-xf", archive, "-C", outDir, "libmpv-2.dll"]) ||
      run("7z", ["e", "-y", `-o${outDir}`, archive, "libmpv-2.dll"]);
    rmSync(archive, { force: true });
    if (!extracted || !existsSync(dll)) {
      throw new Error("no se pudo extraer libmpv-2.dll del .7z");
    }
    writeFileSync(stamp, `${wanted}\n`);
    console.log(`libmpv-2.dll (${(readFileSync(dll).length / 1e6).toFixed(1)} MB) en ${outDir}`);
  }

  if (intoDir) {
    mkdirSync(intoDir, { recursive: true });
    copyFileSync(dll, path.join(intoDir, "libmpv-2.dll"));
    console.log(`Copiada a ${intoDir}`);
  }
}

function fetchMac() {
  const outDir = path.join(repoRoot, "vendor", "bin", "libmpv", "macos");
  const dylib = path.join(outDir, "libmpv.2.dylib");
  const arch = process.env.LT_LIBMPV_ARCH || "universal";
  if (existsSync(dylib)) {
    console.log(`libmpv ya está en ${outDir}`);
  } else if (!run("bash", [path.join(repoRoot, "scripts", "libmpv-macos.sh"), "--arch", arch, "--out", outDir])) {
    throw new Error("no se pudo construir libmpv (scripts/libmpv-macos.sh)");
  }
  const verifyArgs = [path.join(repoRoot, "scripts", "verify-libmpv-macos.sh"), dylib];
  if (arch !== "universal") verifyArgs.push("--single-arch");
  if (!run("bash", verifyArgs)) {
    throw new Error("la libmpv de macOS no pasa la verificación");
  }
  if (intoDir) {
    mkdirSync(intoDir, { recursive: true });
    copyFileSync(dylib, path.join(intoDir, "libmpv.2.dylib"));
    console.log(`Copiada a ${intoDir}`);
  }
}

try {
  if (process.platform === "win32") {
    fetchWindows();
  } else if (process.platform === "linux") {
    console.log("Linux: se usa la libmpv del sistema (libmpv.so.2 / libmpv.so.1); nada que descargar.");
  } else if (process.platform === "darwin") {
    fetchMac();
  } else {
    console.log(`${process.platform}: sin salida de vídeo.`);
  }
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
}
