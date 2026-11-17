//! Host Explorer filesystem implementation. Transport, protected state and
//! resource authorization belong to the command adapter, not this engine.
mod directory;
mod files;
mod git;
mod paths;
mod search;

use super::Scope;
use anyhow::{Result, anyhow, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use std::{fs::Metadata, path::Path, time::UNIX_EPOCH};

pub use directory::{create_directory, create_file, delete_entry, list_directory, rename_entry};
pub use files::{TextPreviewRequiredError, read_file, write_file};
pub use git::directory_commits;
pub use search::search_files;

/// Dispatch only host operations implemented in this module. This is not an
/// advertised worker command handler: the encrypted adapter is still required.
/// That adapter must validate the decrypted request with the protocol schema.
pub async fn execute(root: &Path, request: &Value, scope: &Scope) -> Result<Value> {
    execute_decoded(root, request, request, scope).await
}
/// `input` retains normalization provenance from the decrypted request; only
/// the protocol-validated `request` controls filesystem operations.
pub async fn execute_decoded(
    root: &Path,
    request: &Value,
    input: &Value,
    scope: &Scope,
) -> Result<Value> {
    scope.check()?;
    let path = request["path"].as_js_string();
    let path = || path.ok_or_else(|| anyhow!("Missing Explorer path."));
    let (kind, value) = match request["type"].as_str().unwrap_or("") {
        "explorer.directory.list" => (
            "explorer.directory.list",
            list_directory(root, path()?).await?,
        ),
        "explorer.files.search" => (
            "explorer.files.search",
            search::search_files_from_input(
                root,
                request["query"]
                    .as_js_string()
                    .ok_or_else(|| anyhow!("Missing Explorer query."))?,
                request["limit"].as_f64().unwrap_or(100.),
                input["query"].as_js_string(),
                scope,
            )
            .await?,
        ),
        "explorer.directory.commits" => (
            "explorer.directory.commits",
            directory_commits(root, path()?, scope).await?,
        ),
        "explorer.file.read" => ("explorer.file", read_file(root, path()?).await?),
        "explorer.file.write" => (
            "explorer.file",
            write_file(
                root,
                path()?,
                request["content"]
                    .as_js_string()
                    .ok_or_else(|| anyhow!("Missing Explorer content."))?,
                request["version"].as_str().unwrap_or(""),
            )
            .await?,
        ),
        "explorer.file.create" => (
            "explorer.file.created",
            create_file(
                root,
                path()?,
                request["name"]
                    .as_js_string()
                    .ok_or_else(|| anyhow!("Missing Explorer name."))?,
            )
            .await?,
        ),
        "explorer.directory.create" => (
            "explorer.directory.created",
            create_directory(root, path()?).await?,
        ),
        "explorer.entry.rename" => (
            "explorer.entry.mutated",
            rename_entry(
                root,
                path()?,
                request["name"]
                    .as_js_string()
                    .ok_or_else(|| anyhow!("Missing Explorer name."))?,
            )
            .await?,
        ),
        "explorer.entry.delete" => ("explorer.entry.mutated", delete_entry(root, path()?).await?),
        _ => bail!("This worker does not support this Explorer operation."),
    };
    Ok(json!({"type":kind,"value":value}))
}

fn joined(parent: &JsString, name: &JsString) -> JsString {
    if parent.is_empty() {
        return name.clone();
    }
    JsString::new([parent.units(), &[47], name.units()].concat())
}
fn markdown(path: &JsString) -> bool {
    let lower = path.lowercase();
    let name = lower
        .units()
        .rsplit(|u| matches!(u, 47 | 92))
        .next()
        .unwrap_or_default();
    let extension = name.rsplit(|u| *u == 46).next().unwrap_or_default();
    name.contains(&46)
        && ["md", "mdx", "markdown"]
            .iter()
            .any(|v| extension.iter().copied().eq(v.encode_utf16()))
}
fn modified(metadata: &Metadata) -> Result<String> {
    let nanos = match metadata.modified()?.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_nanos() as i128,
        Err(error) => -(error.duration().as_nanos() as i128),
    };
    // Node Stats constructs mtimeMs in floating point, then Date truncates it
    // toward zero. Preserve both stages, including timestamps before the epoch.
    let milliseconds = nanos.div_euclid(1_000_000_000) as f64 * 1000.
        + nanos.rem_euclid(1_000_000_000) as f64 / 1_000_000.;
    cantrip_protocol::date_iso_milliseconds(milliseconds.trunc() as i64)
        .ok_or_else(|| anyhow!("Invalid time value"))
}
fn entry(
    name: &JsString,
    path: &JsString,
    metadata: &Metadata,
    symbolic_link: bool,
) -> Result<Value> {
    let kind = if metadata.is_dir() {
        "directory"
    } else if metadata.is_file() {
        "file"
    } else {
        "other"
    };
    checked(
        "explorerEntrySchema",
        &json!({"name":name,"path":path,"kind":kind,"size":if metadata.is_file(){json!(metadata.len())}else{Value::Null},"modifiedAt":modified(metadata)?,"viewable":metadata.is_file(),"markdown":metadata.is_file() && markdown(name),"symbolicLink":symbolic_link}),
    )
}

fn io_error(operation: &str, path: &Path, error: std::io::Error) -> anyhow::Error {
    use std::io::ErrorKind;
    let (code, description) = match error.kind() {
        ErrorKind::NotFound => ("ENOENT", "no such file or directory"),
        ErrorKind::AlreadyExists => ("EEXIST", "file already exists"),
        ErrorKind::PermissionDenied => ("EACCES", "permission denied"),
        ErrorKind::NotADirectory => ("ENOTDIR", "not a directory"),
        ErrorKind::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        ErrorKind::DirectoryNotEmpty => ("ENOTEMPTY", "directory not empty"),
        _ => {
            return anyhow!(
                "{operation} '{}': {error}",
                super::paths::text(path).lossy()
            );
        }
    };
    anyhow!(
        "{code}: {description}, {operation} '{}'",
        super::paths::text(path).lossy()
    )
}
