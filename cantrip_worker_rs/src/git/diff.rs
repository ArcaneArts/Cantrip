use super::{GitError, process, status};
use crate::filesystem::{Scope, explorer::io_error, paths};
use anyhow::{Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use std::path::Path;
const IMAGE_LIMIT: u64 = 2 * 1024 * 1024;
pub(super) const PATCH_LIMIT: usize = 2_000_000;

pub(super) fn safe(path: &JsString) -> bool {
    let p = path.units();
    !p.is_empty()
        && p[0] != 47
        && !p.contains(&0)
        && !(p.len() >= 3
            && (p[0] as u8).is_ascii_alphabetic()
            && p[0] < 128
            && p[1] == 58
            && matches!(p[2], 47 | 92))
        && !p
            .split(|u| matches!(*u, 47 | 92))
            .any(|part| part == [46, 46])
}
fn image(path: &JsString) -> Option<&'static str> {
    let path = path.lowercase();
    let name = path.units().rsplit(|u| *u == 47).next()?;
    let dot = name.iter().rposition(|u| *u == 46)?;
    match String::from_utf16_lossy(&name[dot + 1..]).as_str() {
        "apng" => Some("image/apng"),
        "avif" => Some("image/avif"),
        "bmp" => Some("image/bmp"),
        "gif" => Some("image/gif"),
        "ico" => Some("image/x-icon"),
        "jpeg" | "jpg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}
fn side(
    kind: &str,
    size: Option<u64>,
    mime: Option<&str>,
    base64: Option<String>,
    truncated: bool,
) -> Value {
    json!({"kind":kind,"size":size,"mimeType":mime,"base64":base64,"truncated":truncated})
}
pub(super) async fn object(
    cwd: &Path,
    object: Option<String>,
    path: &JsString,
    binary: bool,
    scope: &Scope,
) -> Result<Value> {
    let Some(object) = object else {
        return Ok(side("missing", None, None, None, false));
    };
    if process::bytes(cwd, &["cat-file", "-e", &object], scope)
        .await
        .is_err()
    {
        scope.check()?;
        return Ok(side("missing", None, None, None, false));
    }
    let size = process::text(cwd, &["cat-file", "-s", &object], scope)
        .await?
        .parse::<u64>()
        .ok()
        .filter(|n| *n <= 9_007_199_254_740_991)
        .ok_or_else(|| anyhow::anyhow!("Git returned an invalid diff file size."))?;
    let Some(mime) = image(path) else {
        return Ok(side(
            if binary { "binary" } else { "text" },
            Some(size),
            None,
            None,
            false,
        ));
    };
    let oversized = size > IMAGE_LIMIT;
    let bytes = if oversized {
        None
    } else {
        Some(STANDARD.encode(process::bytes(cwd, &["show", &object], scope).await?))
    };
    Ok(side("image", Some(size), Some(mime), bytes, oversized))
}
fn inside(root: &Path, target: &Path) -> bool {
    let mut prefix = paths::text(root).units().to_vec();
    prefix.push(std::path::MAIN_SEPARATOR as u16);
    paths::text(target).units().starts_with(&prefix)
}
async fn working(cwd: &Path, path: &JsString, binary: bool, scope: &Scope) -> Result<Value> {
    scope.check()?;
    let root = tokio::fs::canonicalize(cwd)
        .await
        .map_err(|e| io_error("realpath", cwd, e))?;
    let absolute = cantrip_config::resolve(&root, &paths::native(path));
    if !inside(&root, &absolute) {
        bail!("Invalid Git diff path.");
    }
    let metadata = match tokio::fs::symlink_metadata(&absolute).await {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(side("missing", None, None, None, false));
        }
        Err(e) => return Err(io_error("lstat", &absolute, e)),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Ok(side("binary", Some(metadata.len()), None, None, false));
    }
    let Some(mime) = image(path) else {
        return Ok(side(
            if binary { "binary" } else { "text" },
            Some(metadata.len()),
            None,
            None,
            false,
        ));
    };
    if metadata.len() > IMAGE_LIMIT {
        return Ok(side("image", Some(metadata.len()), Some(mime), None, true));
    }
    let canonical = tokio::fs::canonicalize(&absolute)
        .await
        .map_err(|e| io_error("realpath", &absolute, e))?;
    if !inside(&root, &canonical) {
        bail!("Git diff image escapes the selected worktree.");
    }
    let bytes = tokio::fs::read(&canonical)
        .await
        .map_err(|e| io_error("open", &canonical, e))?;
    scope.check()?;
    Ok(side(
        "image",
        Some(metadata.len()),
        Some(mime),
        Some(STANDARD.encode(bytes)),
        false,
    ))
}
pub async fn file_diff(
    cwd: &Path,
    path: &JsString,
    kind: &str,
    context: u64,
    scope: &Scope,
) -> Result<Value> {
    if !safe(path) {
        bail!("Invalid Git diff path.");
    }
    let status = status::status(cwd, scope).await?;
    let change = status["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["path"].as_js_string() == Some(path));
    let Some(change) = change.filter(|v| {
        v[if kind == "staged" {
            "staged"
        } else {
            "unstaged"
        }] == true
    }) else {
        let mut message = JsString::from(format!("No {kind} change exists for "))
            .units()
            .to_vec();
        message.extend_from_slice(path.units());
        message.push(46);
        return Err(GitError(JsString::new(message)).into());
    };
    let path_text = path.lossy();
    let untracked = change["indexStatus"] == "?" && change["worktreeStatus"] == "?";
    let unified = format!("--unified={context}");
    let mut args = vec![
        "--literal-pathspecs",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        &unified,
        "-M",
    ];
    let original = change["originalPath"].as_js_string();
    let original_text = original.map(|s| s.lossy());
    if kind == "unstaged" && untracked {
        args.extend(["--no-index", "--", "/dev/null", &path_text]);
    } else {
        if kind == "staged" {
            args.push("--cached");
        }
        args.push("--");
        if let Some(original) = &original_text {
            args.push(original);
        }
        args.push(&path_text);
    }
    let output = process::capture(cwd, &args, scope).await?;
    if !output.overflow
        && output.code != Some(0)
        && !(kind == "unstaged" && untracked && output.code == Some(1))
    {
        bail!("{}", output.error);
    }
    let text = String::from_utf8_lossy(&output.bytes);
    let binary = text.contains("GIT binary patch")
        || text.split('\n').any(|s| s.starts_with("Binary files "));
    let text = JsString::from(text.as_ref());
    let truncated = output.overflow || text.len() > PATCH_LIMIT;
    let old_path = original.unwrap_or(path);
    let old_object = if kind == "staged" {
        Some(format!(
            "{}:{}",
            status["head"].as_str().unwrap_or("HEAD"),
            old_path.lossy()
        ))
    } else if untracked {
        None
    } else {
        Some(format!(":{}", old_path.lossy()))
    };
    let (old, new) = tokio::join!(object(cwd, old_object, old_path, binary, scope), async {
        if kind == "staged" {
            object(cwd, Some(format!(":{path_text}")), path, binary, scope).await
        } else {
            working(cwd, path, binary, scope).await
        }
    });
    checked(
        "gitFileDiffSchema",
        &json!({"path":path,"originalPath":original,"scope":kind,"patch":JsString::new(text.units().iter().take(PATCH_LIMIT).copied().collect()),"truncated":truncated,"binary":binary,"oldFile":old?,"newFile":new?}),
    )
}
