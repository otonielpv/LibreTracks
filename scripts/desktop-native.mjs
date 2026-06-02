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

const detectAsioSdkDir = (rawEnv) => {
  // JUCE's ASIO device type needs iasiodrv.h from the Steinberg SDK at build
  // time. Public mirror: https://github.com/audiosdk/asio.git. The header
  // lives at <sdk>/common/iasiodrv.h; we use its presence as the validity
  // check, matching what dependencies.cmake expects.
  const candidates = [
    rawEnv.LT_ASIO_SDK_DIR,
    "D:/Repos/asiosdk",
    path.join(repoRoot, "vendor", "asiosdk"),
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(path.join(candidate, "common", "iasiodrv.h"))) ?? "";
};

const buildDesktopNativeEnv = (rawEnv) => {
  const env = {
    ...rawEnv,
    LIBRETRACKS_AUDIO_ENGINE: "cpp-v2",
    CARGO_TARGET_DIR: defaultTargetDir,
    LIBRETRACKS_AUDIO_DEBUG_LOG: rawEnv.LIBRETRACKS_AUDIO_DEBUG_LOG ?? path.join(repoRoot, "lt_audio_debug.log"),
    LIBRETRACKS_ENGINE_V2_BUNGEE:
      rawEnv.LIBRETRACKS_ENGINE_V2_BUNGEE ?? rawEnv.LIBRETRACKS_ENGINE_V2_RUBBERBAND ?? "1",
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

const copyLinuxRuntimeDependencies = (sourceFile, nativeVendorDir) => {
  if (process.platform !== "linux") {
    return;
  }

  const result = spawnSync("ldd", [sourceFile], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    return;
  }

  const wantedLibraries = /^lib(?:avcodec|avformat|avutil|swresample)\.so(?:\.\d+)*$/;
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/=>\s+(\/\S+)/) ?? line.match(/^\s*(\/\S+)/);
    if (!match) {
      continue;
    }

    const dependencyPath = match[1];
    const dependencyName = path.basename(dependencyPath);
    if (!wantedLibraries.test(dependencyName) || !existsSync(dependencyPath)) {
      continue;
    }

    copyFileSync(dependencyPath, path.join(nativeVendorDir, dependencyName));
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
  const useBungeeRequested = isTruthyEnvValue(normalizedEnv.LIBRETRACKS_ENGINE_V2_BUNGEE) ? "ON" : "OFF";
  const useLibSndFile = "ON";
  const useR8Brain = "ON";
  const useFFmpeg = isTruthyEnvValue(normalizedEnv.LIBRETRACKS_ENGINE_V2_FFMPEG) ? "ON" : "OFF";
  // RubberBand (GPL v2) is opt-in as a second warp backend. Set
  // LIBRETRACKS_ENGINE_V2_RUBBERBAND=1 to link it.
  const useRubberBand = isTruthyEnvValue(normalizedEnv.LIBRETRACKS_ENGINE_V2_RUBBERBAND) ? "ON" : "OFF";
  const bungeeDir = detectBungeeDir(normalizedEnv);
  const useBungee = useBungeeRequested === "ON" && bungeeDir ? "ON" : "OFF";
  const asioSdkDir = detectAsioSdkDir(normalizedEnv);
  const buildName = useBungeeRequested === "ON"
    ? (useFFmpeg === "ON" ? "build-bungee-on-ffmpeg" : "build-bungee-on")
    : (useFFmpeg === "ON" ? "build-bungee-off-ffmpeg" : "build-bungee-off");
  const buildDir = path.join(repoRoot, "native", "audio-engine-v2", buildName);
  const buildArg = `native/audio-engine-v2/${buildName}`;
  const buildConfig = mode === "build" ? "Release" : "Debug";
  const libDir = process.platform === "win32" ? path.join(buildDir, buildConfig) : buildDir;

  console.log(`Audio Engine v2 Bungee requested: ${useBungeeRequested}`);
  console.log(`Audio Engine v2 Bungee: ${useBungee}`);
  console.log(`Audio Engine v2 RubberBand: ${useRubberBand}`);
  if (bungeeDir) {
    console.log(`LT_BUNGEE_DIR: ${bungeeDir}`);
  }
  console.log(
    asioSdkDir
      ? `LT_ASIO_SDK_DIR: ${asioSdkDir}`
      : "LT_ASIO_SDK_DIR: (not set — ASIO module disabled)",
  );
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
    "-DLT_ENGINE_BUILD_BENCHES=OFF",
    "-DLT_ENGINE_USE_JUCE=ON",
    `-DLT_ENGINE_USE_BUNGEE=${useBungee}`,
    `-DLT_ENGINE_USE_FFMPEG=${useFFmpeg}`,
    `-DLT_ENGINE_USE_LIBSNDFILE=${useLibSndFile}`,
    `-DLT_ENGINE_USE_R8BRAIN=${useR8Brain}`,
    `-DLT_ENGINE_USE_RUBBERBAND=${useRubberBand}`,
    `-DVCPKG_MANIFEST_FEATURES=${useRubberBand === "ON" ? "rubberband" : ""}`,
  ];
  if (useBungee === "ON") {
    configureArgs.push(`-DLT_BUNGEE_DIR=${bungeeDir}`);
  }
  if (asioSdkDir) {
    configureArgs.push(`-DLT_ASIO_SDK_DIR=${asioSdkDir}`);
  }
  if (normalizedEnv.CMAKE_TOOLCHAIN_FILE) {
    configureArgs.push(`-DCMAKE_TOOLCHAIN_FILE=${normalizedEnv.CMAKE_TOOLCHAIN_FILE}`);
  }
  if (normalizedEnv.VCPKG_DEFAULT_TRIPLET) {
    configureArgs.push(`-DVCPKG_TARGET_TRIPLET=${normalizedEnv.VCPKG_DEFAULT_TRIPLET}`);
  }
  if (process.platform === "darwin") {
    configureArgs.push(`-DCMAKE_OSX_ARCHITECTURES=${normalizedEnv.CMAKE_OSX_ARCHITECTURES ?? "x86_64;arm64"}`);
    configureArgs.push(`-DCMAKE_OSX_DEPLOYMENT_TARGET=${normalizedEnv.MACOSX_DEPLOYMENT_TARGET ?? "10.13"}`);
  }
  run("cmake", configureArgs);
  run("cmake", [
    "--build",
    buildArg,
    "--config",
    buildConfig,
    "--target",
    "lt_audio_engine_v2",
  ]);

  const nativeVendorDir = path.join(repoRoot, "vendor", "bin", "native");
  mkdirSync(nativeVendorDir, { recursive: true });
  for (const fileName of readdirSync(nativeVendorDir)) {
    if (/\.(dll|dylib|so)$/i.test(fileName)) {
      rmSync(path.join(nativeVendorDir, fileName), { force: true });
    }
  }
  for (const fileName of readdirSync(libDir)) {
    if (/\.(dll|dylib|so)$/i.test(fileName)) {
      const sourceFile = path.join(libDir, fileName);
      copyFileSync(sourceFile, path.join(nativeVendorDir, fileName));
      copyLinuxRuntimeDependencies(sourceFile, nativeVendorDir);
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
