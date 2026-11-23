param(
    [Parameter(Mandatory = $true)][string]$BinDirectory,
    [string]$ComputerUseAddonDirectory
)
$ErrorActionPreference = "Stop"
$runtimeDlls = @("vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll")

function Get-VisualCppRuntimeDirectory {
    if ($env:CANTRIP_WINDOWS_VC_REDIST_DIR) {
        return [IO.Path]::GetFullPath($env:CANTRIP_WINDOWS_VC_REDIST_DIR)
    }
    $redistRoots = @()
    if ($env:VCToolsRedistDir) { $redistRoots += $env:VCToolsRedistDir }
    $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path -LiteralPath $vswhere -PathType Leaf) {
        foreach ($installation in (& $vswhere -products '*' -property installationPath)) {
            $redist = Join-Path $installation "VC\Redist\MSVC"
            $redistRoots += Get-ChildItem -LiteralPath $redist -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -match '^\d+(\.\d+)+$' } |
                Sort-Object { [version]$_.Name } -Descending |
                Select-Object -ExpandProperty FullName
        }
    }
    foreach ($root in $redistRoots) {
        $crt = Get-ChildItem -LiteralPath (Join-Path $root "x64") -Directory -Filter "Microsoft.VC*.CRT" -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($crt) { return $crt.FullName }
    }
    throw "Set CANTRIP_WINDOWS_VC_REDIST_DIR to the x64 Visual C++ redistributable DLL directory from your Visual Studio toolset."
}

$missing = @($runtimeDlls | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $BinDirectory $_) -PathType Leaf)
})
if ($missing.Count -gt 0) {
    $source = Get-VisualCppRuntimeDirectory
    # Refresh the full set when upgrading an older or incomplete bundle.
    foreach ($dll in $runtimeDlls) {
        Copy-Item -LiteralPath (Join-Path $source $dll) -Destination (Join-Path $BinDirectory $dll) -Force
    }
}

if ($ComputerUseAddonDirectory) {
    # Node loads the addon from node_modules, outside the worker helper directory.
    $dll = "vcruntime140.dll"
    Copy-Item -LiteralPath (Join-Path $BinDirectory $dll) -Destination (Join-Path $ComputerUseAddonDirectory $dll) -Force
}
