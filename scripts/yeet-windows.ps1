[CmdletBinding()]
param(
    [string]$RepositoryUrl = "https://github.com/ArcaneArts/Cantrip.git",
    [string]$Ref = "main",
    [string]$CheckoutPath = "C:\src\Cantrip",
    [ValidateRange(0, 64)]
    [int]$CargoJobs = 0,
    [ValidateSet("nsis", "msi", "all")]
    [string]$Installer = "nsis",
    [switch]$SkipChecks,
    [string]$ElevatedParameters
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$scriptParameters = @{}
foreach ($name in $PSBoundParameters.Keys) {
    if ($name -ne "ElevatedParameters") {
        $scriptParameters[$name] = $PSBoundParameters[$name]
    }
}

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function ConvertFrom-ElevatedParameters {
    param([string]$Encoded)

    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Encoded))
    $decoded = ConvertFrom-Json $json
    $parameters = @{}
    foreach ($property in $decoded.PSObject.Properties) {
        $parameters[$property.Name] = $property.Value
    }
    return $parameters
}

function Restart-AsAdministrator {
    param([hashtable]$Parameters)

    $json = ConvertTo-Json $Parameters -Compress
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    $quotedScript = '"{0}"' -f $PSCommandPath.Replace('"', '""')
    $arguments = @(
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $quotedScript,
        "-ElevatedParameters", $encoded
    )

    Write-Host "Administrator access is required to install the build tools."
    $process = Start-Process -FilePath "$PSHOME\powershell.exe" -Verb RunAs -ArgumentList $arguments -Wait -PassThru
    exit $process.ExitCode
}

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [string[]]$Arguments = @(),
        [int[]]$AllowedExitCodes = @(0)
    )

    Write-Host "> $Command $($Arguments -join ' ')" -ForegroundColor DarkGray
    & $Command @Arguments
    $exitCode = $LASTEXITCODE
    if ($AllowedExitCodes -notcontains $exitCode) {
        throw "$Command failed with exit code $exitCode."
    }
}

function Invoke-NativeCapture {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,
        [string[]]$Arguments = @()
    )

    $output = @(& $Command @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "$Command failed with exit code $exitCode.`n$($output -join [Environment]::NewLine)"
    }
    return $output
}

function Add-ProcessPath {
    param([string]$Directory)

    if ([string]::IsNullOrWhiteSpace($Directory) -or !(Test-Path -LiteralPath $Directory)) {
        return
    }
    $entries = @($env:Path -split ";")
    if ($entries -notcontains $Directory) {
        $env:Path = "$Directory;$env:Path"
    }
}

function Update-ProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machinePath;$userPath"

    Add-ProcessPath "$env:ProgramFiles\Git\cmd"
    Add-ProcessPath "$env:ProgramFiles\nodejs"
    Add-ProcessPath "$env:ProgramFiles\CMake\bin"
    Add-ProcessPath "$env:ProgramFiles\NASM"
    Add-ProcessPath "$env:LOCALAPPDATA\Microsoft\WinGet\Links"
    Add-ProcessPath "$env:USERPROFILE\.cargo\bin"

    foreach ($pythonDirectory in @(Get-ChildItem "$env:LOCALAPPDATA\Programs\Python\Python3*" -Directory -ErrorAction SilentlyContinue)) {
        Add-ProcessPath $pythonDirectory.FullName
        Add-ProcessPath (Join-Path $pythonDirectory.FullName "Scripts")
    }
}

