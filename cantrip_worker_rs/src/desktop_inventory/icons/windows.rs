use super::{CACHED_BYTES, normalize_png};
use crate::filesystem::Scope;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::time::Duration;
use tokio::process::Command;

const EXTRACT: &str = r#"
$ErrorActionPreference = 'Stop'
$needle = $env:CANTRIP_ICON_APPLICATION
$process = Get-Process | Where-Object {
    $_.ProcessName -ieq $needle -or $_.ProcessName -ieq ($needle -replace '\.exe$','') -or $_.MainWindowTitle -ieq $needle
} | Select-Object -First 1
if (-not $process -or -not $process.Path) { exit 3 }
Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($process.Path)
if (-not $icon) { exit 4 }
$stream = [System.IO.MemoryStream]::new()
$bitmap = $icon.ToBitmap()
try {
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    [Console]::Write([Convert]::ToBase64String($stream.ToArray()))
} finally {
    $bitmap.Dispose()
    $icon.Dispose()
    $stream.Dispose()
}
"#;

pub(super) async fn extract(application: &str) -> Option<Vec<u8>> {
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", EXTRACT])
        .env("CANTRIP_ICON_APPLICATION", application)
        .env_remove("CANTRIP_WORKER_CREDENTIAL")
        .env_remove("CANTRIP_WORKER_TOKEN")
        .env_remove("CANTRIP_WORKER_ENROLLMENT_CODE");
    let output = Scope::default()
        .capture_configured(command, CACHED_BYTES * 2, Duration::from_secs(8), None)
        .await
        .ok()?;
    if output.code != Some(0) || output.overflow.is_some() || output.timed_out {
        return None;
    }
    let png = STANDARD
        .decode(std::str::from_utf8(&output.stdout).ok()?.trim())
        .ok()?;
    (png.len() <= CACHED_BYTES)
        .then(|| normalize_png(&png))
        .flatten()
}
