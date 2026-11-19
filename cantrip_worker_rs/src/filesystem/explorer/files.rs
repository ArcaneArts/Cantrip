use super::{checked, io_error, markdown, paths};
use crate::filesystem::paths as host;
use anyhow::{Result, bail};
use cantrip_wire::{JsString, Value, value::json};
use sha2::{Digest, Sha256};
use std::{io::SeekFrom, path::Path};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
};
const FILE_SIZE_LIMIT: u64 = 2 * 1024 * 1024;
#[derive(Debug)]
pub struct TextPreviewRequiredError;
impl std::fmt::Display for TextPreviewRequiredError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Open this large file as a read-only text preview.")
    }
}
impl std::error::Error for TextPreviewRequiredError {}
pub(super) fn decode(bytes: &[u8]) -> Result<&str> {
    if bytes.contains(&0) {
        bail!("Binary files cannot be previewed.");
    }
    // Unlike TextDecoder's default, editable documents retain their BOM.
    std::str::from_utf8(bytes)
        .map_err(|_| anyhow::anyhow!("Only UTF-8 text files can be previewed."))
}
fn version(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
pub async fn read_file(root: &Path, relative: &JsString) -> Result<Value> {
    let (metadata, target) = paths::resolve(root, relative).await?;
    if !metadata.is_file() {
        bail!("This file type is not available for preview.");
    }
    if metadata.len() > 10 * 1024 * 1024 {
        bail!("Text previews are limited to 10 MB.");
    }
    if metadata.len() > FILE_SIZE_LIMIT {
        return Err(TextPreviewRequiredError.into());
    }
    let bytes = fs::read(&target)
        .await
        .map_err(|e| io_error("open", &target, e))?;
    if bytes.len() as u64 > FILE_SIZE_LIMIT {
        return Err(TextPreviewRequiredError.into());
    }
    checked(
        "explorerFileSchema",
        &json!({"path":relative,"content":decode(&bytes)?,"size":metadata.len(),"markdown":markdown(&host::text(&target)),"version":version(&bytes)}),
    )
}
pub async fn write_file(
    root: &Path,
    relative: &JsString,
    content: &JsString,
    expected_version: &str,
) -> Result<Value> {
    let text = content.lossy(); // TextEncoder replaces unpaired UTF-16 units.
    let bytes = text.as_bytes();
    if bytes.len() as u64 > FILE_SIZE_LIMIT {
        bail!("Text files are limited to 2 MB.");
    }
    decode(bytes)?;
    let (_, target) = paths::resolve(root, relative).await?;
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let mut file = options
        .open(&target)
        .await
        .map_err(|e| io_error("open", &target, e))?;
    let metadata = file.metadata().await?;
    if !metadata.is_file() {
        bail!("This file type is not available for editing.");
    }
    if metadata.len() > FILE_SIZE_LIMIT {
        bail!("Text files are limited to 2 MB.");
    }
    let mut original = vec![0; metadata.len() as usize];
    let mut offset = 0;
    while offset < original.len() {
        let count = file.read(&mut original[offset..]).await?;
        if count == 0 {
            break;
        }
        offset += count;
    }
    if offset != original.len()
        || file.metadata().await?.len() != metadata.len()
        || version(&original) != expected_version
    {
        bail!("This file changed on disk. Reload it before saving your edits.");
    }
    decode(&original)?;
    // The accepting runtime must join this future, including on disconnect.
    // Never add cancellation between truncation, publication and sync.
    file.set_len(0).await?;
    file.seek(SeekFrom::Start(0)).await?;
    file.write_all(bytes).await?;
    file.sync_all().await?;
    drop(file);
    read_file(root, relative).await
}
