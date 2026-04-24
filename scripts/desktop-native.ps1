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
$scopeCppSdkRoot = Join-Path ${env:ProgramFiles} "Microsoft Visual Studio\2022\Community\SDK\ScopeCppSDK\vc15\VC"

function Add-EnvironmentSegment {
  param(
    [Parameter(Mandatory = $true)]
    [string]$VariableName,
    [string]$PathSegment
  )

  if (-not $PathSegment -or -not (Test-Path $PathSegment)) {
    return
  }

  $currentValue = [System.Environment]::GetEnvironmentVariable($VariableName)
  $existingSegments = @($currentValue -split ';' | Where-Object { $_ })
  if ($existingSegments -contains $PathSegment) {
    return
  }

  [System.Environment]::SetEnvironmentVariable($VariableName, "$PathSegment;$currentValue")
}

function Add-PathSegment {
  param([string]$PathSegment)

  Add-EnvironmentSegment -VariableName "PATH" -PathSegment $PathSegment
}

function Add-LibSegment {
  param([string]$PathSegment)

  Add-EnvironmentSegment -VariableName "LIB" -PathSegment $PathSegment
}

function Import-CmdEnvironment {
  param(
    [Parameter(Mandatory = $true)]
    [string]$BatchFile,
    [string[]]$Arguments = @()
  )

  if (-not (Test-Path $BatchFile)) {
    return $false
  }

  $quotedBatchFile = '"{0}"' -f $BatchFile
  $argumentSuffix = if ($Arguments.Count -gt 0) {
    ' ' + ($Arguments -join ' ')
  } else {
    ''
  }

  $environmentLines = & cmd.exe /s /c "$quotedBatchFile$argumentSuffix >nul && set"
  if ($LASTEXITCODE -ne 0) {
    return $false
  }

  foreach ($line in $environmentLines) {
    if ($line -match '^(.*?)=(.*)$') {
      [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2])
    }
  }

  return $true
}

function Resolve-VisualStudioDevCommand {
  $candidates = @()
  $vswherePath = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"

  if (Test-Path $vswherePath) {
    $vswhereProducts = @(
      "Microsoft.VisualStudio.Product.BuildTools",
      "Microsoft.VisualStudio.Product.Community",
      "Microsoft.VisualStudio.Product.Professional",
      "Microsoft.VisualStudio.Product.Enterprise"
    )

    foreach ($product in $vswhereProducts) {
      $installationPath = (& $vswherePath -latest -products $product -property installationPath 2>$null | Select-Object -First 1)
      if ($installationPath) {
        $candidates += (Join-Path $installationPath "Common7\Tools\VsDevCmd.bat")
      }
    }
  }

  foreach ($edition in @("BuildTools", "Community", "Professional", "Enterprise")) {
    $candidates += (Join-Path ${env:ProgramFiles} "Microsoft Visual Studio\2022\$edition\Common7\Tools\VsDevCmd.bat")
    $candidates += (Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\2019\$edition\Common7\Tools\VsDevCmd.bat")
  }

  return $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

function Test-LibraryAvailability {
  param([Parameter(Mandatory = $true)][string]$LibraryName)

  foreach ($directory in @($env:LIB -split ';' | Where-Object { $_ })) {
    if (Test-Path (Join-Path $directory $LibraryName)) {
      return $true
    }
  }

  return $false
}

function Resolve-WindowsSdkLibraryDirectories {
  $directories = @()

  foreach ($kitsRoot in @(
    (Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\Lib"),
    (Join-Path ${env:ProgramFiles(x86)} "Windows Kits\8.1\Lib")
  )) {
    if (-not (Test-Path $kitsRoot)) {
      continue
    }

    $directories += Get-ChildItem -Path $kitsRoot -Directory -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      ForEach-Object {
        @(
          (Join-Path $_.FullName "um\x64"),
          (Join-Path $_.FullName "ucrt\x64")
        )
      } |
      Where-Object { Test-Path $_ }
  }

  return $directories | Select-Object -Unique
}

function Assert-NativeToolchainReady {
  if (-not (Get-Command link.exe -ErrorAction SilentlyContinue)) {
    throw "MSVC linker not found. Install Visual Studio Build Tools with Desktop development with C++."
  }

  Add-LibSegment (Join-Path $scopeCppSdkRoot "lib")

  foreach ($directory in Resolve-WindowsSdkLibraryDirectories) {
    Add-LibSegment $directory
  }

  if (-not (Test-LibraryAvailability "kernel32.lib") -or -not (Test-LibraryAvailability "ucrt.lib")) {
    throw "Windows SDK libraries were not found. Install the Windows 10/11 SDK and the Desktop development with C++ workload so `kernel32.lib` and `ucrt.lib` are available."
  }
}

function Initialize-MsvcEnvironment {
  if (Get-Command link.exe -ErrorAction SilentlyContinue) {
    return
  }

  $vsDevCmd = Resolve-VisualStudioDevCommand
  if ($vsDevCmd) {
    $imported = Import-CmdEnvironment -BatchFile $vsDevCmd -Arguments @("-arch=x64", "-host_arch=x64")
    if ($imported -and (Get-Command link.exe -ErrorAction SilentlyContinue)) {
      return
    }
  }

  $fallbackLinkPath = Join-Path ${env:ProgramFiles} "Microsoft Visual Studio\2022\Community\SDK\ScopeCppSDK\vc15\VC\bin"
  Add-PathSegment $fallbackLinkPath
}

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
  $orderedPathSegments = @($pathSegments)
  [Array]::Reverse($orderedPathSegments)
  foreach ($pathSegment in $orderedPathSegments) {
    Add-PathSegment $pathSegment
  }
}

Initialize-MsvcEnvironment
Assert-NativeToolchainReady

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
