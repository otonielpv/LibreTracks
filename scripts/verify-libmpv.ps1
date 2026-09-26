# Verifica la libmpv que se empaqueta en Windows (plan de video, paso 02).
#
#   .\scripts\verify-libmpv.ps1 <ruta a libmpv-2.dll> [-Installer <instalador NSIS>]
#
# Falla si:
#   - la DLL no existe;
#   - no exporta la API cliente de mpv (mpv_create, mpv_client_api_version);
#   - exporta simbolos de FFmpeg (av*_, sws_, swr_...). libmpv debe llevar su
#     FFmpeg ESTATICO y oculto: si exportara av_*, el cargador podria mezclarlo
#     con los avcodec-*.dll del motor y romper el audio;
#   - con -Installer, el instalador no contiene libmpv-2.dll.
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string] $Path,

    [string] $Installer
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
    $dumpbin = Get-ChildItem -Path (Join-Path $vsPath "VC\Tools\MSVC") -Recurse -Filter dumpbin.exe |
        Where-Object { $_.FullName -like "*\bin\Hostx64\x64\dumpbin.exe" } |
        Sort-Object FullName -Descending |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $dumpbin) {
        throw "dumpbin.exe was not found under '$vsPath'."
    }
    return $dumpbin
}

if (-not (Test-Path $Path)) {
    Write-Error "libmpv no encontrada en '$Path'."
    exit 1
}

$dumpbin = Find-Dumpbin
$output = & $dumpbin /nologo /exports $Path
if ($LASTEXITCODE -ne 0) {
    throw "dumpbin /exports fallo para '$Path' (codigo $LASTEXITCODE)."
}

# Lineas de la tabla de exportaciones: "ordinal hint RVA nombre".
$exports = $output |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -match '^\d+\s+[0-9A-Fa-f]+\s+[0-9A-Fa-f]+\s+(\S+)' } |
    ForEach-Object { ($_ -split '\s+')[3] }

$failures = @()
foreach ($required in @("mpv_create", "mpv_client_api_version", "mpv_wait_event")) {
    if ($exports -notcontains $required) {
        $failures += "no exporta ${required}: no es libmpv"
    }
}

$ffmpegPattern = '^(av|avcodec|avformat|avutil|avfilter|avdevice|sws|swr|swresample|postproc)_'
$leaked = @($exports | Where-Object { $_ -match $ffmpegPattern })
if ($leaked.Count -gt 0) {
    $sample = ($leaked | Select-Object -First 5) -join ", "
    $failures += "exporta $($leaked.Count) simbolos de FFmpeg (p. ej. $sample): su FFmpeg no es estatico/oculto"
}

if ($Installer) {
    if (-not (Test-Path $Installer)) {
        $failures += "instalador '$Installer' no encontrado"
    } else {
        $listing = & 7z l $Installer
        if (-not ($listing | Select-String -SimpleMatch "libmpv-2.dll")) {
            $failures += "el instalador '$Installer' no contiene libmpv-2.dll"
        }
    }
}

if ($failures.Count -gt 0) {
    Write-Error ("libmpv no valida para la release:`n" + ($failures -join "`n"))
    exit 1
}

$mpvExports = @($exports | Where-Object { $_ -like "mpv_*" }).Count
$sizeMb = [math]::Round((Get-Item $Path).Length / 1MB, 1)
Write-Host "libmpv OK: $Path ($sizeMb MB), $mpvExports exportaciones mpv_*, ningun simbolo de FFmpeg exportado."
