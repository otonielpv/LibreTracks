param(
  [ValidateSet("dev", "check", "build")]
  [string]$Mode = "dev"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$nativeTargetDir = Join-Path $repoRoot "target-desktop-native"
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
$toolchainRoot = Join-Path $env:USERPROFILE ".rustup\toolchains"
$toolchainBin = $null

if (Test-Path $toolchainRoot) {
  $toolchainBin = Get-ChildItem -Path $toolchainRoot -Directory |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName "bin" } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
}

$pathSegments = @()
if (Test-Path $cargoBin) {
  $pathSegments += $cargoBin
}

if ($toolchainBin) {
  $pathSegments += $toolchainBin
}

if ($pathSegments.Count -gt 0) {
  $env:PATH = ($pathSegments -join ";") + ";" + $env:PATH
}

Set-Location $repoRoot

# Use a repo-local target dir dedicated to the native desktop workflow.
# This avoids Tauri reusing stale build artifacts from other workspaces.
$env:CARGO_TARGET_DIR = $nativeTargetDir

switch ($Mode) {
  "dev" {
    npm --prefix apps/desktop run tauri:dev
  }
  "check" {
    cargo check -p libretracks-desktop
  }
  "build" {
    npm --prefix apps/desktop run tauri:build
  }
}
