param(
    [switch] $RequireBundledDependencies,

    [Parameter(Mandatory = $true, Position = 0)]
    [string[]] $Path
)

$ErrorActionPreference = "Stop"

function Find-Dumpbin {
    $fromPath = Get-Command dumpbin.exe -ErrorAction SilentlyContinue
    if ($fromPath) {
        return $fromPath.Source
    }

    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswhere)) {
        throw "dumpbin.exe not found on PATH and vswhere.exe was not found."
    }

    $vsPath = & $vswhere -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $vsPath) {
        throw "Visual Studio C++ tools were not found."
    }

    $dumpbin = Get-ChildItem -Path (Join-Path $vsPath "VC\Tools\MSVC") -Recurse -Filter dumpbin.exe |
        Where-Object { $_.FullName -like "*\bin\Hostx64\x64\dumpbin.exe" } |
        Sort-Object FullName -Descending |
        Select-Object -First 1 -ExpandProperty FullName

    if (-not $dumpbin) {
        throw "dumpbin.exe was not found under '$vsPath'."
    }

    return $dumpbin
}

function Get-PeFiles {
    param([string[]] $InputPath)

    foreach ($input in $InputPath) {
        if (-not (Test-Path $input)) {
            Write-Warning "Path not found: $input"
            continue
        }

        $item = Get-Item $input
        if ($item.PSIsContainer) {
            Get-ChildItem $item.FullName -Recurse -File -Include *.dll, *.exe
        } elseif ($item.Extension -match '^\.(dll|exe)$') {
            $item
        }
    }
}

function Test-SystemDll {
    param([string] $Name)

    if ($Name -match '^(API-MS-WIN-|EXT-MS-WIN-)') {
        return $true
    }

    $systemDlls = @(
        "ADVAPI32.DLL",
        "AVRT.DLL",
        "BCRYPT.DLL",
        "COMCTL32.DLL",
        "COMDLG32.DLL",
        "CRYPT32.DLL",
        "D3D11.DLL",
        "D3D12.DLL",
        "DBGHELP.DLL",
        "DWMAPI.DLL",
        "DXGI.DLL",
        "DXVA2.DLL",
        "EVR.DLL",
        "GDI32.DLL",
        "IMM32.DLL",
        "KERNEL32.DLL",
        "MF.DLL",
        "MFPLAT.DLL",
        "MFREADWRITE.DLL",
        "MFSENSORGROUP.DLL",
        "MSVCRT.DLL",
        "NCRYPT.DLL",
        "NTDLL.DLL",
        "OLE32.DLL",
        "OLEAUT32.DLL",
        "PROPSYS.DLL",
        "PSAPI.DLL",
        "RPCRT4.DLL",
        "SECUR32.DLL",
        "SETUPAPI.DLL",
        "SHELL32.DLL",
        "SHLWAPI.DLL",
        "UCRTBASE.DLL",
        "USER32.DLL",
        "UXTHEME.DLL",
        "VERSION.DLL",
        "WININET.DLL",
        "WINMM.DLL",
        "WS2_32.DLL",
        "WSOCK32.DLL"
    )

    return $systemDlls -contains $Name
}

$dumpbin = Find-Dumpbin
$files = @(Get-PeFiles -InputPath $Path | Sort-Object FullName -Unique)
if ($files.Count -eq 0) {
    throw "No .dll or .exe files found to inspect."
}

$bundledFileNames = @{}
foreach ($file in $files) {
    $bundledFileNames[$file.Name.ToUpperInvariant()] = $true
}

$blockedImports = '^(VCRUNTIME|MSVCP|CONCRT|VCOMP)140.*\.DLL$'
$failures = @()
$missing = @()

foreach ($file in $files) {
    $output = & $dumpbin /nologo /dependents $file.FullName
    if ($LASTEXITCODE -ne 0) {
        throw "dumpbin failed for '$($file.FullName)' with exit code $LASTEXITCODE."
    }

    $imports = $output |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ -match '^[A-Za-z0-9_.-]+\.dll$' } |
        ForEach-Object { $_.ToUpperInvariant() }

    $badImports = @($imports | Where-Object { $_ -match $blockedImports })
    if ($badImports.Count -gt 0) {
        foreach ($import in $badImports) {
            $failures += "$($file.FullName) imports $import"
        }
    }

    if ($RequireBundledDependencies) {
        foreach ($import in $imports) {
            if ($bundledFileNames.ContainsKey($import) -or (Test-SystemDll -Name $import)) {
                continue
            }
            $missing += "$($file.FullName) imports $import, but it is not bundled"
        }
    }
}

if ($failures.Count -gt 0) {
    Write-Error ("Windows artifacts still require the VC++ Redistributable:`n" + ($failures -join "`n"))
    exit 1
}

if ($missing.Count -gt 0) {
    Write-Error ("Windows artifacts have unbundled runtime dependencies:`n" + ($missing -join "`n"))
    exit 1
}

$closureMessage = if ($RequireBundledDependencies) { " Bundled dependency closure is complete." } else { "" }
Write-Host "Checked $($files.Count) Windows PE artifact(s); no VC++ Redistributable imports found.$closureMessage"
