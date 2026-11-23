use crate::{
    filesystem::{Scope, paths},
    native_items::slice,
};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{JsString, Value, date::iso_milliseconds, value::json};
use futures::{StreamExt, stream};
use regress::Regex;
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::LazyLock,
};

pub(super) struct Target {
    id: JsString,
    path: PathBuf,
    origin: Option<JsString>,
    worktrees: Vec<(JsString, PathBuf)>,
}

impl Target {
    pub(super) fn roots(&self) -> impl Iterator<Item = &Path> {
        std::iter::once(self.path.as_path())
            .chain(self.worktrees.iter().map(|(_, path)| path.as_path()))
    }
}

pub(super) async fn targets(value: &Value, scope: &Scope) -> Result<Vec<Target>> {
    let entries = value
        .as_array()
        .context("Missing external history targets.")?;
    let mut pending = Vec::with_capacity(entries.len());
    for entry in entries {
        pending.push(target(entry, scope));
    }
    stream::iter(pending)
        .buffered(8)
        .collect::<Vec<Result<_>>>()
        .await
        .into_iter()
        .collect()
}

async fn target(entry: &Value, scope: &Scope) -> Result<Target> {
    let id = field(entry, "projectReplicaId")?.clone();
    let path = canonical(field(entry, "path")?).await?;
    let args = [
        OsString::from("-C"),
        path.clone().into_os_string(),
        "config".into(),
        "--get".into(),
        "remote.origin.url".into(),
    ];
    let origin = scope
        .run("git".as_ref(), &args, 128 * 1024, 5_000)
        .await
        .ok()
        .and_then(|text| git_origin(Some(&text.into())));
    let mut worktrees = Vec::new();
    for tree in entry["worktrees"]
        .as_array()
        .context("Missing external history worktrees.")?
    {
        worktrees.push((
            field(tree, "worktreeId")?.clone(),
            canonical(field(tree, "path")?).await?,
        ));
    }
    Ok(Target {
        id,
        path,
        origin,
        worktrees,
    })
}

async fn canonical(value: &JsString) -> Result<PathBuf> {
    let path = paths::resolve(&paths::native(value))?;
    Ok(paths::canonical(&path).await.unwrap_or(path))
}

pub(super) fn field<'a>(value: &'a Value, key: &str) -> Result<&'a JsString> {
    value[key]
        .as_js_string()
        .context("Malformed Codex history field.")
}

fn git_origin(value: Option<&JsString>) -> Option<JsString> {
    static SCP: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^(?:[^@/]+@)?([^:/]+):(.+)$").unwrap());
    let text = value?.trim();
    if text.is_empty() {
        return None;
    }
    let lossy = text.lossy();
    let origin = if let Some(found) = SCP.find(&lossy).filter(|_| !lossy.contains("://")) {
        format!(
            "{}/{}",
            &lossy[found.group(1).unwrap()],
            &lossy[found.group(2).unwrap()]
        )
    } else if let Ok(url) = url::Url::parse(&lossy) {
        format!("{}{}", url.host_str().unwrap_or_default(), url.path())
    } else {
        lossy.into_owned()
    };
    let lower = origin.to_lowercase();
    Some(
        lower
            .strip_suffix(".git")
            .unwrap_or(&lower)
            .trim_end_matches('/')
            .into(),
    )
}

