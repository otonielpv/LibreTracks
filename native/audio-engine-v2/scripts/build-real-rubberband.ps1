# Build the audio engine with real RubberBand pitch backend on Windows.
#
# Usage:
#   .\scripts\build-real-rubberband.ps1 [-RubberbandRoot <path>] [-Config Debug|Release] [-RunTests]
#
# RubberbandRoot: path to a RubberBand installation containing:
#   include/rubberband/RubberBandStretcher.h
#   lib/rubberband.lib  (or debug/lib/rubberband.lib)
#   bin/rubberband-3.dll (or debug/bin/rubberband-3.dll)
#
# If RubberbandRoot is not supplied, CMake will try FetchContent (requires git + network).
#
# Prerequisites: CMake >= 3.25, Visual Studio 2022, git
#
param(
    [string]$RubberbandRoot = "",
    [string]$Config         = "Debug",
    [string]$Generator      = "Visual Studio 17 2022",
    [switch]$RunTests,
    [switch]$BuildTests
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EngineDir = Join-Path $ScriptDir ".."
$BuildDir  = Join-Path $EngineDir "build-rb-real"

$shouldBuildTests = $BuildTests -or $RunTests

$cmakeArgs = @(
    "-S", $EngineDir,
    "-B", $BuildDir,
    "-G", $Generator,
    "-A", "x64",
    "-DCMAKE_BUILD_TYPE=$Config",
    "-DLT_ENGINE_USE_RUBBERBAND=ON",
    "-DLT_ENGINE_ALLOW_PITCH_STUB=OFF",
    "-DLT_ENGINE_REQUIRE_REAL_RUBBERBAND=ON",
    "-DLT_ENGINE_ALLOW_RUNTIME_PITCH_STUB_PASSTHROUGH=OFF",
    "-DLT_ENGINE_BUILD_TESTS=$(if ($shouldBuildTests) { 'ON' } else { 'OFF' })"
)

if ($RubberbandRoot) {
    $cmakeArgs += "-DRUBBERBAND_ROOT=$RubberbandRoot"
    $cmakeArgs += "-DCMAKE_PREFIX_PATH=$RubberbandRoot"
}

Write-Host ""
Write-Host "=== LibreTracks Real RubberBand Build ===" -ForegroundColor Cyan
Write-Host "  Engine dir     : $EngineDir"
Write-Host "  Build dir      : $BuildDir"
Write-Host "  Config         : $Config"
if ($RubberbandRoot) {
    Write-Host "  RubberbandRoot : $RubberbandRoot"
} else {
    Write-Host "  RubberbandRoot : (FetchContent from GitHub)"
}
Write-Host "  Build tests    : $shouldBuildTests"
Write-Host ""

# Verify RubberBand header if root is supplied.
if ($RubberbandRoot) {
    $rbHeader = Join-Path $RubberbandRoot "include\rubberband\RubberBandStretcher.h"
    if (-not (Test-Path $rbHeader)) {
        Write-Error "RubberBand header not found: $rbHeader"
        Write-Error "Check that -RubberbandRoot points to the correct installation."
        exit 1
    }
    Write-Host "  RubberBand header: $rbHeader (found)" -ForegroundColor Green

    $rbLib = Join-Path $RubberbandRoot "lib\rubberband.lib"
    if (-not (Test-Path $rbLib)) {
        $rbLib = Join-Path $RubberbandRoot "debug\lib\rubberband.lib"
    }
    if (Test-Path $rbLib) {
        Write-Host "  RubberBand lib   : $rbLib (found)" -ForegroundColor Green
    } else {
        Write-Warning "  RubberBand lib not found at expected location. CMake may still discover it."
    }
}

Write-Host ""
Write-Host "Configuring..." -ForegroundColor Cyan
cmake @cmakeArgs
if ($LASTEXITCODE -ne 0) {
    Write-Error "CMake configure failed."
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Building ($Config)..." -ForegroundColor Cyan
cmake --build $BuildDir --config $Config --parallel
if ($LASTEXITCODE -ne 0) {
    Write-Error "Build failed."
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "=== Pitch Backend Summary ===" -ForegroundColor Cyan

if ($shouldBuildTests -and $RunTests) {
    $testExe = Join-Path $BuildDir "tests\$Config\lt_engine_tests.exe"
    if (-not (Test-Path $testExe)) {
        Write-Error "Test executable not found: $testExe"
        exit 1
    }

    # Copy RubberBand DLL next to the test executable if available.
    if ($RubberbandRoot) {
        $rbDll = Join-Path $RubberbandRoot "bin\rubberband-3.dll"
        if (-not (Test-Path $rbDll)) { $rbDll = Join-Path $RubberbandRoot "debug\bin\rubberband-3.dll" }
        if (-not (Test-Path $rbDll)) { $rbDll = Join-Path $RubberbandRoot "bin\rubberband.dll" }
        if (Test-Path $rbDll) {
            $testDir = Split-Path $testExe
            Copy-Item $rbDll $testDir -Force
            Write-Host "  Copied RubberBand DLL -> $testDir" -ForegroundColor Green
        }
    }

    Write-Host ""
    Write-Host "Running all tests..." -ForegroundColor Cyan
    & $testExe --duration=true
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Some tests failed (exit code $LASTEXITCODE)."
        exit $LASTEXITCODE
    }

    Write-Host ""
    Write-Host "Running pitch-specific tests..." -ForegroundColor Cyan
    & $testExe --test-case="*pitch*" --duration=true
    & $testExe --test-case="*backend*" --duration=true
    & $testExe --test-case="*rubberband*" --duration=true
}

Write-Host ""
Write-Host "Build complete. Real RubberBand pitch backend active." -ForegroundColor Green
Write-Host "Output: $BuildDir\$Config\" -ForegroundColor Green
Write-Host ""
Write-Host "To verify backend at runtime:" -ForegroundColor Yellow
Write-Host '  $env:LIBRETRACKS_AUDIO_DEBUG = "1"' -ForegroundColor Yellow
Write-Host "  npm run dev:desktop:native" -ForegroundColor Yellow
Write-Host "  Look for: [LT_PITCH_DEBUG] pitch_backend=rubberband runtime_enabled=true" -ForegroundColor Yellow
