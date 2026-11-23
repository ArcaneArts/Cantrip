//! Existing Git LFS CLI behavior, with shared values, dates and owned processes.
use super::{GitError, branches::render, error_message, process, remote_text, review, submodules};
use crate::filesystem::Scope;
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use indexmap::IndexMap;
use regress::Regex;
use std::{path::Path, sync::LazyLock};

static PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::with_flags(r"^\s{4}(.+?)\s+\((.+)\)$", "u").unwrap());
struct Outcome {
    ok: bool,
    output: JsString,
}
async fn run(cwd: &Path, args: &[&str], scope: &Scope) -> Result<Outcome> {
    let outcome = process::run_bounded(cwd, args, scope).await;
    scope.check()?;
    let ok = outcome.is_ok();
    Ok(Outcome {
        ok,
        output: outcome
            .map(JsString::from)
            .unwrap_or_else(|error| error_message(&error)),
    })
}
fn parsed(output: &JsString) -> Value {
    parse_json_text(&output.lossy()).unwrap_or(Value::Null)
}
fn safe(path: &JsString) -> Result<bool> {
    Ok(submodules::safe_path(Path::new("."), &path.lossy())?.is_some())
}
fn slice(value: &JsString, maximum: usize) -> JsString {
    JsString::new(value.units().iter().take(maximum).copied().collect())
}
fn patterns(output: &JsString) -> Result<Vec<Value>> {
    let text = output.lossy();
    let mut tracked = false;
    let mut rows = Vec::new();
    for line in text.split('\n') {
        let trimmed = line.trim_matches(cantrip_wire::text::whitespace);
        if trimmed == "Listing tracked patterns" {
            tracked = true;
            continue;
        }
        if trimmed == "Listing excluded patterns" {
            break;
        }
        if !tracked {
            continue;
        }
        if let Some(found) = PATTERN.find(line) {
            let pattern = &line[found.group(1).unwrap()];
            let source = &line[found.group(2).unwrap()];
            if !pattern.is_empty() && !source.is_empty() && safe(&source.into())? {
                rows.push(json!({"pattern":pattern,"source":source}));
            }
        }
    }
    rows.truncate(10_000);
    Ok(rows)
}
fn pending(output: &JsString) -> Result<IndexMap<JsString, JsString>> {
    let value = parsed(output);
    let mut rows = IndexMap::new();
    if let Some(files) = value["files"].as_object() {
        for path in cantrip_wire::coercion::keys(files).into_iter().take(10_000) {
            if let Some(status) = files[path]["status"].as_js_string()
                && !status.is_empty()
                && safe(path)?
            {
                rows.insert(path.clone(), status.clone());
            }
        }
    }
    Ok(rows)
}
fn files(output: &JsString, pending: &IndexMap<JsString, JsString>) -> Result<(Vec<Value>, bool)> {
    let value = parsed(output);
    let Some(entries) = value["files"].as_array() else {
        return Ok((Vec::new(), false));
    };
    let mut rows = Vec::new();
    for raw in entries.iter().take(10_000) {
        let (Some(path), Some(oid)) = (raw["name"].as_js_string(), raw["oid"].as_js_string())
        else {
            continue;
        };
        if path.is_empty() || oid.is_empty() || !safe(path)? {
            continue;
        }
        let size = raw["size"]
            .as_f64()
            .filter(|value| {
                value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
            })
            .unwrap_or(0.0)
            .max(0.0);
        rows.push(json!({"path":path,"oid":oid,"size":size,"checkedOut":raw["checkout"]==true,"downloaded":raw["downloaded"]==true,"status":pending.get(path)}));
    }
    Ok((rows, entries.len() > 10_000))
}
fn locks(output: &JsString) -> Result<(Vec<Value>, bool)> {
    let value = parsed(output);
    let Some(entries) = value.as_array().or_else(|| value["locks"].as_array()) else {
        return Ok((Vec::new(), false));
    };
    let mut rows = Vec::new();
    for raw in entries.iter().take(10_000) {
        let (Some(id), Some(path)) = (raw["id"].as_js_string(), raw["path"].as_js_string()) else {
            continue;
        };
        if id.is_empty() || path.is_empty() || !safe(path)? {
            continue;
        }
        let date = raw["locked_at"]
            .as_js_string()
            .or_else(|| raw["lockedAt"].as_js_string())
            .filter(|value| !value.is_empty())
            .and_then(cantrip_wire::date::parse)
            .and_then(cantrip_wire::date::iso_milliseconds);
        rows.push(json!({"id":id,"path":path,"owner":raw["owner"]["name"].as_js_string(),"lockedAt":date,"ours":raw["ours"]==true}));
    }
    Ok((rows, entries.len() > 10_000))
}
pub async fn status(cwd: &Path, refresh: bool, scope: &Scope) -> Result<Value> {
    let version = run(cwd, &["lfs", "version"], scope).await?;
    let generated = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    if !version.ok {
        return checked(
            "gitLfsStatusSchema",
            &json!({"available":false,"version":Value::Null,"message":version.output,"patterns":Vec::<Value>::new(),"files":Vec::<Value>::new(),"filesTruncated":false,"missingObjects":0,"pendingPaths":Vec::<Value>::new(),"locks":Vec::<Value>::new(),"locksTruncated":false,"locksCached":true,"lockError":Value::Null,"generatedAt":generated}),
        );
    }
    let mut lock_args = vec!["lfs", "locks", "--json"];
    if !refresh {
        lock_args.push("--cached");
    }
    // Join all accepted collectors before propagating stop/errors.
    let (pattern_result, file_result, pending_result, lock_result) = tokio::join!(
        run(cwd, &["lfs", "track"], scope),
        run(cwd, &["lfs", "ls-files", "--json", "--all"], scope),
        run(cwd, &["lfs", "status", "--json"], scope),
        run(cwd, &lock_args, scope)
    );
    let (pattern_result, file_result, pending_result, lock_result) =
        (pattern_result?, file_result?, pending_result?, lock_result?);
    let pending = if pending_result.ok {
        pending(&pending_result.output)?
    } else {
        IndexMap::new()
    };
    let (files, truncated) = if file_result.ok {
        files(&file_result.output, &pending)?
    } else {
        (Vec::new(), false)
    };
    let (locks, locks_truncated) = if lock_result.ok {
        locks(&lock_result.output)?
    } else {
        (Vec::new(), false)
    };
    let message = if file_result.ok && pending_result.ok {
        Value::Null
    } else {
        let mut units = Vec::new();
        for output in [&file_result.output, &pending_result.output] {
            if !output.is_empty() {
                if !units.is_empty() {
                    units.push(10);
                }
                units.extend_from_slice(output.units());
            }
        }
        Value::String(slice(&JsString::new(units), 10_000))
    };
    let missing = files.iter().filter(|row| row["downloaded"] != true).count();
    let pending = pending
        .into_iter()
        .map(|(path, status)| json!({"path":path,"status":status}))
        .collect::<Vec<_>>();
    checked(
        "gitLfsStatusSchema",
        &json!({
            "available":true,"version":version.output,"message":message,
            "patterns":if pattern_result.ok{patterns(&pattern_result.output)?}else{Vec::new()},
            "files":files,"filesTruncated":truncated,"missingObjects":missing,"pendingPaths":pending,
            "locks":locks,"locksTruncated":locks_truncated,"locksCached":!refresh,
            "lockError":if lock_result.ok{Value::Null}else{Value::String(lock_result.output)},
            "generatedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)
        }),
    )
}
pub async fn preview(cwd: &Path, action: &Value, scope: &Scope) -> Result<Value> {
    let (status, workspace) =
        tokio::join!(status(cwd, false, scope), review::workspace(cwd, scope));
    let status = status?;
    let workspace = workspace?;
    if status["available"] != true {
        return Err(GitError(
            status["message"]
                .as_js_string()
                .cloned()
                .unwrap_or_else(|| "Git LFS is not available on this worker.".into()),
        )
        .into());
    }
    let kind = action["type"].as_str().unwrap();
    let mut warnings = Vec::new();
    let summary = match kind {
        "install" => "Install Git LFS hooks and filters for this repository only.".into(),
        "track" => render(
            "Track {} with Git LFS and update .gitattributes.",
            &[action["pattern"].as_js_string().unwrap()],
        ),
        "untrack" => {
            warnings.push("Existing committed LFS objects are not rewritten automatically.");
            render(
                "Stop tracking {} with Git LFS and update .gitattributes.",
                &[action["pattern"].as_js_string().unwrap()],
            )
        }
        "fetch" | "pull" => {
            let remote = action["remote"]
                .as_js_string()
                .map(|remote| render(" from {}", &[remote]))
                .unwrap_or_else(|| "".into());
            if kind == "pull" {
                render("Fetch and check out Git LFS objects{}.", &[&remote])
            } else {
                let prefix = JsString::from(if action["all"] == true {
                    "Fetch every reachable"
                } else {
                    "Fetch required"
                });
                render("{} Git LFS object{}.", &[&prefix, &remote])
            }
        }
        "prune" => {
            warnings.push("Pruned local objects may need to be downloaded again later.");
            if action["verifyRemote"] == true {
                warnings.push("Remote verification can fail when the LFS server is offline.");
            }
            "Prune old local Git LFS objects that are no longer required.".into()
        }
        "refreshLocks" => "Refresh lock ownership from the configured Git LFS server.".into(),
        "lock" => render(
            "Lock {} on the configured Git LFS server.",
            &[action["path"].as_js_string().unwrap()],
        ),
        _ => {
            if action["force"] == true {
                warnings.push("Force unlock may remove another user's lock.");
            }
            let prefix = JsString::from(if action["force"] == true {
                "Force unlock"
            } else {
                "Unlock"
            });
            render(
                "{} {} on the configured Git LFS server.",
                &[&prefix, action["path"].as_js_string().unwrap()],
            )
        }
    };
    let mut stable = status.as_object().unwrap().clone();
    stable.shift_remove("generatedAt");
    let header =
        json!({"action":action,"status":Value::Object(stable),"workspace":workspace}).stringify();
    checked(
        "gitLfsActionPreviewSchema",
        &json!({"action":action,"token":review::digest(&[header.as_bytes()]),"destructive":kind=="prune"||kind=="untrack"||(kind=="unlock"&&action["force"]==true),"summary":summary,"warnings":warnings,"status":status}),
    )
}
pub async fn apply(cwd: &Path, action: &Value, token: &JsString, scope: &Scope) -> Result<Value> {
    if preview(cwd, action, scope).await?["token"].as_js_string() != Some(token) {
        bail!(
            "Git LFS or the selected worktree changed after this preview. Review the action again."
        );
    }
    let kind = action["type"].as_str().unwrap();
    let pattern = action["pattern"].as_js_string().map(JsString::lossy);
    let remote = action["remote"].as_js_string().map(JsString::lossy);
    let path = action["path"].as_js_string().map(JsString::lossy);
    let mut args = vec!["lfs"];
    match kind {
        "install" => args.extend(["install", "--local"]),
        "track" | "untrack" => args.extend([kind, pattern.as_deref().unwrap()]),
        "fetch" | "pull" => {
            args.push(kind);
            if kind == "fetch" && action["all"] == true {
                args.push("--all");
            }
            if let Some(remote) = remote.as_deref() {
                args.push(remote);
            }
        }
        "prune" => {
            args.push("prune");
            if action["verifyRemote"] == true {
                args.push("--verify-remote");
            }
        }
        "refreshLocks" => args.extend(["locks", "--json"]),
        "lock" => args.extend(["lock", path.as_deref().unwrap()]),
        _ => {
            args.push("unlock");
            if action["force"] == true {
                args.push("--force");
            }
            args.push(path.as_deref().unwrap());
        }
    }
    let output = process::run_bounded(cwd, &args, scope).await?;
    checked(
        "gitLfsMutationResultSchema",
        &json!({"output":remote_text::sanitize(&output.into()).0,"status":super::status::status(cwd,scope).await?,"lfs":status(cwd,kind=="refreshLocks",scope).await?}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn json_fields_retain_js_order_numbers_and_raw_paths() {
        let changes = pending(&r#"{"files":{"10":{"status":"M"},"2":{"status":"A"},"01":{"status":"D"},"../escape":{"status":"M"},"ignored":null}}"#.into()).unwrap();
        assert_eq!(
            changes.keys().map(JsString::lossy).collect::<Vec<_>>(),
            ["2", "10", "01"]
        );
        let oid = "a".repeat(64);
        let source = format!(
            r#"{{"files":[{{"name":"2","oid":"{oid}","size":-1,"checkout":true,"downloaded":false}},{{"name":"asset","oid":"{oid}","size":9007199254740992}},{{"name":"fraction","oid":"{oid}","size":1.5}},{{"name":"../escape","oid":"{oid}"}},null]}}"#
        );
        let (rows, truncated) = files(&source.into(), &changes).unwrap();
        assert!(!truncated);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0]["status"].as_str(), Some("A"));
        assert!(rows.iter().all(|row| row["size"].as_f64() == Some(0.0)));
    }
    #[test]
    fn lock_shapes_and_dates_and_malformed_json_match_source() {
        let lock = r#"{"id":"1","path":"asset","owner":{"name":"Fixture"},"locked_at":"2026-11-17T06:00:00-06:00","ours":true}"#;
        let array = locks(&format!("[{lock}]").into()).unwrap();
        assert_eq!(
            array,
            locks(&format!(r#"{{"locks":[{lock}]}}"#).into()).unwrap()
        );
        assert_eq!(
            array.0[0]["lockedAt"].as_str(),
            Some("2026-11-17T12:00:00.000Z")
        );
        let unpaired =
            locks(&r#"[{"id":"2","path":"raw-\ud800","owner":{"name":"\ud800"}}]"#.into()).unwrap();
        assert_eq!(
            unpaired.0[0]["owner"].as_js_string().unwrap().units(),
            &[0xd800]
        );
        assert!(
            files(&"malformed".into(), &IndexMap::new())
                .unwrap()
                .0
                .is_empty()
        );
        assert!(pending(&"[]".into()).unwrap().is_empty());
        assert!(locks(&"null".into()).unwrap().0.is_empty());
    }
}
