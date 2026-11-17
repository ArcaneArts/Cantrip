//! Revision-backed repository graphs, progressive metrics and commit overlays.
mod cache;
mod metrics;
mod snapshot;
use super::{history, inspection, process};
use crate::filesystem::{Scope, paths};
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use indexmap::{IndexMap, IndexSet};
pub(super) use metrics::metrics;
pub(super) use snapshot::snapshot;
use std::path::Path;
fn date() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn analysis(revision: bool, metrics: bool, blame: &str) -> Value {
    json!({"structure":"ready","lines":if metrics||!revision{"ready"}else{"pending"},
        "history":if metrics||!revision{"ready"}else{"pending"},"blame":blame})
}
fn id(kind: &str, path: Option<&JsString>) -> JsString {
    JsString::new(
        kind.encode_utf16()
            .chain([58])
            .chain(path.map_or(&[46][..], JsString::units).iter().copied())
            .collect(),
    )
}
fn within(path: &JsString, root: Option<&JsString>) -> bool {
    root.is_none_or(|root| {
        path == root
            || path
                .units()
                .strip_prefix(root.units())
                .is_some_and(|tail| tail.first() == Some(&47))
    })
}
fn basename(path: &JsString) -> JsString {
    let units = path.units();
    let end = units.iter().rposition(|u| *u != 47).map_or(0, |i| i + 1);
    let start = units[..end]
        .iter()
        .rposition(|u| *u == 47)
        .map_or(0, |i| i + 1);
    JsString::new(units[start..end].to_vec())
}
fn dirname(path: &JsString) -> JsString {
    let units = path.units();
    let end = units.iter().rposition(|u| *u != 47).map_or(0, |i| i + 1);
    units[..end]
        .iter()
        .rposition(|u| *u == 47)
        .map_or_else(|| ".".into(), |i| JsString::new(units[..i].to_vec()))
}
fn parent(path: &JsString, root: Option<&JsString>) -> Option<JsString> {
    let parent = dirname(path);
    if parent == JsString::from(".") || root == Some(&parent) || !within(&parent, root) {
        root.cloned()
    } else {
        Some(parent)
    }
}
fn ancestors(path: &JsString, root: Option<&JsString>) -> Vec<JsString> {
    let mut ids = vec![id("directory", root)];
    let mut current = dirname(path);
    while current != JsString::from(".") && root != Some(&current) {
        if !within(&current, root) {
            break;
        }
        ids.push(id("directory", Some(&current)));
        current = dirname(&current);
    }
    ids
}
async fn raw(cwd: &Path, args: &[&str], scope: &Scope, allow_one: bool) -> Result<String> {
    let output = process::capture_limit(cwd, args, scope, 128 * 1024 * 1024).await?;
    if output.overflow {
        bail!("{}", output.error);
    }
    if output.code != Some(0) {
        if allow_one && output.code == Some(1) {
            return Ok(String::new());
        }
        bail!("{}", output.error);
    }
    Ok(String::from_utf8_lossy(&output.bytes).into_owned())
}
async fn text(cwd: &Path, args: &[&str], scope: &Scope) -> Result<String> {
    Ok(process::trim(&raw(cwd, args, scope, false).await?))
}
async fn common(cwd: &Path, scope: &Scope) -> Result<JsString> {
    let relative = text(cwd, &["rev-parse", "--git-common-dir"], scope).await?;
    Ok(paths::text(
        &paths::canonical(&cantrip_config::resolve(cwd, Path::new(&relative))).await?,
    ))
}
pub(super) async fn overlay(cwd: &Path, command: &Value, scope: &Scope) -> Result<Value> {
    let detail = inspection::detail(cwd, command, scope).await?;
    let root = command["rootPath"].as_js_string();
    let mut additions = 0.0;
    let mut deletions = 0.0;
    let mut nodes = Vec::new();
    for file in detail["files"].as_array().unwrap() {
        if !within(file["path"].as_js_string().unwrap(), root)
            && !file["originalPath"]
                .as_js_string()
                .is_some_and(|path| within(path, root))
        {
            continue;
        }
        let added = file["additions"].as_f64().unwrap_or(0.0);
        let removed = file["deletions"].as_f64().unwrap_or(0.0);
        additions += added;
        deletions += removed;
        nodes.push(json!({"path":file["path"],"originalPath":file["originalPath"],"status":file["status"],
            "additions":file["additions"],"deletions":file["deletions"],"weight":(added+removed).max(1.0),
            "binary":file["binary"],"ghost":file["status"]=="deleted"}));
    }
    checked(
        "gitGraphCommitOverlaySchema",
        &json!({"revision":detail["hash"],"baseRevision":detail["baseHash"],
        "rootPath":root,"filesChanged":nodes.len(),"nodes":nodes,"additions":additions,
        "deletions":deletions,"truncated":detail["filesTruncated"]}),
    )
}
