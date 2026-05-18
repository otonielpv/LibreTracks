import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
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
const defaultTargetDir = path.join(repoRoot, "target-desktop-native");

const isTruthyEnvValue = (value) => /^(1|true|yes|on)$/i.test(value ?? "");

const detectToolchainFile = (rawEnv) => {
  if (rawEnv.CMAKE_TOOLCHAIN_FILE) {
    return rawEnv.CMAKE_TOOLCHAIN_FILE;
  }

  const candidates = [
    path.resolve(repoRoot, "..", "vcpkg", "scripts", "buildsystems", "vcpkg.cmake"),
    path.resolve(repoRoot, "vcpkg", "scripts", "buildsystems", "vcpkg.cmake"),
    "D:\\Repos\\vcpkg\\scripts\\buildsystems\\vcpkg.cmake",
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? "";
};

const detectBungeeDir = (rawEnv) => {
  const candidates = [
    rawEnv.LT_BUNGEE_DIR,
    rawEnv.USERPROFILE ? path.join(rawEnv.USERPROFILE, "Downloads", "bungee-v2.4.24") : "",
    path.join(repoRoot, "vendor", "bungee"),
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(path.join(candidate, "include", "bungee", "Bungee.h"))) ?? "";
};

const buildDesktopNativeEnv = (rawEnv) => {
  const env = {
    ...rawEnv,
    LIBRETRACKS_AUDIO_ENGINE: "cpp-v2",
    CARGO_TARGET_DIR: defaultTargetDir,
    LIBRETRACKS_ENGINE_V2_RUBBERBAND: rawEnv.LIBRETRACKS_ENGINE_V2_RUBBERBAND ?? "1",
    LIBRETRACKS_ENGINE_V2_FFMPEG: rawEnv.LIBRETRACKS_ENGINE_V2_FFMPEG ?? "1",
    VCPKG_DEFAULT_TRIPLET: rawEnv.VCPKG_DEFAULT_TRIPLET ?? "x64-windows",
  };

  const toolchainFile = detectToolchainFile(rawEnv);
  if (toolchainFile) {
    env.CMAKE_TOOLCHAIN_FILE = toolchainFile;
  }

  return env;
};

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
};
const nativeEnv = buildDesktopNativeEnv(env);

const ensureEngineV2 = (normalizedEnv) => {
  const useRubberBand = isTruthyEnvValue(normalizedEnv.LIBRETRACKS_ENGINE_V2_RUBBERBAND) ? "ON" : "OFF";
  const useLibSndFile = "ON";
  const useR8Brain = "ON";
  const useFFmpeg = isTruthyEnvValue(normalizedEnv.LIBRETRACKS_ENGINE_V2_FFMPEG) ? "ON" : "OFF";
  const bungeeDir = detectBungeeDir(normalizedEnv);
  const useBungee = useRubberBand === "ON" && bungeeDir ? "ON" : "OFF";
  const buildName = useRubberBand === "ON"
    ? (useFFmpeg === "ON" ? "build-rb-on-ffmpeg" : "build-rb-on")
    : (useFFmpeg === "ON" ? "build-rb-off-ffmpeg" : "build-rb-off");
  const buildDir = path.join(repoRoot, "native", "audio-engine-v2", buildName);
  const buildArg = `native/audio-engine-v2/${buildName}`;
  const libDir = path.join(buildDir, "Debug");

  console.log(`Audio Engine v2 RubberBand: ${useRubberBand}`);
  console.log(`Audio Engine v2 Bungee: ${useBungee}`);
  if (bungeeDir) {
    console.log(`LT_BUNGEE_DIR: ${bungeeDir}`);
  }
  console.log(`VCPKG_DEFAULT_TRIPLET: ${normalizedEnv.VCPKG_DEFAULT_TRIPLET}`);
  if (normalizedEnv.CMAKE_TOOLCHAIN_FILE) {
    console.log(`CMAKE_TOOLCHAIN_FILE: ${normalizedEnv.CMAKE_TOOLCHAIN_FILE}`);
  }
  console.log(`Audio Engine v2 CMake build dir: ${buildDir}`);
  console.log(`Audio Engine v2 lib dir: ${libDir}`);
  console.log(`LT_ENGINE_USE_LIBSNDFILE: ${useLibSndFile}`);
  console.log(`LT_ENGINE_USE_R8BRAIN: ${useR8Brain}`);
  console.log(`LT_ENGINE_USE_FFMPEG: ${useFFmpeg}`);

  if (isTruthyEnvValue(normalizedEnv.LIBRETRACKS_ENGINE_V2_CLEAN) && existsSync(buildDir)) {
    rmSync(buildDir, { recursive: true, force: true });
  }

  const configureArgs = [
    "-S",
    "native/audio-engine-v2",
    "-B",
    buildArg,
    "-DLT_ENGINE_BUILD_TESTS=OFF",
    "-DLT_ENGINE_USE_JUCE=ON",
    `-DLT_ENGINE_USE_BUNGEE=${useBungee}`,
    `-DLT_ENGINE_USE_FFMPEG=${useFFmpeg}`,
    `-DLT_ENGINE_USE_LIBSNDFILE=${useLibSndFile}`,
    `-DLT_ENGINE_USE_R8BRAIN=${useR8Brain}`,
  ];
  if (useBungee === "ON") {
    configureArgs.push(`-DLT_BUNGEE_DIR=${bungeeDir}`);
  }
  if (normalizedEnv.CMAKE_TOOLCHAIN_FILE) {
    configureArgs.push(`-DCMAKE_TOOLCHAIN_FILE=${normalizedEnv.CMAKE_TOOLCHAIN_FILE}`);
  }
  if (normalizedEnv.VCPKG_DEFAULT_TRIPLET) {
    configureArgs.push(`-DVCPKG_TARGET_TRIPLET=${normalizedEnv.VCPKG_DEFAULT_TRIPLET}`);
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

  if (useFFmpeg === "ON") {
    const nativeVendorDir = path.join(repoRoot, "vendor", "bin", "native");
    mkdirSync(nativeVendorDir, { recursive: true });
    for (const fileName of readdirSync(libDir)) {
      if (/^(av.*|swresample.*)\.dll$/i.test(fileName)) {
        copyFileSync(path.join(libDir, fileName), path.join(nativeVendorDir, fileName));
      }
    }
  }

  const pathSeparator = process.platform === "win32" ? ";" : ":";
  const vcpkgRoot = normalizedEnv.VCPKG_ROOT
    ?? (normalizedEnv.CMAKE_TOOLCHAIN_FILE
      ? path.resolve(path.dirname(normalizedEnv.CMAKE_TOOLCHAIN_FILE), "..", "..")
      : "");
  const triplet = normalizedEnv.VCPKG_DEFAULT_TRIPLET ?? "x64-windows";
  const vcpkgBin = vcpkgRoot ? path.join(vcpkgRoot, "installed", triplet, "bin") : "";
  const vcpkgDebugBin = vcpkgRoot ? path.join(vcpkgRoot, "installed", triplet, "debug", "bin") : "";
  const extraPath = [libDir, vcpkgDebugBin, vcpkgBin].filter((segment) => segment && existsSync(segment)).join(pathSeparator);
  return {
    ...normalizedEnv,
    LT_ENGINE_V2_LIB_DIR: libDir,
    PATH: `${extraPath}${pathSeparator}${normalizedEnv.PATH ?? ""}`,
  };
};

ensureRemoteDist();
const runEnv = ensureEngineV2(nativeEnv);

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
