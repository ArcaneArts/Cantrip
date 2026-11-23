//! Preserve the version-one Cantrip OS system JSONL format.
use super::super::{
    archive_io::{hexadecimal, line, prepare, publish, write},
    docker::ImageExport,
    operations::sha256,
};
use super::{account, checked, key};
use crate::{encryption::Service, filesystem::Scope};
use anyhow::{Context, Result, ensure};
use cantrip_crypto::{
    Zeroizing,
    content::{SystemCipher, SystemFrame},
    decryption_error,
};
use cantrip_wire::{Value, parse_json_text, value::json};
use sha2::{Digest, Sha256};
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufReader, BufWriter};
use uuid::Uuid;

const FORMAT: &str = "CantripOS-private-system";
const MAX_LINE: usize = (SystemFrame::METADATA_BYTES + 16).div_ceil(3) * 4 + 65_536;

pub(super) struct Archive<'a> {
    pub file: &'a Path,
    pub context: &'a Value,
    pub encryption: &'a Service,
    pub lifetime: &'a Scope,
}

#[derive(Debug)]
pub(super) struct StagingChanged;

impl std::fmt::Display for StagingChanged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The staged system archive bytes do not match their authenticated receipt.")
    }
}

impl std::error::Error for StagingChanged {}

pub(super) async fn verified_plaintext(
    path: &Path,
    expected_bytes: u64,
    expected_sha: &str,
    lifetime: &Scope,
) -> Result<tokio::fs::File> {
    let mut file = tokio::fs::File::open(path).await?;
    let mut digest = Sha256::new();
    let mut count = 0;
    let mut buffer = Zeroizing::new(vec![0; 64 * 1024]);
    loop {
        lifetime.check()?;
        let size = file.read(&mut buffer).await?;
        if size == 0 {
            break;
        }
        count += size as u64;
        ensure!(count <= expected_bytes, StagingChanged);
        digest.update(&buffer[..size]);
    }
    ensure!(
        count == expected_bytes && hexadecimal(digest) == expected_sha,
        StagingChanged
    );
    file.rewind().await?;
    Ok(file)
}

fn plaintext(schema: &str, bytes: &[u8]) -> Result<Value> {
    let text = std::str::from_utf8(bytes)?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    checked(
        schema,
        parse_json_text(text).map_err(|_| decryption_error())?,
    )
}

fn checked_manifest(context: &Value, manifest: Value) -> Result<Value> {
    let manifest = checked("cantripOsSystemManifestSchema", manifest)?;
    let snapshot = &manifest["snapshot"];
    ensure!(
        snapshot["instanceId"] == context["instanceId"]
            && snapshot["sourceContainerId"] == context["containerId"],
        "The system manifest belongs to a different original instance."
    );
    Ok(manifest)
}

