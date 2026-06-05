#!/usr/bin/env node
// Cross-platform orchestrator for the full LibreTracks test suite.
//
// Runs each suite sequentially, prints a clear per-suite banner, and exits
// non-zero if any suite fails (after running them all, so you see every
// failure in one pass instead of stopping at the first).
//
// The native audio engine (src-tauri + lt-audio-engine-v2 FFI) is NOT run
// here: its tests require the compiled C/C++ engine and the full native
// toolchain. Run those with `npm run test:native`.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const isWindows = process.platform === "win32";
const npmCmd = isWindows ? "npm.cmd" : "npm";

/**
 * @typedef {{ name: string, cmd: string, args: string[] }} Suite
 */

/** @type {Suite[]} */
const suites = [
  {
    name: "shared (vitest)",
    cmd: npmCmd,
    args: ["--prefix", "packages/shared", "run", "test"],
  },
  {
    name: "desktop frontend (vitest)",
    cmd: npmCmd,
    args: ["--prefix", "apps/desktop", "run", "test"],
  },
  {
    name: "remote frontend (vitest)",
    cmd: npmCmd,
    args: ["--prefix", "apps/remote", "run", "test"],
  },
  {
    name: "rust crates (cargo)",
    cmd: "cargo",
    args: [
      "test",
      "-p",
      "libretracks-core",
      "-p",
      "libretracks-project",
      "-p",
      "libretracks-audio",
      "-p",
      "libretracks-remote",
    ],
  },
];

/**
 * @param {Suite} suite
 * @returns {Promise<number>}
 */
function runSuite(suite) {
  return new Promise((resolvePromise) => {
    const banner = `\n${"=".repeat(60)}\n  ${suite.name}\n${"=".repeat(60)}`;
    console.log(banner);

    const child = spawn(suite.cmd, suite.args, {
      cwd: repoRoot,
      stdio: "inherit",
      shell: isWindows, // resolve npm.cmd / cargo on Windows PATH
    });

    child.on("close", (code) => resolvePromise(code ?? 1));
    child.on("error", (err) => {
      console.error(`Failed to start "${suite.name}": ${err.message}`);
      resolvePromise(1);
    });
  });
}

const results = [];
for (const suite of suites) {
  const code = await runSuite(suite);
  results.push({ name: suite.name, code });
}

console.log(`\n${"=".repeat(60)}\n  SUMMARY\n${"=".repeat(60)}`);
let failed = false;
for (const { name, code } of results) {
  const status = code === 0 ? "PASS" : `FAIL (exit ${code})`;
  console.log(`  ${code === 0 ? "✓" : "✗"} ${name.padEnd(32)} ${status}`);
  if (code !== 0) failed = true;
}
console.log("");

process.exit(failed ? 1 : 0);
