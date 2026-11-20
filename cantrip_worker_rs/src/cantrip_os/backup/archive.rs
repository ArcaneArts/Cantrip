//! Read and write the legacy version-one encrypted JSONL archive.
use crate::cantrip_os::checked;
use crate::filesystem::Scope;
use anyhow::{Context, Result, ensure};
use cantrip_crypto::{
    Zeroizing,
    content::{BackupCipher, BackupFrame},
    decryption_error,
};
use cantrip_wire::{Value, parse_json_text, value::json};
use sha2::{Digest, Sha256};
use std::{fs::File, path::Path};
use tempfile::NamedTempFile;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader, BufWriter};

const FORMAT: &str = "CantripOS-private-backup";
const MAX_LINE: usize = (BackupFrame::METADATA_BYTES + 16).div_ceil(3) * 4 + 4096;

pub(super) fn prepare(destination: &Path) -> Result<NamedTempFile> {
    let directory = destination.parent().context("Backup directory")?;
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
        let directory = destination.parent().context("Backup directory")?;
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

pub(super) async fn seal(
    archive: &mut (impl AsyncRead + Unpin),
    destination: &Path,
    context: &Value,
    revision: u64,
    key: &[u8],
    metadata: &Value,
) -> Result<NamedTempFile> {
    let cipher = BackupCipher::new(context, revision, key)?;
    let metadata = checked("cantripOsBackupArchiveMetadataSchema", metadata.clone())?;
    let expected = metadata["archiveBytes"]
        .as_u64()
        .context("Captured archive size")?;
    let pending = prepare(destination)?;
    let mut writer = BufWriter::new(tokio::fs::File::from_std(pending.reopen()?));
    let plaintext = Zeroizing::new(metadata.stringify().into_bytes());
    let frame = cipher.seal(BackupFrame::Metadata, 0, &plaintext)?;
    drop(plaintext);
    let header = json!({"format":FORMAT,"version":1,"backupId":context["backupId"],
        "keyRevision":revision,"metadata":frame});
    write(&mut writer, &header).await?;

    let mut buffer = Zeroizing::new(vec![0; BackupFrame::CHUNK_BYTES]);
    let mut archive_hash = Sha256::new();
    let mut count = 0;
    let mut size = 0;
    loop {
        let mut received = 0;
        while received < buffer.len() {
            let n = archive.read(&mut buffer[received..]).await?;
            if n == 0 {
                break;
            }
            received += n;
        }
        if received == 0 {
            break;
        }
        size += received as u64;
        ensure!(
            size <= expected,
            "The guest archive exceeds its captured size."
        );
        let bytes = &buffer[..received];
        archive_hash.update(bytes);
        write(&mut writer, &cipher.seal(BackupFrame::Chunk, count, bytes)?).await?;
        count += 1;
    }
    let sha = hexadecimal(archive_hash);
    ensure!(
        size == expected && metadata["archiveSha256"] == sha,
        "The guest archive differs from its captured receipt."
    );
    let footer = Zeroizing::new(
        json!({"archiveBytes":size,"archiveSha256":sha,"chunks":count})
            .stringify()
            .into_bytes(),
    );
    write(&mut writer, &cipher.seal(BackupFrame::End, count, &footer)?).await?;
    writer.flush().await?;
    writer.get_ref().sync_all().await?;
    Ok(pending)
}

async fn write(writer: &mut BufWriter<tokio::fs::File>, value: &Value) -> Result<()> {
    writer.write_all(value.stringify().as_bytes()).await?;
    writer.write_all(b"\n").await?;
    Ok(())
}

/// A reopened archive is usable only after every frame and the end record
/// authenticate. Missing files are distinguished from corrupted files.
pub(super) async fn verify(
    source: &Path,
    context: &Value,
    key_for: impl FnOnce(u64) -> Result<Zeroizing<Vec<u8>>>,
    scope: &Scope,
) -> Result<Value> {
    let mut reader = BufReader::new(tokio::fs::File::open(source).await?);
    let header = checked(
        "cantripOsBackupFileHeaderSchema",
        line(&mut reader).await?.ok_or_else(decryption_error)?,
    )?;
    ensure!(
        header["backupId"] == context["backupId"],
        decryption_error()
    );
    let revision = header["keyRevision"]
        .as_u64()
        .ok_or_else(decryption_error)?;
    let key = key_for(revision)?;
    let cipher = BackupCipher::new(context, revision, &key)?;
    let metadata = parse(
        "cantripOsBackupArchiveMetadataSchema",
        &cipher.open(BackupFrame::Metadata, 0, &header["metadata"])?,
    )?;
    let expected = metadata["archiveBytes"]
        .as_u64()
        .ok_or_else(decryption_error)?;
    let mut archive_hash = Sha256::new();
    let mut count = 0;
    let mut size = 0;
    loop {
        scope.check()?;
        let frame = line(&mut reader).await?.ok_or_else(decryption_error)?;
        if frame["kind"] == "end" {
            let end = parse(
                "cantripOsBackupEndSchema",
                &cipher.open(BackupFrame::End, count, &frame)?,
            )?;
            ensure!(
                end["chunks"].as_u64() == Some(count)
                    && end["archiveBytes"].as_u64() == Some(size)
                    && size == expected
                    && end["archiveSha256"] == metadata["archiveSha256"]
                    && metadata["archiveSha256"] == hexadecimal(archive_hash)
                    && line(&mut reader).await?.is_none(),
                decryption_error()
            );
            return Ok(metadata);
        }
        let bytes = cipher.open(BackupFrame::Chunk, count, &frame)?;
        ensure!(!bytes.is_empty(), decryption_error());
        size += bytes.len() as u64;
        ensure!(size <= expected, decryption_error());
        archive_hash.update(&*bytes);
        count += 1;
    }
}

async fn line(reader: &mut BufReader<tokio::fs::File>) -> Result<Option<Value>> {
    let mut bytes = Vec::new();
    if reader
        .take(MAX_LINE as u64 + 1)
        .read_until(b'\n', &mut bytes)
        .await?
        == 0
    {
        return Ok(None);
    }
    ensure!(
        bytes.len() <= MAX_LINE && bytes.pop() == Some(b'\n'),
        decryption_error()
    );
    Ok(Some(
        parse_json_text(std::str::from_utf8(&bytes)?).map_err(|_| decryption_error())?,
    ))
}

fn parse(schema: &str, bytes: &[u8]) -> Result<Value> {
    let value = parse_json_text(std::str::from_utf8(bytes)?).map_err(|_| decryption_error())?;
    checked(schema, value)
}

fn hexadecimal(hash: Sha256) -> String {
    hash.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn published_archive_requires_the_authenticated_end_frame() -> Result<()> {
        let root = tempfile::tempdir()?;
        let path = root.path().join("archive.ctos");
        let context = json!({
            "ownerId":"owner","serverId":"server-雪",
            "backupId":"c01a9a0e-8155-4b3a-8809-b83dc50d3df2",
        });
        let key = vec![41; 32];
        let plaintext = vec![77; BackupFrame::CHUNK_BYTES + 37];
        let mut hash = Sha256::new();
        hash.update(&plaintext);
        let metadata = json!({
            "version":1,"archiveBytes":plaintext.len(),"archiveSha256":hexadecimal(hash),
            "manifest":json!({"label":"private"}),
        });
        let pending = seal(
            &mut plaintext.as_slice(),
            &path,
            &context,
            1,
            &key,
            &metadata,
        )
        .await?;
        publish(pending, &path, root.path())?;
        let scope = Scope::default();
        let key_for = |revision| {
            assert_eq!(revision, 1);
            Ok(Zeroizing::new(key.clone()))
        };
        assert_eq!(verify(&path, &context, key_for, &scope).await?, metadata);
        let mut bytes = tokio::fs::read(&path).await?;
        let before_end = bytes[..bytes.len() - 1]
            .iter()
            .rposition(|byte| *byte == b'\n')
            .unwrap();
        bytes.truncate(before_end + 1);
        tokio::fs::write(&path, bytes).await?;
        assert!(verify(&path, &context, key_for, &scope).await.is_err());
        Ok(())
    }
}
