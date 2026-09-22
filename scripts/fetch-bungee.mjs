// Downloads the prebuilt Bungee SDK into vendor/bungee/ when it is not already
// on the machine.
//
// Bungee (MPL-2.0) is the pitch/warp backend. It is NOT vendored in the repo:
// the full release is ~54 MB of platform binaries, so a fresh clone fetches it
// once from the upstream GitHub release instead. This mirrors exactly what the
// CI workflows do (see BUNGEE_VERSION in .github/workflows/release.yml) so the
// version a contributor builds against is the version we ship.
//
// Without it the engine configures with USE_BUNGEE=OFF and warp/pitch go
// silently mute, which is why the launchers treat a failed fetch as fatal
// instead of falling back.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUNGEE_VERSION = "v2.4.24";
// Overridable for mirrors / offline caches on networks that cannot reach
// GitHub releases directly.
export const BUNGEE_ARCHIVE =
  process.env.LT_BUNGEE_ARCHIVE ||
  `https://github.com/bungee-audio-stretch/bungee/releases/download/${BUNGEE_VERSION}/bungee-${BUNGEE_VERSION}.tgz`;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

export const vendorBungeeDir = path.join(repoRoot, "vendor", "bungee");

// The archive is flat (no top-level folder): include/, windows-x86_64/,
// apple-mac/, linux-x86_64/, ... We extract only the slice this machine needs.
// On Windows that also avoids bsdtar choking on the apple-mac/ symlinks.
// Slice name and the binary CMakeLists.txt links against, per platform. Keep
// these in sync with the LT_ENGINE_USE_BUNGEE block in
// native/audio-engine-v2/CMakeLists.txt.
const platformSlice = () => {
  if (process.platform === "win32") return { dir: "windows-x86_64", lib: "bungee.lib" };
  if (process.platform === "darwin") return { dir: "apple-mac", lib: "bungee.framework" };
  if (process.platform === "linux") {
    return os.arch() === "arm64"
      ? { dir: "linux-aarch64", lib: "libbungee.so" }
      : { dir: "linux-x86_64", lib: "libbungee.so" };
  }
  return null;
};

const platformMembers = () => {
  const slice = platformSlice();
  return slice ? ["include", slice.dir] : ["include"];
};

const hasSdk = (dir) =>
  Boolean(dir) && existsSync(path.join(dir, "include", "bungee", "Bungee.h"));

// A directory with the headers but no platform binary configures fine and then
// fails at link time, so check both.
const hasPlatformBinary = (dir) => {
  const slice = platformSlice();
  if (!slice) return true;
  return existsSync(path.join(dir, slice.dir, slice.lib));
};

/**
 * Candidate SDK locations, most explicit first. A copy already unpacked
 * anywhere here means no download happens.
 */
export const bungeeCandidates = (env = process.env) => {
  const home = env.USERPROFILE || env.HOME || "";
  return [
    env.LT_BUNGEE_DIR,
    vendorBungeeDir,
    // Legacy hand-unpacked location documented in the README.
    home ? path.join(home, "Downloads", `bungee-${BUNGEE_VERSION}`) : "",
  ].filter(Boolean);
};

export const findBungeeDir = (env = process.env) =>
  bungeeCandidates(env).find(hasSdk) ?? "";

export const fetchBungee = async () => {
  // The archive is downloaded *into* the destination and extracted with a
  // relative name from there: an absolute Windows path like C:\... makes GNU
  // tar (the one Git for Windows ships) read the drive letter as a remote
  // host. A relative name works with both GNU tar and macOS/Windows bsdtar.
  const archiveName = `.bungee-${BUNGEE_VERSION}.tgz`;
  const tmpFile = path.join(vendorBungeeDir, archiveName);

  console.log(`Bungee SDK not found — downloading ${BUNGEE_VERSION} from upstream...`);
  console.log(`  ${BUNGEE_ARCHIVE}`);

  const response = await fetch(BUNGEE_ARCHIVE, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  }
  mkdirSync(vendorBungeeDir, { recursive: true });
  writeFileSync(tmpFile, Buffer.from(await response.arrayBuffer()));

  try {
    const result = spawnSync(
      "tar",
      ["-xzf", archiveName, ...platformMembers()],
      { stdio: "inherit", cwd: vendorBungeeDir },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`tar exited with status ${result.status}`);
    }
  } finally {
    rmSync(tmpFile, { force: true });
  }

  if (!hasSdk(vendorBungeeDir)) {
    throw new Error(
      `Extraction did not produce ${path.join(vendorBungeeDir, "include", "bungee", "Bungee.h")}`,
    );
  }
  if (!hasPlatformBinary(vendorBungeeDir)) {
    const slice = platformSlice();
    throw new Error(
      `Extraction did not produce ${path.join(vendorBungeeDir, slice.dir, slice.lib)} ` +
        `(this platform is ${process.platform}/${os.arch()})`,
    );
  }

  console.log(`Bungee SDK ready at ${vendorBungeeDir}`);
  return vendorBungeeDir;
};

/** Returns the SDK path, downloading it if needed. Throws if it cannot. */
export const ensureBungee = async (env = process.env) => {
  const existing = findBungeeDir(env);
  if (existing) return existing;
  return fetchBungee();
};

// CLI: prints the resolved directory on stdout (last line) so the PowerShell
// launcher can consume it. Diagnostics go to stderr to keep stdout clean.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const log = console.log;
  console.log = (...args) => console.error(...args);
  try {
    const dir = await ensureBungee();
    console.log = log;
    console.log(dir);
  } catch (error) {
    console.error(
      [
        "",
        `Could not obtain the Bungee SDK (${BUNGEE_VERSION}).`,
        `  ${error.message}`,
        "",
        "Without it warp and pitch shifting compile to silent no-op stubs.",
        "Fix it by either:",
        `  - unpacking ${BUNGEE_ARCHIVE} into vendor/bungee/`,
        "  - pointing LT_BUNGEE_DIR at an SDK unpacked elsewhere",
        "  - building without it: LIBRETRACKS_ENGINE_V2_BUNGEE=0",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }
}
