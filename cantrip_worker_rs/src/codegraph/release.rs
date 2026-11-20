//! Discover the upstream release and verify both GitHub asset digests.
use super::runtime::{is_digest, version};
use super::storage::{read_document, write_document};
use crate::filesystem::Scope;
use anyhow::{Context, Result, ensure};
use cantrip_wire::{Value, parse_json_text, value::json};
use reqwest::{
    Client, StatusCode,
    header::{self, HeaderValue},
    redirect::Policy,
};
use sha2::{Digest, Sha256};
use std::{path::Path, time::Duration};
use tokio::io::AsyncWriteExt;
use url::Url;

const API: &str = "https://api.github.com/repos/colbymchenry/codegraph/releases/latest";
const DOWNLOADS: &str = "https://github.com/colbymchenry/codegraph/releases/download/";
const USER_AGENT: &str = "Cantrip-Worker-CodeGraph-Manager";
const RELEASE_LIMIT: usize = 2_000_000;
const ARCHIVE_LIMIT: u64 = 256_000_000;
const CHECKSUM_LIMIT: u64 = 1_000_000;
const TIMEOUT: Duration = Duration::from_secs(180);

pub(super) struct Target {
    pub asset: String,
    pub format: &'static str,
    pub executable: &'static str,
}

impl Target {
    pub(super) fn host() -> Option<Self> {
        let platform = match std::env::consts::OS {
            "macos" => "darwin",
            "linux" => "linux",
            "windows" => "win32",
            _ => return None,
        };
        let architecture = match std::env::consts::ARCH {
            "aarch64" => "arm64",
            "x86_64" => "x64",
            _ => return None,
        };
        let (format, executable) = if platform == "win32" {
            ("zip", "codegraph.cmd")
        } else {
            ("tar.gz", "codegraph")
        };
        Some(Self {
            asset: format!("codegraph-{platform}-{architecture}.{format}"),
            format,
            executable,
        })
    }
}

pub(super) struct Asset {
    pub name: String,
    pub digest: String,
    url: Url,
    size: u64,
}

impl Asset {
    fn wire(&self) -> Value {
        json!({"name":self.name,"url":self.url.as_str(),"digest":self.digest,"size":self.size})
    }
}

pub(super) struct Release {
    tag: String,
    pub version: String,
    pub archive: Asset,
    pub checksums: Asset,
}

impl Release {
    fn wire(&self) -> Value {
        json!({"tag":self.tag,"version":self.version,
            "asset":self.archive.wire(),"checksums":self.checksums.wire()})
    }
}

pub(super) struct Source {
    client: Client,
    api: Url,
    downloads: Url,
}

