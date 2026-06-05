#!/usr/bin/env node
// Full verification: runs every test tier and prints one aggregated summary.
//
//   1. Fast suites      — shared, desktop frontend, remote, pure Rust crates
//                         (no native toolchain needed).
//   2. Native engine    — builds the real C++ engine, runs the DSP doctest
//                         suite (authoritative) plus the engine-linked Rust
//                         tests (informational; audio-device dependent).
//
// Use this before a release or any change that touches the audio engine.
// For the everyday loop, `npm test` (the fast tier) is usually enough.
//
// Exit code is non-zero if any tier fails. Both tiers always run so you see
// the whole picture in one pass.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const isWindows = process.platform === "win32";

/**
 * @typedef {{ name: string, cmd: string, args: string[] }} Tier
 */

/** @type {Tier[]} */
const tiers = [
  {
    name: "fast suites (npm test)",
    // Use the bare "node" so it resolves on PATH; process.execPath can contain
    // spaces (e.g. "C:\Program Files\nodejs\node.exe") which break under the
    // Windows shell.
    cmd: "node",
    args: ["./scripts/test-all.mjs"],
  },
  {
    name: "native engine (npm run test:native)",
    cmd: "node",
    args: ["./scripts/desktop-native.mjs", "test"],
  },
];

/**
 * @param {Tier} tier
 * @returns {Promise<number>}
 */
function runTier(tier) {
  return new Promise((resolvePromise) => {
    console.log(`\n${"#".repeat(64)}\n#  ${tier.name}\n${"#".repeat(64)}`);
    const child = spawn(tier.cmd, tier.args, {
      cwd: repoRoot,
      stdio: "inherit",
      shell: isWindows,
    });
    child.on("close", (code) => resolvePromise(code ?? 1));
    child.on("error", (err) => {
      console.error(`Failed to start "${tier.name}": ${err.message}`);
      resolvePromise(1);
    });
  });
}

const results = [];
for (const tier of tiers) {
  const code = await runTier(tier);
  results.push({ name: tier.name, code });
}

console.log(`\n${"#".repeat(64)}\n#  FULL VERIFICATION SUMMARY\n${"#".repeat(64)}`);
let failed = false;
for (const { name, code } of results) {
  const status = code === 0 ? "PASS" : `FAIL (exit ${code})`;
  console.log(`  ${code === 0 ? "✓" : "✗"} ${name.padEnd(40)} ${status}`);
  if (code !== 0) failed = true;
}
console.log("");

process.exit(failed ? 1 : 0);
