use anyhow::{Context, Result, ensure};
use cantrip_wire::{Value, parse_json_text};
use pgp::{
    composed::{Deserializable, DetachedSignature, SignedPublicKey},
    types::KeyDetails,
};
use reqwest::{Client, Response, redirect::Policy};
use sha2::{Digest, Sha256};
use std::{fmt, path::Path, time::Duration};
use tokio::io::AsyncWriteExt;
use url::Url;

const RELEASES: &str = "https://downloads.claude.ai/claude-code-releases/";
const SIGNER: &str = "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE";
const RELEASE_KEY: &[u8] = include_bytes!("release-key.asc");
const METADATA_LIMIT: usize = 64 * 1024;
pub(super) const BINARY_LIMIT: u64 = 768 * 1024 * 1024;
pub(super) const BINARY: &str = if cfg!(windows) {
    "claude.exe"
} else {
    "claude"
};

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(super) struct Version([u32; 3]);

impl Version {
    pub fn parse(text: &str) -> Result<Self> {
        let parts = text
            .split('.')
            .map(str::parse)
            .collect::<Result<Vec<u32>, _>>()?;
        let version = Self(
            parts
                .try_into()
                .ok()
                .context("Invalid Claude Code release version.")?,
        );
        ensure!(
            version.to_string() == text,
            "Invalid Claude Code release version."
        );
        Ok(version)
    }
}

impl fmt::Display for Version {
    fn fmt(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        let [major, minor, patch] = self.0;
        write!(output, "{major}.{minor}.{patch}")
    }
}

#[derive(Clone, Debug)]
pub(super) struct Release {
    pub version: Version,
    pub checksum: String,
    pub size: u64,
    url: Url,
}

pub(super) fn is_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(super) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(super) fn target() -> Result<&'static str> {
    let target = match (
        std::env::consts::OS,
        std::env::consts::ARCH,
        cfg!(target_env = "musl"),
    ) {
        ("macos", "aarch64", _) => "darwin-arm64",
        ("macos", "x86_64", _) => "darwin-x64",
        ("windows", "aarch64", _) => "win32-arm64",
        ("windows", "x86_64", _) => "win32-x64",
        ("linux", "aarch64", false) => "linux-arm64",
        ("linux", "x86_64", false) => "linux-x64",
        ("linux", "aarch64", true) => "linux-arm64-musl",
        ("linux", "x86_64", true) => "linux-x64-musl",
        _ => {
            anyhow::bail!("Claude Code does not publish a native binary for this worker platform.")
        }
    };
    Ok(target)
}

pub(super) struct Source {
    origin: Url,
    client: Client,
    #[cfg(test)]
    verify: fn(&[u8], &[u8]) -> Result<()>,
}

impl Source {
    pub fn official() -> Result<Self> {
        Ok(Self {
            origin: Url::parse(RELEASES)?,
            client: Client::builder()
                .https_only(true)
                .redirect(Policy::none())
                .connect_timeout(Duration::from_secs(15))
                .build()?,
            #[cfg(test)]
            verify: verify_manifest,
        })
    }

    #[cfg(test)]
    pub fn fixture(origin: Url, verify: fn(&[u8], &[u8]) -> Result<()>) -> Self {
        Self {
            origin,
            client: Client::builder()
                .no_proxy()
                .redirect(Policy::none())
                .build()
                .unwrap(),
            verify,
        }
    }

    pub async fn latest(&self) -> Result<Version> {
        let bytes = self.metadata(self.origin.join("latest")?).await?;
        Version::parse(std::str::from_utf8(&bytes)?.trim())
    }

    pub async fn release(&self, version: Version) -> Result<Release> {
        let target = target()?;
        let manifest = self.origin.join(&format!("{version}/manifest.json"))?;
        let signature = self.origin.join(&format!("{version}/manifest.json.sig"))?;
        let (bytes, signature) =
            tokio::try_join!(self.metadata(manifest), self.metadata(signature))?;
        #[cfg(not(test))]
        verify_manifest(&bytes, &signature)?;
        #[cfg(test)]
        (self.verify)(&bytes, &signature)?;
        read_manifest(&self.origin, &bytes, version, target)
    }

    async fn metadata(&self, url: Url) -> Result<Vec<u8>> {
        let mut response = self.fetch(url, Duration::from_secs(20)).await?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            ensure!(
                bytes.len() + chunk.len() <= METADATA_LIMIT,
                "Claude Code release metadata is too large."
            );
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    pub async fn download(&self, release: &Release, path: &Path) -> Result<()> {
        let mut response = self
            .fetch(release.url.clone(), Duration::from_secs(240))
            .await?;
        let file = cantrip_host::files::open_private(path)?;
        let mut file = tokio::fs::File::from_std(file);
        let mut length = 0;
        let mut digest = Sha256::new();
        while let Some(chunk) = response.chunk().await? {
            length += chunk.len() as u64;
            ensure!(
                length <= release.size,
                "Claude Code download exceeds its signed size."
            );
            digest.update(&chunk);
            file.write_all(&chunk).await?;
        }
        ensure!(
            length == release.size,
            "Claude Code download ended before its signed size."
        );
        ensure!(
            hex(&digest.finalize()) == release.checksum,
            "Claude Code binary checksum is invalid."
        );
        file.flush().await?;
        file.sync_all().await?;
        Ok(())
    }

    async fn fetch(&self, url: Url, timeout: Duration) -> Result<Response> {
        let response = self
            .client
            .get(url)
            .timeout(timeout)
            .header("accept-encoding", "identity")
            .send()
            .await
            .context("Could not fetch the official Claude Code release.")?;
        ensure!(
            response.status().is_success(),
            "Claude Code release returned HTTP {}.",
            response.status()
        );
        Ok(response)
    }
}

pub(super) fn verify_manifest(bytes: &[u8], signature: &[u8]) -> Result<()> {
    let (key, _) = SignedPublicKey::from_armor_single(RELEASE_KEY)?;
    ensure!(
        format!("{:X}", key.fingerprint()) == SIGNER,
        "Claude Code release signing key is invalid."
    );
    let (signature, _) = DetachedSignature::from_reader_single(signature)?;
    ensure!(
        signature.signature.typ() == Some(pgp::packet::SignatureType::Binary),
        "Claude Code release manifest requires a binary data signature."
    );
    signature
        .verify(&key, bytes)
        .context("Claude Code release manifest signature is invalid.")
}

pub(super) fn read_manifest(
    origin: &Url,
    bytes: &[u8],
    version: Version,
    target: &str,
) -> Result<Release> {
    let manifest: Value = parse_json_text(std::str::from_utf8(bytes)?)
        .map_err(|_| anyhow::anyhow!("Invalid Claude Code release manifest."))?;
    ensure!(
        manifest["version"] == version.to_string().as_str(),
        "Claude Code manifest version mismatches the channel."
    );
    let platform = &manifest["platforms"][target];
    let name = if target.starts_with("win32-") {
        "claude.exe"
    } else {
        "claude"
    };
    ensure!(
        platform["binary"] == name,
        "Claude Code manifest has no binary for {target}."
    );
    let checksum = platform["checksum"]
        .as_str()
        .filter(|checksum| is_digest(checksum))
        .context("Claude Code manifest contains an invalid platform checksum.")?;
    let size = platform["size"]
        .as_u64()
        .filter(|size| (1..=BINARY_LIMIT).contains(size))
        .context("Claude Code manifest contains an invalid platform binary size.")?;
    Ok(Release {
        version,
        size,
        checksum: checksum.to_owned(),
        url: origin.join(&format!("{version}/{target}/{name}"))?,
    })
}
