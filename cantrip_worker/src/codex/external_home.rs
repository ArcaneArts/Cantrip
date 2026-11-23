//! Discovery of user-owned Codex homes shared by native import and export.
use crate::filesystem::paths;
use anyhow::{Context, Result};
use cantrip_config::Environment;
use cantrip_wire::{JsString, text::trim};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Home {
    pub path: PathBuf,
    pub label: &'static str,
    pub fingerprint: String,
    pub present: bool,
}

pub(crate) struct Homes {
    directory: PathBuf,
    configured: Option<PathBuf>,
    user: Option<PathBuf>,
}

pub(crate) fn supported() -> bool {
    cfg!(any(target_os = "macos", windows))
}

impl Homes {
    pub(crate) fn new(data: &Path, cwd: &Path, environment: &Environment) -> Self {
        let configured = environment
            .iter()
            .find(|(key, _)| {
                if cfg!(windows) {
                    key.eq_ignore_ascii_case("CODEX_HOME")
                } else {
                    key.as_str() == "CODEX_HOME"
                }
            })
            .map(|(_, value)| value)
            .filter(|value| !trim(value).is_empty())
            .map(|value| cantrip_config::resolve(cwd, Path::new(value)));
        Self {
            directory: data.to_owned(),
            configured,
            user: std::env::home_dir(),
        }
    }

    pub(crate) fn user_home(&self) -> Result<&Path> {
        self.user
            .as_deref()
            .context("The worker has no user home directory.")
    }

    pub(crate) async fn available(&self) -> Vec<Home> {
        self.candidates()
            .await
            .into_iter()
            .filter(|home| home.present)
            .collect()
    }

    pub(crate) async fn candidates(&self) -> Vec<Home> {
        let managed = paths::canonical(&self.directory)
            .await
            .unwrap_or_else(|_| self.directory.clone());
        let usual = self.user.as_ref().map(|home| home.join(".codex"));
        let mut homes: Vec<Home> = Vec::new();
        for (label, candidate) in [
            ("$CODEX_HOME", self.configured.as_ref()),
            ("~/.codex", usual.as_ref()),
        ] {
            let Some(candidate) = candidate.filter(|path| !paths::within(&self.directory, path))
            else {
                continue;
            };
            let path = paths::canonical(candidate)
                .await
                .unwrap_or_else(|_| candidate.clone());
            if paths::within(&managed, &path)
                || homes.iter().any(|home| paths::equal(&home.path, &path))
            {
                continue;
            }
            let normalized = if cfg!(windows) {
                paths::text(&path).lowercase()
            } else {
                paths::text(&path)
            };
            homes.push(Home {
                fingerprint: fingerprint(&normalized),
                present: tokio::fs::metadata(&path)
                    .await
                    .is_ok_and(|metadata| metadata.is_dir()),
                path,
                label,
            });
        }
        homes
    }
}

fn fingerprint(path: &JsString) -> String {
    Sha256::digest(format!("chatgpt-codex\0{}", path.lossy()).as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
