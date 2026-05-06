import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const allowedModes = new Set(["dev", "check", "build"]);
const mode = process.argv[2] ?? "dev";

if (!allowedModes.has(mode)) {
  console.error(`Unsupported mode "${mode}". Use: dev | check | build.`);
  process.exit(1);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: repoRoot,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status);
  }
};

const ensureRemoteDist = () => {
  const remoteDist = path.join(repoRoot, "apps", "remote", "dist");
  if (!existsSync(remoteDist)) {
    run("npm", ["--prefix", "apps/remote", "run", "build"]);
  }
};

if (process.platform === "win32") {
  run("powershell", [
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    ".\\scripts\\desktop-native.ps1",
    mode,
  ]);
  process.exit(0);
}

const env = {
  ...process.env,
  CARGO_TARGET_DIR: path.join(repoRoot, "target-desktop-native"),
};

ensureRemoteDist();

switch (mode) {
  case "dev":
    run("npm", ["--prefix", "apps/desktop", "run", "tauri:dev"], { env });
    break;
  case "check":
    run("cargo", ["check", "-p", "libretracks-desktop"], { env });
    break;
  case "build":
    run("npm", ["--prefix", "apps/desktop", "run", "tauri:build"], { env });
    break;
}