impl Archive<'_> {
    fn active(&self) -> Result<()> {
        self.lifetime.check()?;
        account(self.context, self.encryption)
    }

    pub async fn seal(
        &self,
        manifest: &Value,
        mut stream: ImageExport,
        root: &Path,
    ) -> Result<Value> {
        let manifest = checked_manifest(self.context, manifest.clone())?;
        let material = key(self.context, self.encryption, None)?;
        let revision = material.key_revision;
        let stream_id = json!(Uuid::new_v4().to_string());
        let cipher = SystemCipher::new(self.context, &stream_id, revision, &material.key)?;
        let pending = prepare(self.file)?;
        let mut writer = BufWriter::new(tokio::fs::File::from_std(pending.reopen()?));
        let manifest_bytes = Zeroizing::new(manifest.stringify().into_bytes());
        let manifest_digest = sha256(&manifest_bytes);
        let frame = cipher.seal(SystemFrame::Manifest, 0, &manifest_bytes)?;
        drop(manifest_bytes);
        self.active()?;
        write(
            &mut writer,
            &json!({"format":FORMAT,"version":1,"checkpointId":self.context["checkpointId"],
            "streamId":stream_id,"keyRevision":revision,"manifest":frame}),
        )
        .await?;

        let mut buffer = Zeroizing::new(Vec::with_capacity(SystemFrame::CHUNK_BYTES));
        let mut hash = Sha256::new();
        let mut chunks = 0;
        let mut size = 0;
        while let Some(mut bytes) = stream.next(self.lifetime).await? {
            self.active()?;
            size += bytes.len() as u64;
            ensure!(size <= (1 << 53) - 1, "System archive is too large.");
            hash.update(&bytes);
            while !bytes.is_empty() {
                let used = bytes.len().min(SystemFrame::CHUNK_BYTES - buffer.len());
                buffer.extend_from_slice(&bytes.split_to(used));
                if buffer.len() == SystemFrame::CHUNK_BYTES {
                    write(
                        &mut writer,
                        &cipher.seal(SystemFrame::Chunk, chunks, &buffer)?,
                    )
                    .await?;
                    chunks += 1;
                    buffer.clear();
                }
            }
        }
        if !buffer.is_empty() {
            write(
                &mut writer,
                &cipher.seal(SystemFrame::Chunk, chunks, &buffer)?,
            )
            .await?;
            chunks += 1;
        }
        let mut end = checked(
            "cantripOsSystemEndSchema",
            json!({"archiveBytes":size,
            "archiveSha256":hexadecimal(hash),"manifestSha256":manifest_digest,"chunks":chunks}),
        )?;
        let footer = Zeroizing::new(end.stringify().into_bytes());
        write(
            &mut writer,
            &cipher.seal(SystemFrame::End, chunks, &footer)?,
        )
        .await?;
        writer.flush().await?;
        writer.get_ref().sync_all().await?;
        drop(writer);
        self.active()?;
        publish(pending, self.file, root)?;
        end["keyRevision"] = json!(revision);
        end["streamId"] = stream_id;
        checked("cantripOsSystemArchiveReceiptSchema", end)
    }

    pub async fn verify(&self) -> Result<(Value, Value)> {
        self.consume(None).await
    }

    pub async fn stage(
        &self,
        destination: &Path,
        root: &Path,
        manifest: &Value,
        receipt: &Value,
    ) -> Result<()> {
        let pending = prepare(destination)?;
        let mut output = BufWriter::new(tokio::fs::File::from_std(pending.reopen()?));
        let (actual, proof) = self.consume(Some(&mut output)).await?;
        ensure!(
            &actual == manifest && &proof == receipt,
            "The original system archive proof changed."
        );
        output.flush().await?;
        output.get_ref().sync_all().await?;
        drop(output);
        self.active()?;
        publish(pending, destination, root)
    }

    async fn consume(
        &self,
        mut output: Option<&mut BufWriter<tokio::fs::File>>,
    ) -> Result<(Value, Value)> {
        self.active()?;
        let mut reader = BufReader::new(tokio::fs::File::open(self.file).await?);
        let header = checked(
            "cantripOsSystemFileHeaderSchema",
            line(&mut reader, MAX_LINE)
                .await?
                .ok_or_else(decryption_error)?,
        )?;
        ensure!(
            header["checkpointId"] == self.context["checkpointId"],
            decryption_error()
        );
        let revision = header["keyRevision"]
            .as_u64()
            .context("System archive key revision")?;
        let stream = &header["streamId"];
        let material = key(self.context, self.encryption, Some(revision))?;
        let cipher = SystemCipher::new(self.context, stream, revision, &material.key)?;
        let bytes = cipher.open(SystemFrame::Manifest, 0, &header["manifest"])?;
        let manifest = checked_manifest(
            self.context,
            plaintext("cantripOsSystemManifestSchema", &bytes)?,
        )?;
        let manifest_digest = sha256(&bytes);
        drop(bytes);
        let mut hash = Sha256::new();
        let mut chunks = 0;
        let mut size = 0;
        loop {
            self.active()?;
            let frame = line(&mut reader, MAX_LINE)
                .await?
                .ok_or_else(decryption_error)?;
            if frame["kind"] == "end" {
                let bytes = cipher.open(SystemFrame::End, chunks, &frame)?;
                let mut end = plaintext("cantripOsSystemEndSchema", &bytes)?;
                ensure!(
                    end["archiveBytes"].as_u64() == Some(size)
                        && end["chunks"].as_u64() == Some(chunks)
                        && end["archiveSha256"] == hexadecimal(hash)
                        && end["manifestSha256"] == manifest_digest
                        && line(&mut reader, MAX_LINE).await?.is_none(),
                    decryption_error()
                );
                self.active()?;
                end["keyRevision"] = json!(revision);
                end["streamId"] = stream.clone();
                return Ok((
                    manifest,
                    checked("cantripOsSystemArchiveReceiptSchema", end)?,
                ));
            }
            let bytes = cipher.open(SystemFrame::Chunk, chunks, &frame)?;
            ensure!(!bytes.is_empty(), decryption_error());
            size += bytes.len() as u64;
            ensure!(size <= (1 << 53) - 1, decryption_error());
            hash.update(&*bytes);
            if let Some(writer) = &mut output {
                writer.write_all(&bytes).await?;
            }
            chunks += 1;
        }
    }
}
