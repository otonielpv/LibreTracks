# Build the C++ audio engine v2 on Windows.
#
# Usage:
#   .\scripts\build.ps1 [-Config Release|Debug] [-Generator <cmake-generator>]
#
# Prerequisites:
#   - CMake >= 3.25
#   - Visual Studio 2022 (or LLVM/clang-cl)
#   - git (for FetchContent)
#
# Optional:
#   -AsioSdkDir : Path to the Steinberg ASIO SDK for ASIO support.

param(
    [string]$Config      = "Release",
    [string]$Generator   = "Visual Studio 17 2022",
    [string]$AsioSdkDir  = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EngineDir = Join-Path $ScriptDir ".."
$BuildDir  = Join-Path $EngineDir "build"

$cmakeArgs = @(
    "-S", $EngineDir,
    "-B", $BuildDir,
    "-G", $Generator,
    "-A", "x64",
    "-DCMAKE_BUILD_TYPE=$Config",
    "-DLT_ENGINE_BUILD_TESTS=ON"
)

if ($AsioSdkDir) {
    $cmakeArgs += "-DLT_ASIO_SDK_DIR=$AsioSdkDir"
}

Write-Host "Configuring..." -ForegroundColor Cyan
cmake @cmakeArgs

Write-Host "Building ($Config)..." -ForegroundColor Cyan
cmake --build $BuildDir --config $Config --parallel

Write-Host "Done. Output in: $BuildDir\$Config\" -ForegroundColor Green
