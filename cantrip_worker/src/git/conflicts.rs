//! Unmerged index stages and reviewed conflict resolution, using native Git.
use super::{diff, history, process, review, status};
use crate::filesystem::{Scope, explorer::io_error, paths};
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use indexmap::{IndexMap, IndexSet};
use std::path::Path;
const CONTENT_LIMIT: u64 = 2_000_000;
const FILE_LIMIT: usize = 1000;
struct Entry {
    mode: String,
    oid: String,
    stage: u8,
    path: JsString,
}
async fn entries(cwd: &Path, scope: &Scope) -> Result<Vec<Entry>> {
    let bytes = process::buffer(cwd, &["ls-files", "-u", "-z"], scope).await?;
    String::from_utf8_lossy(&bytes)
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(|record| {
            let invalid = || anyhow::anyhow!("Git returned an invalid unmerged index entry.");
            let (metadata, path) = record.split_once('\t').ok_or_else(invalid)?;
            let fields = metadata.split(' ').collect::<Vec<_>>();
            let path = JsString::from(path);
            if fields.len() != 3
                || fields[0].len() != 6
                || !fields[0].bytes().all(|b| b.is_ascii_digit())
                || !history::hash(fields[1])
                || !["1", "2", "3"].contains(&fields[2])
                || !diff::safe(&path)
            {
                return Err(invalid());
            }
            Ok(Entry {
                mode: fields[0].to_owned(),
                oid: fields[1].to_owned(),
                stage: fields[2].parse().unwrap(),
                path,
            })
        })
        .collect()
}
async fn groups(cwd: &Path, scope: &Scope) -> Result<(IndexMap<JsString, Vec<Entry>>, Value)> {
    let (entries, status) = tokio::join!(entries(cwd, scope), status::status(cwd, scope));
    let mut groups = IndexMap::<JsString, Vec<Entry>>::new();
    for entry in entries? {
        groups.entry(entry.path.clone()).or_default().push(entry);
    }
    Ok((groups, status?))
}
fn sorted(paths: impl IntoIterator<Item = JsString>) -> Result<Vec<JsString>> {
    let mut paths = paths.into_iter().collect::<Vec<_>>();
    let collator = status::collator()?;
    paths.sort_by(|a, b| collator.compare_utf16_icu4c(a.units(), b.units()));
    Ok(paths)
}
fn summary(path: &JsString, entries: &[Entry], status: &Value) -> Value {
    let file = status["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["path"].as_js_string() == Some(path));
    let code = file.map_or_else(
        || "UU".into(),
        |file| {
            format!(
                "{}{}",
                file["indexStatus"].as_str().unwrap(),
                file["worktreeStatus"].as_str().unwrap()
            )
        },
    );
    let kind = match code.as_str() {
        "UU" => "both-modified",
        "AA" => "both-added",
        "DD" => "both-deleted",
        "AU" => "added-by-ours",
        "UA" => "added-by-theirs",
        "DU" => "deleted-by-ours",
        "UD" => "deleted-by-theirs",
        _ => "unknown",
    };
    json!({"path":path,"code":code,"kind":kind,"baseAvailable":entries.iter().any(|e|e.stage==1),"oursAvailable":entries.iter().any(|e|e.stage==2),"theirsAvailable":entries.iter().any(|e|e.stage==3)})
}
pub async fn list(cwd: &Path, scope: &Scope) -> Result<Value> {
    let (groups, status) = groups(cwd, scope).await?;
    let paths = sorted(groups.keys().cloned())?;
    let files = paths
        .iter()
        .take(FILE_LIMIT)
        .map(|path| summary(path, &groups[path], &status))
        .collect::<Vec<_>>();
    checked(
        "gitConflictListSchema",
        &json!({"files":files,"truncated":paths.len()>FILE_LIMIT}),
    )
}
async fn stage(cwd: &Path, entry: Option<&Entry>, scope: &Scope) -> Result<Value> {
    let Some(entry) = entry else {
        return Ok(
            json!({"available":false,"oid":Value::Null,"mode":Value::Null,"size":Value::Null,"binary":false,"content":Value::Null,"truncated":false}),
        );
    };
    let size = process::text(cwd, &["cat-file", "-s", &entry.oid], scope)
        .await?
        .parse::<u64>()
        .ok()
        .filter(|v| *v <= 9_007_199_254_740_991)
        .ok_or_else(|| anyhow::anyhow!("Git returned an invalid conflict blob size."))?;
    let truncated = size > CONTENT_LIMIT;
    let mut binary = !truncated && entry.mode == "160000";
    let mut content = None;
    if !truncated && !binary {
        let bytes = process::buffer(cwd, &["cat-file", "blob", &entry.oid], scope).await?;
        binary = bytes.contains(&0);
        if !binary {
            content = Some(JsString::from(String::from_utf8_lossy(&bytes).as_ref()));
        }
    }
    Ok(
        json!({"available":true,"oid":entry.oid,"mode":entry.mode,"size":size,"binary":binary,"content":content,"truncated":truncated}),
    )
}
fn missing() -> Value {
    json!({"exists":false,"oid":Value::Null,"size":Value::Null,"binary":false,"content":Value::Null,"truncated":false})
}
async fn result(cwd: &Path, path: &JsString, scope: &Scope) -> Result<Value> {
    let root = cantrip_config::resolve(&std::env::current_dir()?, cwd);
    let absolute = cantrip_config::resolve(&root, &paths::native(path));
    if !diff::inside(&root, &absolute) {
        bail!("Invalid conflict result path.");
    }
    let metadata = match tokio::fs::symlink_metadata(&absolute).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(missing()),
        Err(error) => return Err(io_error("lstat", &absolute, error)),
    };
    let special = metadata.file_type().is_symlink() || !metadata.is_file();
    let truncated = !special && metadata.len() > CONTENT_LIMIT;
    let mut binary = special;
    let mut content = None;
    if !special && !truncated {
        let bytes = match tokio::fs::read(&absolute).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(missing()),
            Err(error) => return Err(io_error("open", &absolute, error)),
        };
        binary = bytes.contains(&0);
        if !binary {
            content = Some(JsString::from(String::from_utf8_lossy(&bytes).as_ref()));
        }
    }
    let oid = process::text(
        cwd,
        &["hash-object", "--no-filters", "--", &path.lossy()],
        scope,
    )
    .await?;
    scope.check()?;
    Ok(
        json!({"exists":true,"oid":oid,"size":metadata.len(),"binary":binary,"content":content,"truncated":truncated}),
    )
}
pub async fn detail(cwd: &Path, path: &JsString, scope: &Scope) -> Result<Value> {
    if !diff::safe(path) {
        bail!("Invalid conflict path.");
    }
    let (groups, status) = groups(cwd, scope).await?;
    let entries = groups
        .get(path)
        .ok_or_else(|| anyhow::anyhow!("This path is no longer conflicted."))?;
    let (base, ours, theirs, result) = tokio::join!(
        stage(cwd, entries.iter().find(|e| e.stage == 1), scope),
        stage(cwd, entries.iter().find(|e| e.stage == 2), scope),
        stage(cwd, entries.iter().find(|e| e.stage == 3), scope),
        result(cwd, path, scope)
    );
    let mut detail = summary(path, entries, &status);
    detail["base"] = base?;
    detail["ours"] = ours?;
    detail["theirs"] = theirs?;
    detail["result"] = result?;
    checked("gitConflictDetailSchema", &detail)
}
fn resolution(detail: &Value, request: &Value) -> Result<Value> {
    let strategy = request["strategy"].as_str().unwrap();
    let result = match strategy {
        "delete" => json!({"deleted":true,"binary":false,"content":Value::Null}),
        "manual" => json!({"deleted":false,"binary":false,"content":request["content"].clone()}),
        "result" => {
            if detail["result"]["exists"] != true {
                bail!("The worktree result no longer exists.");
            }
            json!({"deleted":false,"binary":detail["result"]["binary"].clone(),"content":detail["result"]["content"].clone()})
        }
        "ours" | "theirs" => {
            let stage = &detail[strategy];
            if stage["available"] != true {
                json!({"deleted":true,"binary":false,"content":Value::Null})
            } else {
                json!({"deleted":false,"binary":stage["binary"].clone(),"content":stage["content"].clone()})
            }
        }
        _ => {
            if detail["ours"]["available"] != true || detail["theirs"]["available"] != true {
                bail!("Both sides are not available for this conflict.");
            }
            if detail["ours"]["binary"] == true
                || detail["theirs"]["binary"] == true
                || detail["ours"]["truncated"] == true
                || detail["theirs"]["truncated"] == true
            {
                bail!("Both can only be combined for bounded text conflicts.");
            }
            let ours = detail["ours"]["content"].as_js_string().unwrap();
            let theirs = detail["theirs"]["content"].as_js_string().unwrap();
            let mut content = ours.units().to_vec();
            if !content.is_empty() && !theirs.is_empty() && content.last() != Some(&10) {
                content.push(10);
            }
            content.extend_from_slice(theirs.units());
            json!({"deleted":false,"binary":false,"content":JsString::new(content)})
        }
    };
    Ok(result)
}
pub async fn preview(cwd: &Path, request: &Value, scope: &Scope) -> Result<Value> {
    let detail = detail(cwd, request["path"].as_js_string().unwrap(), scope).await?;
    let result = resolution(&detail, request)?;
    let header=json!({"request":request,"stages":[detail["base"]["oid"].clone(),detail["ours"]["oid"].clone(),detail["theirs"]["oid"].clone()],"currentResult":detail["result"].clone(),"result":result.clone()}).stringify();
    let token = review::digest(&[header.as_bytes()]);
    let mut warnings = Vec::new();
    if result["deleted"] == true {
        warnings.push("This resolution deletes the path.");
    }
    if result["binary"] == true {
        warnings.push("Binary content cannot be previewed as text.");
    }
    if request["strategy"] == "both" {
        warnings.push("Ours is followed by theirs; review the combined result.");
    }
    checked(
        "gitConflictResolutionPreviewSchema",
        &json!({"request":request,"token":token,"resultDeleted":result["deleted"].clone(),"resultBinary":result["binary"].clone(),"resultContent":result["content"].clone(),"warnings":warnings}),
    )
}
async fn write(cwd: &Path, path: &JsString, content: &JsString, scope: &Scope) -> Result<()> {
    let root = tokio::fs::canonicalize(cwd)
        .await
        .map_err(|e| io_error("realpath", cwd, e))?;
    let absolute = cantrip_config::resolve(&root, &paths::native(path));
    if !diff::inside(&root, &absolute) {
        bail!("Invalid conflict result path.");
    }
    let directory = absolute.parent().unwrap();
    let parent = tokio::fs::canonicalize(directory)
        .await
        .map_err(|e| io_error("realpath", directory, e))?;
    if parent != root && !diff::inside(&root, &parent) {
        bail!("Conflict result parent escapes the selected worktree.");
    }
    match tokio::fs::symlink_metadata(&absolute).await {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            bail!("Refusing to overwrite a symbolic-link conflict path.")
        }
        Ok(_) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(io_error("lstat", &absolute, error)),
    }
    scope.check()?;
    tokio::fs::write(&absolute, content.lossy().as_bytes())
        .await
        .map_err(|e| io_error("open", &absolute, e))?;
    Ok(())
}
pub async fn apply(cwd: &Path, request: &Value, token: &JsString, scope: &Scope) -> Result<Value> {
    let preview = preview(cwd, request, scope).await?;
    if preview["token"].as_js_string() != Some(token) {
        bail!("The conflict or result changed after this preview. Review it again.");
    }
    let path = request["path"].as_js_string().unwrap();
    let path_text = path.lossy();
    let strategy = request["strategy"].as_str().unwrap();
    if preview["resultDeleted"] == true {
        process::run(
            cwd,
            &["rm", "-f", "--ignore-unmatch", "--", &path_text],
            scope,
        )
        .await?;
    } else if matches!(strategy, "ours" | "theirs") {
        process::run(
            cwd,
            &["checkout", &format!("--{strategy}"), "--", &path_text],
            scope,
        )
        .await?;
        process::run(cwd, &["add", "--", &path_text], scope).await?;
    } else {
        if strategy != "result" {
            let Some(content) = preview["resultContent"]
                .as_js_string()
                .filter(|_| preview["resultBinary"] != true)
            else {
                bail!("This resolution cannot be written as text.");
            };
            write(cwd, path, content, scope).await?;
        }
        process::run(cwd, &["add", "--", &path_text], scope).await?;
    }
    let unresolved = entries(cwd, scope).await?;
    let remaining: IndexSet<_> = unresolved.into_iter().map(|e| e.path).collect();
    let remaining = sorted(remaining)?;
    if remaining.contains(path) {
        bail!("Git still reports this path as unmerged in the index.");
    }
    checked(
        "gitConflictResolutionResultSchema",
        &json!({"path":path,"resolved":true,"remainingPaths":remaining,"status":status::status(cwd,scope).await?}),
    )
}
