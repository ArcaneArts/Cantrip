//! Private publication and bounded JSONL I/O shared by Cantrip OS archives.
use anyhow::{Context, Result, ensure};
use cantrip_crypto::decryption_error;
use cantrip_wire::{Value, parse_json_text};
use sha2::{Digest, Sha256};
use std::{fs::File, path::Path};
use tempfile::NamedTempFile;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, BufWriter};

pub(super) fn prepare(destination: &Path) -> Result<NamedTempFile> {
    let directory = destination.parent().context("Archive directory")?;
    cantrip_host::files::private_directory(directory)?;
    cantrip_host::files::secure_directory(directory)?;
    Ok(NamedTempFile::new_in(directory)?)
}

pub(super) fn publish(pending: NamedTempFile, destination: &Path, root: &Path) -> Result<()> {
    pending
        .persist_noclobber(destination)
        .map_err(|error| error.error)?;
    #[cfg(unix)]
    {
        let directory = destination.parent().context("Archive directory")?;
        for parent in directory.ancestors() {
            File::open(parent)?.sync_all()?;
            if parent == root {
                break;
            }
        }
    }
    #[cfg(not(unix))]
    let _ = root;
    Ok(())
}

pub(super) async fn write(writer: &mut BufWriter<tokio::fs::File>, value: &Value) -> Result<()> {
    writer.write_all(value.stringify().as_bytes()).await?;
    writer.write_all(b"\n").await?;
    Ok(())
}

pub(super) async fn line(
    reader: &mut BufReader<tokio::fs::File>,
    max_line: usize,
) -> Result<Option<Value>> {
    let mut bytes = Vec::new();
    if reader
        .take(max_line as u64 + 1)
        .read_until(b'\n', &mut bytes)
        .await?
        == 0
    {
        return Ok(None);
    }
    ensure!(
        bytes.len() <= max_line && bytes.pop() == Some(b'\n'),
        decryption_error()
    );
    Ok(Some(
        parse_json_text(std::str::from_utf8(&bytes)?).map_err(|_| decryption_error())?,
    ))
}

pub(super) fn hexadecimal(hash: Sha256) -> String {
    hash.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