fn match_thread(thread: &Value, targets: &[Target]) -> Result<Option<Value>> {
    let cwd = paths::resolve(&paths::native(field(thread, "cwd")?))?;
    let mut best = None;
    let mut length = 0;
    for target in targets {
        for (tree, path) in &target.worktrees {
            let size = paths::text(path).len();
            if size > length && paths::within(path, &cwd) {
                length = size;
                best = Some(
                    json!({"kind":"worktree-path","projectReplicaId":target.id,"worktreeId":tree}),
                );
            }
        }
    }
    if best.is_some() {
        return Ok(best);
    }
    if let Some(target) = targets
        .iter()
        .find(|target| paths::within(&target.path, &cwd))
    {
        return Ok(Some(
            json!({"kind":"replica-path","projectReplicaId":target.id,"worktreeId":Value::Null}),
        ));
    }
    let Some(origin) = git_origin(thread["gitInfo"]["originUrl"].as_js_string()) else {
        return Ok(None);
    };
    let mut matches = targets
        .iter()
        .filter(|target| target.origin.as_ref() == Some(&origin));
    Ok(matches.next().filter(|_| matches.next().is_none()).map(
        |target| json!({"kind":"git-origin","projectReplicaId":target.id,"worktreeId":Value::Null}),
    ))
}

pub(super) fn validate_thread(thread: &Value) -> Result<()> {
    for key in ["id", "preview", "modelProvider", "cwd", "cliVersion"] {
        let text = field(thread, key)?;
        ensure!(
            !matches!(key, "id" | "cwd" | "modelProvider") || !text.is_empty(),
            "Malformed Codex history field."
        );
    }
    ensure!(
        thread["ephemeral"].as_bool().is_some()
            && ["name", "parentThreadId"].iter().all(|key| thread
                .get(*key)
                .is_some_and(|value| value.is_null() || value.is_string()))
            && matches!(thread["source"].as_str(), Some("cli" | "vscode"))
            && matches!(
                thread["status"]["type"].as_str(),
                Some("notLoaded" | "idle" | "systemError" | "active")
            )
            && ["createdAt", "updatedAt"]
                .iter()
                .all(|key| thread[*key].as_f64().is_some_and(f64::is_finite)),
        "Codex returned invalid external thread metadata."
    );
    Ok(())
}

pub(super) fn metadata(
    thread: &Value,
    archived: bool,
    targets: &[Target],
) -> Result<Option<Value>> {
    validate_thread(thread)?;
    if thread["ephemeral"] == true
        || !thread["parentThreadId"].is_null()
        || thread["status"]["type"] == "active"
    {
        return Ok(None);
    }
    let Some(matching) = match_thread(thread, targets)? else {
        return Ok(None);
    };
    let preview = slice(field(thread, "preview")?, 0, 2_000);
    let title = thread["name"]
        .as_js_string()
        .map(|text| slice(text, 0, 500).trim())
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| preview.trim());
    let title = if title.is_empty() {
        "Imported Codex chat".into()
    } else {
        slice(&title, 0, 500)
    };
    let date = |key: &str| {
        iso_milliseconds((thread[key].as_f64().unwrap().max(0.0) * 1_000.0) as i64)
            .context("Invalid Codex history timestamp.")
    };
    let status = match thread["status"]["type"].as_str() {
        Some("notLoaded") => "not-loaded",
        Some("systemError") => "system-error",
        _ => "idle",
    };
    let git = if thread["gitInfo"].is_object() {
        Value::object(
            [("branch", 1_000), ("sha", 200), ("originUrl", 4_000)].map(|(key, max)| {
                (
                    key,
                    json!(
                        thread["gitInfo"][key]
                            .as_js_string()
                            .map(|text| slice(text, 0, max))
                    ),
                )
            }),
        )
    } else {
        Value::Null
    };
    Ok(Some(json!({
        "sourceThreadId":slice(field(thread, "id")?, 0, 200), "title":title, "preview":preview,
        "cwd":slice(field(thread, "cwd")?, 0, 8_192), "createdAt":date("createdAt")?, "updatedAt":date("updatedAt")?,
        "archived":archived, "source":thread["source"], "status":status,
        "modelProvider":slice(field(thread, "modelProvider")?, 0, 200),
        "cliVersion":if field(thread, "cliVersion")?.is_empty() { Value::Null } else { json!(slice(field(thread, "cliVersion")?, 0, 100)) },
        "git":git, "match":matching, "existingImport":Value::Null
    })))
}