function Test-CommandAvailable {
    param([string]$Name)
    return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Ensure-WinGet {
    if (Test-CommandAvailable "winget.exe") {
        return
    }

    Write-Step "Installing WinGet"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Install-PackageProvider -Name NuGet -Force | Out-Null
    $galleryPolicy = (Get-PSRepository -Name PSGallery).InstallationPolicy
    try {
        Set-PSRepository -Name PSGallery -InstallationPolicy Trusted
        Install-Module -Name Microsoft.WinGet.Client -Repository PSGallery -Force -Scope AllUsers
    }
    finally {
        Set-PSRepository -Name PSGallery -InstallationPolicy $galleryPolicy
    }
    Import-Module Microsoft.WinGet.Client
    Repair-WinGetPackageManager -AllUsers
    Update-ProcessPath

    if (!(Test-CommandAvailable "winget.exe")) {
        throw "WinGet was installed but winget.exe is still unavailable. Reboot Windows and run this script again."
    }
}

function Test-WinGetPackage {
    param([string]$Id)

    & winget.exe list --id $Id --exact --source winget --accept-source-agreements --disable-interactivity *> $null
    return $LASTEXITCODE -eq 0
}

function Install-WinGetPackage {
    param(
        [string]$Id,
        [string]$Description,
        [string]$Architecture = "",
        [string]$Override = ""
    )

    if (Test-WinGetPackage $Id) {
        Write-Host "$Description is already installed."
        return
    }

    Write-Step "Installing $Description"
    $arguments = @(
        "install",
        "--id", $Id,
        "--exact",
        "--source", "winget",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--disable-interactivity"
    )
    if ($Architecture) {
        $arguments += @("--architecture", $Architecture)
    }
    if ($Override) {
        $arguments += @("--override", $Override)
    }
    Invoke-Native "winget.exe" $arguments
    Update-ProcessPath
}

function Get-VisualStudioPath {
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    $windowsSdk = "${env:ProgramFiles(x86)}\Windows Kits\10\Include\*\um\Windows.h"
    if (!(Test-Path -LiteralPath $vswhere)) {
        return $null
    }
    if (!(Test-Path $windowsSdk)) {
        return $null
    }

    $installations = @(& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
    if ($LASTEXITCODE -ne 0 -or $installations.Count -eq 0) {
        return $null
    }
    return [string]$installations[0]
}

function Ensure-VisualStudioBuildTools {
    $installation = Get-VisualStudioPath
    if ($installation) {
        Write-Host "Visual Studio C++ Build Tools found at $installation"
        return $installation
    }

    Write-Step "Installing Visual Studio 2022 C++ Build Tools"
    $bootstrapper = Join-Path $env:TEMP "cantrip-vs_BuildTools.exe"
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "https://aka.ms/vs/17/release/vs_BuildTools.exe" -OutFile $bootstrapper
        $installerArguments = @(
            "--quiet",
            "--wait",
            "--norestart",
            "--nocache",
            "--add", "Microsoft.VisualStudio.Workload.VCTools",
            "--includeRecommended"
        )
        $process = Start-Process -FilePath $bootstrapper -ArgumentList $installerArguments -Wait -PassThru
        if (@(0, 3010) -notcontains $process.ExitCode) {
            throw "Visual Studio Build Tools failed with exit code $($process.ExitCode)."
        }
        if ($process.ExitCode -eq 3010) {
            Write-Warning "Visual Studio requested a reboot. The script will keep going; reboot before retrying if compilation fails."
        }
    }
    finally {
        Remove-Item -LiteralPath $bootstrapper -Force -ErrorAction SilentlyContinue
    }

    $installation = Get-VisualStudioPath
    if (!$installation) {
        throw "Visual Studio installed, but the MSVC x64 toolchain could not be found. Reboot Windows and run this script again."
    }
    return $installation
}

function Import-VisualStudioEnvironment {
    param([string]$InstallationPath)

    $vsDevCmd = Join-Path $InstallationPath "Common7\Tools\VsDevCmd.bat"
    if (!(Test-Path -LiteralPath $vsDevCmd)) {
        throw "VsDevCmd.bat is missing from $InstallationPath."
    }

    $nativeArchitecture = if ($env:PROCESSOR_ARCHITEW6432) {
        $env:PROCESSOR_ARCHITEW6432
    }
    else {
        $env:PROCESSOR_ARCHITECTURE
    }
    $hostArchitecture = if ($nativeArchitecture -eq "ARM64") { "arm64" } else { "x64" }
    $command = "call `"$vsDevCmd`" -no_logo -arch=x64 -host_arch=$hostArchitecture >nul && set"
    $environmentLines = @(& $env:ComSpec /d /c $command)
    if ($LASTEXITCODE -ne 0) {
        throw "Visual Studio's developer environment failed to initialize."
    }

    foreach ($line in $environmentLines) {
        if ($line -match "^([^=]+)=(.*)$") {
            Set-Item -Path "Env:$($matches[1])" -Value $matches[2]
        }
    }
    if (!(Test-CommandAvailable "cl.exe")) {
        throw "The Visual Studio environment loaded, but cl.exe is unavailable."
    }
}

function Resolve-Python {
    $python = $null
    if (Test-CommandAvailable "py.exe") {
        $candidate = @(& py.exe -3.13 -c "import sys; print(sys.executable)" 2>$null)
        if ($LASTEXITCODE -eq 0 -and $candidate.Count -gt 0) {
            $python = [string]$candidate[0]
        }
    }
    if (!$python -and (Test-CommandAvailable "python.exe")) {
        $candidate = @(& python.exe -c "import sys; print(sys.executable)" 2>$null)
        if ($LASTEXITCODE -eq 0 -and $candidate.Count -gt 0) {
            $python = [string]$candidate[0]
        }
    }
    if (!$python -or !(Test-Path -LiteralPath $python)) {
        throw "A complete Python installation could not be resolved after installation."
    }
    $env:PYTHON = $python
    return $python
}

function Test-NodeToolchain {
    if (!(Test-CommandAvailable "node.exe")) {
        return $false
    }
    $major = @(& node.exe -p "process.versions.node.split('.')[0]" 2>$null)
    if ($LASTEXITCODE -ne 0 -or $major.Count -eq 0 -or $major[0] -ne "24") {
        return $false
    }
    $architecture = @(& node.exe -p "process.arch" 2>$null)
    return $LASTEXITCODE -eq 0 -and $architecture.Count -gt 0 -and $architecture[0] -eq "x64"
}

function Assert-NodeToolchain {
    $major = @(& node.exe -p "process.versions.node.split('.')[0]" 2>$null)
    if ($LASTEXITCODE -ne 0 -or $major.Count -eq 0 -or $major[0] -ne "24") {
        throw "Cantrip requires Node.js 24, but 'node' resolved to $(& node.exe --version 2>$null). Remove the conflicting Node installation and rerun this script."
    }
    $architecture = @(& node.exe -p "process.arch" 2>$null)
    if ($LASTEXITCODE -ne 0 -or $architecture.Count -eq 0 -or $architecture[0] -ne "x64") {
        throw "The Windows release requires x64 Node.js; this installation reports '$($architecture -join '')'."
    }
}

function Configure-Rust {
    Write-Step "Installing the pinned Rust toolchain"
    Invoke-Native "rustup.exe" @("set", "default-host", "x86_64-pc-windows-msvc")
    Invoke-Native "rustup.exe" @(
        "toolchain", "install", "1.95.0-x86_64-pc-windows-msvc",
        "--profile", "default",
        "--component", "clippy",
        "--component", "rustfmt",
        "--component", "rust-src"
    )
    Invoke-Native "rustup.exe" @("default", "1.95.0-x86_64-pc-windows-msvc")

    $rustDetails = @(Invoke-NativeCapture "rustc.exe" @("-vV"))
    if (($rustDetails -join "`n") -notmatch "host: x86_64-pc-windows-msvc") {
        throw "Rust is not using the x64 MSVC host toolchain.`n$($rustDetails -join [Environment]::NewLine)"
    }
}

