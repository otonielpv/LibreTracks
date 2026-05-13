import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
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
  LIBRETRACKS_AUDIO_ENGINE: "cpp-v2",
  CARGO_TARGET_DIR: path.join(repoRoot, "target-desktop-native"),
};

const ensureEngineV2 = () => {
  const useRubberBand = /^(1|true|yes|on)$/i.test(process.env.LIBRETRACKS_ENGINE_V2_RUBBERBAND ?? "") ? "ON" : "OFF";
  const buildName = useRubberBand === "ON" ? "build-rb-on" : "build-rb-off";
  const buildDir = path.join(repoRoot, "native", "audio-engine-v2", buildName);
  const buildArg = `native/audio-engine-v2/${buildName}`;
  const libDir = path.join(buildDir, "Debug");
  const useLibSndFile = "ON";
  const useR8Brain = "ON";
  const useFFmpeg = "OFF";

  console.log(`Audio Engine v2 RubberBand: ${useRubberBand}`);
  console.log(`Audio Engine v2 CMake build dir: ${buildDir}`);
  console.log(`Audio Engine v2 lib dir: ${libDir}`);
  console.log(`LT_ENGINE_USE_LIBSNDFILE: ${useLibSndFile}`);
  console.log(`LT_ENGINE_USE_R8BRAIN: ${useR8Brain}`);
  console.log(`LT_ENGINE_USE_FFMPEG: ${useFFmpeg}`);
  if (process.env.CMAKE_TOOLCHAIN_FILE) {
    console.log(`CMAKE_TOOLCHAIN_FILE: ${process.env.CMAKE_TOOLCHAIN_FILE}`);
  }

  if (/^(1|true|yes|on)$/i.test(process.env.LIBRETRACKS_ENGINE_V2_CLEAN ?? "") && existsSync(buildDir)) {
    rmSync(buildDir, { recursive: true, force: true });
  }

  const configureArgs = [
    "-S",
    "native/audio-engine-v2",
    "-B",
    buildArg,
    "-DLT_ENGINE_BUILD_TESTS=OFF",
    "-DLT_ENGINE_USE_JUCE=ON",
    `-DLT_ENGINE_USE_RUBBERBAND=${useRubberBand}`,
    `-DLT_ENGINE_USE_LIBSNDFILE=${useLibSndFile}`,
    `-DLT_ENGINE_USE_R8BRAIN=${useR8Brain}`,
  ];
  if (process.env.CMAKE_TOOLCHAIN_FILE) {
    configureArgs.push(`-DCMAKE_TOOLCHAIN_FILE=${process.env.CMAKE_TOOLCHAIN_FILE}`);
  }
  if (process.env.VCPKG_DEFAULT_TRIPLET) {
    configureArgs.push(`-DVCPKG_TARGET_TRIPLET=${process.env.VCPKG_DEFAULT_TRIPLET}`);
  }
  run("cmake", configureArgs);
  run("cmake", [
    "--build",
    buildArg,
    "--config",
    "Debug",
    "--target",
    "lt_audio_engine_v2",
  ]);

  const pathSeparator = process.platform === "win32" ? ";" : ":";
  const vcpkgRoot = process.env.VCPKG_ROOT
    ?? (process.env.CMAKE_TOOLCHAIN_FILE
      ? path.resolve(path.dirname(process.env.CMAKE_TOOLCHAIN_FILE), "..", "..")
      : "");
  const triplet = process.env.VCPKG_DEFAULT_TRIPLET ?? "x64-windows";
  const vcpkgBin = vcpkgRoot ? path.join(vcpkgRoot, "installed", triplet, "bin") : "";
  const vcpkgDebugBin = vcpkgRoot ? path.join(vcpkgRoot, "installed", triplet, "debug", "bin") : "";
  const extraPath = [libDir, vcpkgDebugBin, vcpkgBin].filter((segment) => segment && existsSync(segment)).join(pathSeparator);
  return {
    ...env,
    LT_ENGINE_V2_LIB_DIR: libDir,
    PATH: `${extraPath}${pathSeparator}${env.PATH ?? ""}`,
  };
};

ensureRemoteDist();
const runEnv = ensureEngineV2();

switch (mode) {
  case "dev":
    run(
      "npm",
      ["--prefix", "apps/desktop", "run", "tauri:dev"],
      { env: runEnv },
    );
    break;
  case "check":
    run(
      "cargo",
      ["check", "-p", "libretracks-desktop"],
      { env: runEnv },
    );
    break;
  case "build":
    run(
      "npm",
      ["--prefix", "apps/desktop", "run", "tauri:build"],
      { env: runEnv },
    );
    break;
}
