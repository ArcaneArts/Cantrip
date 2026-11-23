use super::io_error;
use crate::filesystem::paths as host;
use anyhow::{Result, bail};
use cantrip_wire::JsString;
use std::{
    fs::Metadata,
    path::{Path, PathBuf},
};
use tokio::fs;

pub fn segments(path: &JsString) -> Result<Vec<JsString>> {
    let units = path.units();
    if units.contains(&0)
        || units.first() == Some(&47)
        || (units.get(1) == Some(&58)
            && units
                .first()
                .is_some_and(|u| matches!(u, 65..=90 | 97..=122)))
    {
        bail!("Explorer paths must be relative to the project.");
    }
    let segments: Vec<_> = units
        .split(|u| *u == 47)
        .filter(|s| !s.is_empty())
        .collect();
    if segments
        .iter()
        .any(|s| *s == [46] || *s == [46, 46] || s.contains(&92))
    {
        bail!("Explorer path traversal is not allowed.");
    }
    Ok(segments
        .into_iter()
        .map(|s| JsString::new(s.to_vec()))
        .collect())
}
fn append(root: &Path, segments: &[JsString]) -> PathBuf {
    segments
        .iter()
        .fold(root.to_owned(), |p, s| p.join(host::native(s)))
}
pub async fn canonical(path: &Path) -> Result<PathBuf> {
    host::canonical(path)
        .await
        .map_err(|e| io_error("realpath", path, e))
}
pub async fn metadata(path: &Path) -> Result<Metadata> {
    fs::symlink_metadata(path)
        .await
        .map_err(|e| io_error("lstat", path, e))
}
pub async fn existing(path: &Path) -> Result<Option<Metadata>> {
    match fs::symlink_metadata(path).await {
        Ok(value) => Ok(Some(value)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(io_error("lstat", path, e)),
    }
}
pub async fn resolve(root: &Path, relative: &JsString) -> Result<(Metadata, PathBuf)> {
    let root = canonical(root).await?;
    let target = append(&root, &segments(relative)?);
    // Source compares a literal root + separator prefix here (rather than
    // path.relative). Retain the filesystem-root edge case as well.
    let mut prefix = host::text(&root).units().to_vec();
    prefix.push(std::path::MAIN_SEPARATOR as u16);
    if target != root && !host::text(&target).units().starts_with(&prefix) {
        bail!("Explorer path is outside the project.");
    }
    // Intentional links outside a project are navigable and editable. Entry
    // creation/rename/deletion have stricter parent containment below.
    let target = canonical(&target).await?;
    Ok((metadata(&target).await?, target))
}
pub async fn mutable_entry(root: &Path, relative: &JsString) -> Result<(Metadata, PathBuf)> {
    let parts = segments(relative)?;
    let Some((name, parent)) = parts.split_last() else {
        bail!("The Explorer project root cannot be changed.");
    };
    let root = canonical(root).await?;
    let parent = canonical(&append(&root, parent)).await?;
    if !host::within(&root, &parent) {
        bail!("Explorer mutations cannot follow links outside the project.");
    }
    let target = parent.join(host::native(name));
    Ok((metadata(&target).await?, target))
}
pub async fn mutable_directory(root: &Path, relative: &JsString) -> Result<PathBuf> {
    let root = canonical(root).await?;
    let target = canonical(&append(&root, &segments(relative)?)).await?;
    if !host::within(&root, &target) {
        bail!("Explorer mutations cannot follow links outside the project.");
    }
    if !metadata(&target).await?.is_dir() {
        bail!("Explorer path is not a directory.");
    }
    Ok(target)
}