function Resolve-RepositoryCommit {
    param([string]$RequestedRef)

    $candidates = @(
        "refs/remotes/origin/$RequestedRef",
        "refs/tags/$RequestedRef",
        $RequestedRef
    )
    foreach ($candidate in $candidates) {
        $commit = @(& git.exe rev-parse --verify --quiet "$candidate^{commit}" 2>$null)
        if ($LASTEXITCODE -eq 0 -and $commit.Count -gt 0) {
            return [string]$commit[0]
        }
    }
    throw "The requested ref '$RequestedRef' was not found after fetching origin."
}

function Prepare-Checkout {
    param(
        [string]$Url,
        [string]$RequestedRef,
        [string]$Directory
    )

    if (![IO.Path]::IsPathRooted($Directory)) {
        throw "CheckoutPath must be an absolute Windows path."
    }
    if (Test-Path -LiteralPath $Directory) {
        if (!(Test-Path -LiteralPath (Join-Path $Directory ".git"))) {
            throw "$Directory already exists and is not a Git checkout. Move it or choose another -CheckoutPath."
        }
    }
    else {
        Write-Step "Cloning Cantrip into $Directory"
        $parent = Split-Path -Parent $Directory
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
        Invoke-Native "git.exe" @("clone", $Url, $Directory)
    }

    Push-Location $Directory
    try {
        $changes = @(& git.exe status --porcelain)
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to inspect the Git checkout at $Directory."
        }
        if ($changes.Count -gt 0) {
            throw "$Directory contains local changes. Commit or move them before rerunning this script."
        }

        $originLines = @(Invoke-NativeCapture "git.exe" @("remote", "get-url", "origin"))
        $origin = [string]$originLines[0]
        $normalizeUrl = {
            param([string]$Value)
            return ($Value.TrimEnd("/") -replace "\.git$", "").ToLowerInvariant()
        }
        if ((& $normalizeUrl $origin) -ne (& $normalizeUrl $Url)) {
            throw "The existing checkout uses origin '$origin', not '$Url'. Choose another -CheckoutPath or pass the matching -RepositoryUrl."
        }

        Invoke-Native "git.exe" @("config", "core.longpaths", "true")
        Invoke-Native "git.exe" @("fetch", "origin", "--tags", "--prune")
        $commit = Resolve-RepositoryCommit $RequestedRef
        Invoke-Native "git.exe" @("checkout", "--detach", $commit)
        Invoke-Native "git.exe" @("submodule", "update", "--init", "--recursive")
        return $commit
    }
    finally {
        Pop-Location
    }
}

