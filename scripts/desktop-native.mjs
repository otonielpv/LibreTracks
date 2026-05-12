import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const allowedModes = new Set(["dev", "check", "build"]);
const mode = process.argv[2] ?? "dev";
const scriptName = process.env.npm_lifecycle_event ?? "";
if (scriptName === "dev:desktop:engine-v2" && !process.env.LIBRETRACKS_AUDIO_ENGINE) {
  process.env.LIBRETRACKS_AUDIO_ENGINE = "cpp-v2";
}

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

const engineV2Requested =
  process.env.LIBRETRACKS_AUDIO_ENGINE === "cpp-v2" ||
  process.env.LIBRETRACKS_AUDIO_ENGINE === "cpp_v2";

const ensureEngineV2 = () => {
  if (!engineV2Requested) {
    return env;
  }

  const buildDir = path.join(repoRoot, "native", "audio-engine-v2", "build");
  const libDir = path.join(buildDir, "Debug");

  run("cmake", [
    "-S",
    "native/audio-engine-v2",
    "-B",
    "native/audio-engine-v2/build",
    "-DLT_ENGINE_BUILD_TESTS=OFF",
    "-DLT_ENGINE_USE_JUCE=OFF",
    "-DLT_ENGINE_USE_RUBBERBAND=OFF",
    "-DLT_ENGINE_USE_LIBSNDFILE=ON",
    "-DLT_ENGINE_USE_R8BRAIN=ON",
  ]);
  run("cmake", [
    "--build",
    "native/audio-engine-v2/build",
    "--config",
    "Debug",
    "--target",
    "lt_audio_engine_v2",
  ]);

  const pathSeparator = process.platform === "win32" ? ";" : ":";
  return {
    ...env,
    LT_ENGINE_V2_LIB_DIR: libDir,
    PATH: `${libDir}${pathSeparator}${env.PATH ?? ""}`,
  };
};

ensureRemoteDist();
const runEnv = ensureEngineV2();

switch (mode) {
  case "dev":
    run(
      "npm",
      engineV2Requested
        ? ["--prefix", "apps/desktop", "run", "tauri:dev", "--", "--features", "audio-engine-v2"]
        : ["--prefix", "apps/desktop", "run", "tauri:dev"],
      { env: runEnv },
    );
    break;
  case "check":
    run(
      "cargo",
      engineV2Requested
        ? ["check", "-p", "libretracks-desktop", "--features", "audio-engine-v2"]
        : ["check", "-p", "libretracks-desktop"],
      { env: runEnv },
    );
    break;
  case "build":
    run(
      "npm",
      engineV2Requested
        ? ["--prefix", "apps/desktop", "run", "tauri:build", "--", "--features", "audio-engine-v2"]
        : ["--prefix", "apps/desktop", "run", "tauri:build"],
      { env: runEnv },
    );
    break;
}
