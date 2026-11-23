use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_wire::Value;
use ed25519_dalek::{Signature, VerifyingKey};
use reqwest::{Client, Response, redirect::Policy};
use sha2::{Digest, Sha256};
use std::{path::Path, time::Duration};
use tokio::{io::AsyncWriteExt, sync::watch};
use url::Url;

pub(super) const MANIFEST: &str = "https://github.com/ArcaneArts/Cantrip/releases/download/web-runtime-2026.08.22.1/manifest.json";
const MANIFEST_LIMIT: u64 = 2_000_000;

pub(super) struct Source {
    pub client: Client,
    pub manifest: String,
    pub key_id: String,
    pub key: VerifyingKey,
}

impl Source {
    pub fn configured(manifest: String) -> Result<Self> {
        // Raw Ed25519 key from the existing managed-runtime release SPKI.
        let bytes = STANDARD.decode("kFsECgiD1BMe8hwxgYpXgj/fSdVo/xW2aVI4IZiYRCk=")?;
        let key = VerifyingKey::from_bytes(bytes.as_slice().try_into()?)?;
        let client = client()?.build()?;
        Ok(Self {
            client,
            manifest,
            key_id: "cantrip-managed-runtime-2026-01".into(),
            key,
        })
    }

    pub async fn manifest(&self, mut stop: watch::Receiver<bool>) -> Result<Vec<u8>> {
        tokio::select! {
            _ = cancelled(&mut stop) => anyhow::bail!("Managed runtime installation stopped."),
            result = async {
                let mut response = self.fetch(&self.manifest, Duration::from_secs(30), true).await?;
                let mut bytes = Vec::new();
                ensure!(response.content_length().is_none_or(|length| length <= MANIFEST_LIMIT), "Managed runtime manifest exceeds its size limit.");
                while let Some(chunk) = response.chunk().await? {
                    ensure!((bytes.len() + chunk.len()) as u64 <= MANIFEST_LIMIT, "Managed runtime manifest exceeds its size limit.");
                    bytes.extend_from_slice(&chunk);
                }
                Ok(bytes)
            } => result,
        }
    }

    pub fn verify(&self, artifact: &Value) -> Result<()> {
        ensure!(
            artifact["signingKeyId"] == self.key_id.as_str(),
            "Managed runtime signing key is not trusted."
        );
        let signature = STANDARD.decode(
            artifact["signature"]
                .as_str()
                .context("Missing release signature.")?,
        )?;
        let signature = Signature::from_slice(&signature)?;
        self.key
            .verify_strict(signature_payload(artifact).as_bytes(), &signature)
            .context("Managed runtime artifact signature is invalid.")
    }

    pub async fn download(
        &self,
        artifact: &Value,
        path: &Path,
        mut progress: impl FnMut(u64, u64),
        mut stop: watch::Receiver<bool>,
    ) -> Result<[u8; 32]> {
        let total = artifact["compressedBytes"]
            .as_u64()
            .context("Missing artifact size.")?;
        let url = artifact["downloadUrl"]
            .as_str()
            .context("Missing download URL.")?;
        tokio::select! {
            _ = cancelled(&mut stop) => anyhow::bail!("Managed runtime installation stopped."),
            result = async {
                let mut response = self.fetch(url, Duration::from_secs(600), false).await?;
                ensure!(response.content_length().is_none_or(|length| length == total), "Managed runtime response size differs from the signed size.");
                let mut file = tokio::fs::File::from_std(cantrip_host::files::open_private(path)?);
                let mut hash = Sha256::new();
                let mut length = 0;
                let mut reported = 0;
                while let Some(bytes) = response.chunk().await? {
                    length += bytes.len() as u64;
                    ensure!(length <= total, "Managed runtime download exceeded the signed size.");
                    hash.update(&bytes);
                    file.write_all(&bytes).await?;
                    if length - reported >= 1024 * 1024 || length == total {
                        progress(length, total);
                        reported = length;
                    }
                }
                ensure!(length == total, "Managed runtime download ended before the signed size.");
                file.sync_all().await?;
                Ok(hash.finalize().into())
            } => result,
        }
    }

    async fn fetch(&self, url: &str, timeout: Duration, manifest: bool) -> Result<Response> {
        let target = Url::parse(url)?;
        ensure!(
            target.scheme() == "https",
            "Managed runtime release URLs must use HTTPS."
        );
        let mut request = self
            .client
            .get(target)
            .timeout(timeout)
            .header("accept-encoding", "identity");
        if manifest {
            request = request.header("accept", "application/json");
        }
        Ok(request.send().await?.error_for_status()?)
    }
}

pub(super) fn client() -> Result<reqwest::ClientBuilder> {
    Ok(Client::builder()
        .redirect(Policy::custom(|attempt| {
            if attempt.url().scheme() != "https" || attempt.previous().len() >= 10 {
                attempt.error("Managed runtime redirect is outside the HTTPS policy.")
            } else {
                attempt.follow()
            }
        }))
        .connect_timeout(Duration::from_secs(15)))
}

pub(super) fn signature_payload(artifact: &Value) -> String {
    Value::object(
        [
            "schemaVersion",
            "component",
            "version",
            "platform",
            "architecture",
            "archiveFormat",
            "downloadUrl",
            "sha256",
            "signingKeyId",
            "compressedBytes",
            "extractedBytes",
            "licenseManifest",
            "sourceManifest",
            "minimumOs",
            "minimumKernel",
            "minimumLibc",
        ]
        .into_iter()
        .filter_map(|key| artifact.get(key).cloned().map(|value| (key, value))),
    )
    .stringify()
}

pub(super) async fn cancelled(stop: &mut watch::Receiver<bool>) {
    let _ = stop.wait_for(|closed| *closed).await;
}

pub(super) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