function Get-BuildLimits {
    param([int]$RequestedCargoJobs)

    $computer = Get-CimInstance Win32_ComputerSystem
    $memoryBytes = [double]$computer.TotalPhysicalMemory
    $memoryGb = [Math]::Round($memoryBytes / 1GB, 1)
    if ($RequestedCargoJobs -gt 0) {
        $jobs = $RequestedCargoJobs
    }
    else {
        $memoryJobs = [Math]::Max(1, [Math]::Floor($memoryGb / 8))
        $jobs = [Math]::Min(4, [Math]::Min([Environment]::ProcessorCount, $memoryJobs))
    }
    $nodeMemoryMb = [Math]::Min(8192, [Math]::Max(2048, [Math]::Floor(($memoryBytes / 1MB) * 0.5)))
    return @{
        Jobs = [int]$jobs
        MemoryGb = $memoryGb
        NodeMemoryMb = [int]$nodeMemoryMb
    }
}

function Assert-FreeSpace {
    param([string]$Directory)

    if (![IO.Path]::IsPathRooted($Directory)) {
        throw "CheckoutPath must be an absolute Windows path."
    }
    $root = [IO.Path]::GetPathRoot($Directory)
    $drive = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($root.TrimEnd('\'))'"
    if (!$drive) {
        throw "Unable to inspect free space on $root."
    }
    $freeGb = [Math]::Round(([double]$drive.FreeSpace / 1GB), 1)
    Write-Host "$freeGb GB free on $root"
    if ($freeGb -lt 30) {
        throw "Cantrip's first Windows build needs at least 30 GB free."
    }
    if ($freeGb -lt 50) {
        Write-Warning "Less than 50 GB is free. The build should fit, but there is little room for tool and dependency caches."
    }
}

function Install-Prerequisites {
    Ensure-WinGet

    if (!(Test-CommandAvailable "git.exe")) {
        Install-WinGetPackage "Git.Git" "Git for Windows" "x64"
    }
    if (!(Test-NodeToolchain)) {
        Install-WinGetPackage "OpenJS.NodeJS.LTS" "Node.js 24 LTS" "x64"
    }
    $pythonAvailable = $true
    try {
        Resolve-Python | Out-Null
    }
    catch {
        $pythonAvailable = $false
    }
    if (!$pythonAvailable) {
        Install-WinGetPackage "Python.Python.3.13" "Python 3.13" "x64"
    }
    if (!(Test-CommandAvailable "cmake.exe")) {
        Install-WinGetPackage "Kitware.CMake" "CMake" "x64"
    }
    if (!(Test-CommandAvailable "nasm.exe")) {
        Install-WinGetPackage "NASM.NASM" "NASM" "x64"
    }
    if (!(Test-CommandAvailable "rustup.exe")) {
        Install-WinGetPackage "Rustlang.Rustup" "Rustup" "x64"
    }
    if (!(Test-WinGetPackage "Microsoft.EdgeWebView2Runtime")) {
        Install-WinGetPackage "Microsoft.EdgeWebView2Runtime" "Microsoft Edge WebView2 Runtime" "x64"
    }

    Update-ProcessPath
    foreach ($command in @("git.exe", "node.exe", "cmake.exe", "nasm.exe", "rustup.exe")) {
        if (!(Test-CommandAvailable $command)) {
            throw "$command is still unavailable after prerequisite installation. Reboot Windows and run this script again."
        }
    }
}

function Main {
    if ($env:OS -ne "Windows_NT") {
        throw "yeet-windows.ps1 must run on Windows."
    }

    Write-Host "Cantrip Windows build bootstrap" -ForegroundColor Green
    Write-Host "Repository: $RepositoryUrl"
    Write-Host "Ref:        $Ref"
    Write-Host "Checkout:   $CheckoutPath"
    Write-Host "Installer:  $Installer"

    Assert-FreeSpace $CheckoutPath
    Install-Prerequisites
    Assert-NodeToolchain
    $python = Resolve-Python
    $visualStudio = Ensure-VisualStudioBuildTools
    Import-VisualStudioEnvironment $visualStudio
    Configure-Rust

    Write-Step "Installing pnpm 11.15.1"
    Invoke-Native "npm.cmd" @("install", "--global", "pnpm@11.15.1")
    $npmPrefixLines = @(Invoke-NativeCapture "npm.cmd" @("prefix", "--global"))
    $npmPrefix = [string]$npmPrefixLines[0]
    Add-ProcessPath $npmPrefix
    if (!(Test-CommandAvailable "pnpm.cmd")) {
        throw "pnpm.cmd is unavailable after npm installed it."
    }

    Invoke-Native "git.exe" @("config", "--global", "core.longpaths", "true")
    $commit = Prepare-Checkout $RepositoryUrl $Ref $CheckoutPath

    $limits = Get-BuildLimits $CargoJobs
    $env:CARGO_BUILD_JOBS = [string]$limits.Jobs
    $env:CARGO_INCREMENTAL = "0"
    $env:CARGO_NET_RETRY = "10"
    $env:CARGO_HTTP_TIMEOUT = "600"
    $env:NODE_OPTIONS = "--max-old-space-size=$($limits.NodeMemoryMb)"
    $env:npm_config_fetch_retries = "5"
    if ($Installer -eq "all") {
        Remove-Item Env:CANTRIP_WINDOWS_BUNDLE -ErrorAction SilentlyContinue
    }
    else {
        $env:CANTRIP_WINDOWS_BUNDLE = $Installer
    }

    Write-Step "Toolchain summary"
    Write-Host "Commit:      $commit"
    Write-Host "Memory:      $($limits.MemoryGb) GB"
    Write-Host "Cargo jobs:  $($limits.Jobs)"
    Write-Host "Node heap:   $($limits.NodeMemoryMb) MB"
    Write-Host "Python:      $python"
    Invoke-Native "node.exe" @("--version")
    Invoke-Native "pnpm.cmd" @("--version")
    Invoke-Native "rustc.exe" @("--version")
    Invoke-Native "cargo.exe" @("--version")
    Invoke-Native "cmake.exe" @("--version")
    Invoke-Native "nasm.exe" @("-v")
    Write-Host "MSVC:        $((Get-Command cl.exe).Source)"

    Push-Location $CheckoutPath
    try {
        Write-Step "Installing repository dependencies"
        Invoke-Native "pnpm.cmd" @("install", "--frozen-lockfile")

        Write-Step "Verifying patched upstream sources"
        Invoke-Native "pnpm.cmd" @("codex:verify")
        Invoke-Native "pnpm.cmd" @("code:source:verify")

        if (!$SkipChecks) {
            Write-Step "Running Cantrip checks"
            Invoke-Native "pnpm.cmd" @("check")
        }

        Write-Step "Building the complete Windows distribution"
        Invoke-Native "pnpm.cmd" @("bundle")
    }
    finally {
        Pop-Location
    }

    $script:ArtifactDirectory = Join-Path $CheckoutPath "artifacts\bundles\win32-x64"
    if (!(Test-Path -LiteralPath $script:ArtifactDirectory)) {
        throw "The build completed without creating $script:ArtifactDirectory."
    }
    $installers = @(Get-ChildItem $script:ArtifactDirectory -File -Recurse | Where-Object { $_.Extension -in @(".exe", ".msi") })
    if ($installers.Count -eq 0) {
        throw "The build completed without producing a Windows installer."
    }
    $script:BuiltCommit = $commit
}

if ($ElevatedParameters) {
    $forwardedParameters = ConvertFrom-ElevatedParameters $ElevatedParameters
    & $PSCommandPath @forwardedParameters
    exit $LASTEXITCODE
}

if ($env:OS -ne "Windows_NT") {
    throw "yeet-windows.ps1 must run on Windows."
}
if (!(Test-Administrator)) {
    Restart-AsAdministrator $scriptParameters
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$transcriptPath = Join-Path $env:TEMP "cantrip-yeet-$timestamp.log"
$transcriptStarted = $false
$succeeded = $false
$script:ArtifactDirectory = $null
$script:BuiltCommit = $null

try {
    Start-Transcript -Path $transcriptPath -Force | Out-Null
    $transcriptStarted = $true
    Main
    $succeeded = $true
}
catch {
    Write-Host ""
    Write-Host "CANTRIP BUILD FAILED" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    if ($_.ScriptStackTrace) {
        Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
    }
    Write-Host "Full log: $transcriptPath" -ForegroundColor Yellow
}
finally {
    if ($transcriptStarted) {
        Stop-Transcript | Out-Null
    }
}

if (!$succeeded) {
    exit 1
}

$finalLog = Join-Path $script:ArtifactDirectory "cantrip-windows-build-$timestamp.log"
Copy-Item -LiteralPath $transcriptPath -Destination $finalLog -Force

Write-Host ""
Write-Host "CANTRIP WINDOWS BUILD COMPLETE" -ForegroundColor Green
Write-Host "Commit:   $($script:BuiltCommit)"
Write-Host "Artifacts: $($script:ArtifactDirectory)"
Write-Host "Build log: $finalLog"
Write-Host ""
Get-ChildItem $script:ArtifactDirectory -File -Recurse |
    Sort-Object FullName |
    ForEach-Object { Write-Host "  $($_.FullName)" }
exit 0
