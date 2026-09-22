import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../..");
const read = (relative: string) => readFileSync(resolve(repo, relative), "utf8");

// Bungee is not vendored: a fresh clone downloads the SDK on its first native
// build. Three files have to agree on what "the SDK" is — the fetch script
// picks a slice out of the archive, CMake links a binary out of that slice, and
// CI pins a version. When they drift the build does not fail loudly: it
// configures with USE_BUNGEE=OFF and ships warp and pitch as silence.
const fetchScript = read("scripts/fetch-bungee.mjs");
const engineCmake = read("native/audio-engine-v2/CMakeLists.txt");
const nodeLauncher = read("scripts/desktop-native.mjs");
const psLauncher = read("scripts/desktop-native.ps1");
const releaseWorkflow = read(".github/workflows/release.yml");

const pinnedVersion = /BUNGEE_VERSION = "([^"]+)"/.exec(fetchScript)?.[1];

describe("Bungee SDK fetch contract", () => {
  it("pins the same release CI builds against", () => {
    expect(pinnedVersion).toBeTruthy();
    expect(releaseWorkflow).toContain(`BUNGEE_VERSION: ${pinnedVersion}`);
    expect(releaseWorkflow).toContain(`bungee-${pinnedVersion}.tgz`);
  });

  // Extracting the wrong folder name is silent: tar succeeds with the headers
  // alone, and the failure surfaces much later as USE_BUNGEE=OFF.
  it.each([
    ["win32", "windows-x86_64", "bungee.lib"],
    ["darwin", "apple-mac", "bungee.framework"],
    ["linux x64", "linux-x86_64", "libbungee.so"],
    ["linux arm64", "linux-aarch64", "libbungee.so"],
  ])("extracts the slice CMake links on %s", (_platform, slice, library) => {
    expect(fetchScript).toContain(`dir: "${slice}", lib: "${library}"`);
    expect(engineCmake).toContain(`"\${LT_BUNGEE_DIR}/${slice}"`);
    expect(engineCmake).toContain(`_lt_bungee_libdir}/${library}`);
  });

  it("wires the fetch into both launchers", () => {
    // macOS and Linux go through the Node launcher, Windows through the
    // PowerShell one. A fresh clone must work on all three.
    expect(nodeLauncher).toContain("./fetch-bungee.mjs");
    expect(nodeLauncher).toContain("ensureBungee");
    expect(psLauncher).toContain("fetch-bungee.mjs");
  });

  it("stops the build instead of silently dropping the backend", () => {
    expect(nodeLauncher).toContain("process.exit(1)");
    expect(psLauncher).toContain(
      "Could not obtain the Bungee SDK - warp and pitch would compile to silent stubs.",
    );
  });
});