impl Source {
    pub(super) fn github() -> Result<Self> {
        let client = Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(15))
            .no_gzip()
            .no_deflate()
            .no_brotli()
            .redirect(Policy::custom(|attempt| {
                let url = attempt.url();
                let allowed = match url.host_str() {
                    Some("github.com") => url.as_str().starts_with(DOWNLOADS),
                    Some(
                        "release-assets.githubusercontent.com" | "objects.githubusercontent.com",
                    ) => true,
                    _ => false,
                };
                if url.scheme() == "https" && allowed && attempt.previous().len() < 10 {
                    attempt.follow()
                } else {
                    attempt
                        .error("CodeGraph release redirect is outside the upstream release hosts.")
                }
            }))
            .build()?;
        Ok(Self {
            client,
            api: Url::parse(API)?,
            downloads: Url::parse(DOWNLOADS)?,
        })
    }

    #[cfg(all(test, unix))]
    pub(super) fn fixture(origin: &Url) -> Self {
        Self {
            client: Client::builder()
                .no_proxy()
                .redirect(Policy::none())
                .build()
                .unwrap(),
            api: origin.join("latest").unwrap(),
            downloads: origin.join("download/").unwrap(),
        }
    }

    fn asset(
        &self,
        value: &Value,
        tag: &str,
        name: &str,
        maximum: u64,
        cached: bool,
    ) -> Result<Asset> {
        let url = value[if cached {
            "url"
        } else {
            "browser_download_url"
        }]
        .as_str()
        .context("CodeGraph release asset is missing its download URL.")?;
        let expected = self.downloads.join(&format!("{tag}/{name}"))?;
        ensure!(
            url == expected.as_str() && value["name"] == name,
            "CodeGraph release asset is outside its upstream release."
        );
        let digest = value["digest"]
            .as_str()
            .and_then(|value| {
                if cached {
                    Some(value)
                } else {
                    value.strip_prefix("sha256:")
                }
            })
            .filter(|digest| is_digest(digest))
            .context("CodeGraph release asset is missing its GitHub SHA-256 digest.")?;
        let size = value["size"]
            .as_u64()
            .filter(|size| (1..=maximum).contains(size))
            .context("CodeGraph release asset exceeds its download limits or has no size.")?;
        Ok(Asset {
            name: name.into(),
            digest: digest.into(),
            url: expected,
            size,
        })
    }

    fn release(&self, value: &Value, target: &Target, cached: bool) -> Result<Release> {
        let tag = value[if cached { "tag" } else { "tag_name" }]
            .as_str()
            .context("GitHub returned no stable CodeGraph release tag.")?;
        let version = version(tag)
            .filter(|_| tag.trim() == tag)
            .context("GitHub returned an invalid CodeGraph release tag.")?;
        let (archive, checksums) = if cached {
            ensure!(
                value["version"] == version,
                "Cached CodeGraph release version is invalid."
            );
            (&value["asset"], &value["checksums"])
        } else {
            ensure!(
                value["draft"] == false && value["prerelease"] == false,
                "GitHub returned an invalid stable CodeGraph release."
            );
            let assets = value["assets"]
                .as_array()
                .context("GitHub returned no CodeGraph release assets.")?;
            let find = |name: &str| {
                let mut entries = assets.iter().filter(|entry| entry["name"] == name);
                let entry = entries
                    .next()
                    .with_context(|| format!("CodeGraph release is missing {name}."))?;
                ensure!(
                    entries.next().is_none(),
                    "CodeGraph release repeats {name}."
                );
                Ok(entry)
            };
            (find(&target.asset)?, find("SHA256SUMS")?)
        };
        Ok(Release {
            tag: tag.into(),
            version: version.into(),
            archive: self.asset(archive, tag, &target.asset, ARCHIVE_LIMIT, cached)?,
            checksums: self.asset(checksums, tag, "SHA256SUMS", CHECKSUM_LIMIT, cached)?,
        })
    }

    pub(super) async fn latest(
        &self,
        root: &Path,
        target: &Target,
        scope: &Scope,
    ) -> Result<(Release, String)> {
        let path = root.join("release-cache.json");
        let cache = read_document(&path, RELEASE_LIMIT).ok().flatten();
        let cached = cache
            .as_ref()
            .filter(|cache| cache["schemaVersion"] == 1)
            .and_then(|cache| self.release(&cache["release"], target, true).ok());
        let etag = cached
            .as_ref()
            .and(cache.as_ref())
            .and_then(|cache| cache["etag"].as_str())
            .and_then(|value| HeaderValue::from_str(value).ok());
        let mut request = self
            .client
            .get(self.api.clone())
            .timeout(TIMEOUT)
            .header(header::ACCEPT, "application/vnd.github+json")
            .header("x-github-api-version", "2022-11-28");
        if let Some(etag) = &etag {
            request = request.header(header::IF_NONE_MATCH, etag);
        }
        let (release, etag) = tokio::select! {
            _ = scope.stopped() => anyhow::bail!("CodeGraph update stopped."),
            result = async {
                let mut response = request.send().await?;
                if response.status() == StatusCode::NOT_MODIFIED && etag.is_some() && let Some(release) = cached {
                    return Ok::<_, anyhow::Error>((release, etag));
                }
                ensure!(response.status().is_success(),
                    "GitHub CodeGraph release check failed with HTTP {}.", response.status().as_u16());
                let etag = response.headers().get(header::ETAG).cloned();
                ensure!(response.content_length().is_none_or(|size| size <= RELEASE_LIMIT as u64),
                    "CodeGraph release response exceeds its size limit.");
                let mut buffer = Vec::new();
                while let Some(bytes) = response.chunk().await? {
                    ensure!(buffer.len() + bytes.len() <= RELEASE_LIMIT,
                        "CodeGraph release response exceeds its size limit.");
                    buffer.extend_from_slice(&bytes);
                }
                let value = parse_json_text(std::str::from_utf8(&buffer)?)
                    .map_err(|_| anyhow::anyhow!("GitHub returned invalid CodeGraph release JSON."))?;
                Ok((self.release(&value, target, false)?, etag))
            } => result?,
        };
        let checked_at = super::runtime::now();
        scope.check()?;
        write_document(
            &path,
            &json!({"schemaVersion":1,"release":release.wire(),
            "etag":etag.as_ref().and_then(|tag| tag.to_str().ok()),"checkedAt":checked_at}),
        )?;
        Ok((release, checked_at))
    }

    pub(super) async fn download(&self, asset: &Asset, file: &Path, scope: &Scope) -> Result<()> {
        tokio::select! {
            _ = scope.stopped() => anyhow::bail!("CodeGraph update stopped."),
            result = async {
                let mut response = self.client.get(asset.url.clone()).timeout(TIMEOUT)
                    .header(header::ACCEPT_ENCODING, "identity").send().await?;
                ensure!(response.status().is_success(), "CodeGraph asset {} failed with HTTP {}.",
                    asset.name, response.status().as_u16());
                ensure!(response.content_length().is_none_or(|size| size == asset.size),
                    "CodeGraph asset {} has a different size than the GitHub release.", asset.name);
                let mut output = tokio::fs::File::from_std(cantrip_host::files::open_private(file)?);
                let mut hash = Sha256::new();
                let mut length = 0;
                while let Some(bytes) = response.chunk().await? {
                    length += bytes.len() as u64;
                    ensure!(length <= asset.size, "CodeGraph asset {} exceeded its published size.", asset.name);
                    hash.update(&bytes);
                    output.write_all(&bytes).await?;
                }
                ensure!(length == asset.size, "CodeGraph asset {} ended before its published size.", asset.name);
                let actual: String = hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
                ensure!(actual == asset.digest,
                    "CodeGraph asset {} failed its GitHub digest check.", asset.name);
                output.sync_all().await?;
                Ok(())
            } => result,
        }
    }
}

pub(super) fn checksum(contents: &str, asset: &Asset) -> Result<()> {
    let mut hashes = contents.lines().filter_map(|line| {
        let (hash, name) = line.trim().split_once(char::is_whitespace)?;
        let name = name.trim_start();
        (name.strip_prefix('*').unwrap_or(name) == asset.name).then_some(hash)
    });
    let hash = hashes
        .next()
        .context("SHA256SUMS is missing the CodeGraph archive.")?;
    ensure!(
        hashes.next().is_none(),
        "SHA256SUMS repeats the CodeGraph archive."
    );
    ensure!(
        hash.eq_ignore_ascii_case(&asset.digest),
        "CodeGraph archive differs from its upstream SHA256SUMS entry."
    );
    Ok(())
}
