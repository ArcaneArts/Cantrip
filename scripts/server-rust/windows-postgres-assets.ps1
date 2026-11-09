param([Parameter(Mandatory = $true)][string]$CacheDirectory)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$cache = [IO.Path]::GetFullPath($CacheDirectory)
$pgConfig = Join-Path $cache "pgsql\bin\pg_config.exe"
# Try the actual cached tool. A missing or broken cache is replaced by an
# extracted build dependency; no database service or machine install is created.
try {
    $bin = & $pgConfig --bindir
    if ($LASTEXITCODE -eq 0) { Write-Output $bin; exit 0 }
} catch { }
$parent = Split-Path -Parent $cache
New-Item -ItemType Directory -Path $parent -Force | Out-Null
$stage = Join-Path $parent ("postgres-stage-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    $zip = Join-Path $stage "postgres.zip"
    Invoke-WebRequest -UseBasicParsing -Uri "https://get.enterprisedb.com/postgresql/postgresql-18.6-1-windows-x64-binaries.zip" -OutFile $zip
    # pgAdmin includes Python paths beyond PowerShell 5's path limit and is not
    # part of the server distribution. Extract only the runtime and its notices.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName
            if ($name -notmatch '^pgsql/(bin|lib|share)/' -and $name -notmatch '^pgsql/(LICENSE|LICENCE|COPYING|COPYRIGHT)([./-]|$)') { continue }
            $destination = [IO.Path]::GetFullPath((Join-Path $stage $name.Replace('/', '\')))
            if (-not $destination.StartsWith($stage + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Invalid PostgreSQL archive path." }
            if ($name.EndsWith('/')) {
                [IO.Directory]::CreateDirectory($destination) | Out-Null
            } else {
                [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
                [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)
            }
        }
    } finally {
        $archive.Dispose()
    }
    # This directory contains only this script's extracted build assets.
    Remove-Item -LiteralPath $cache -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $cache | Out-Null
    Move-Item -LiteralPath (Join-Path $stage "pgsql") -Destination $cache
    & $pgConfig --bindir
    if ($LASTEXITCODE -ne 0) { throw "The extracted PostgreSQL build tool failed." }
} finally {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
