//! Reviewed dirty-index/worktree transfer with retained stash recovery.
use super::{diff, history, managed, process, review, stash_actions, stashes, status};
use crate::filesystem::{Scope, explorer::io_error, paths};
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use futures::{StreamExt, TryStreamExt, stream};
use indexmap::IndexSet;
use std::path::{Path, PathBuf};
struct State {
    source_status: Value,
    target_status: Value,
    source_head: String,
    target_head: String,
    patch: review::Patch,
    untracked: Vec<Value>,
    token: String,
}
async fn canonical(path: &Path) -> Result<PathBuf> {
    match paths::canonical(path).await {
        Ok(path) => Ok(path),
        Err(_) => Ok(paths::resolve(path)?),
    }
}
async fn common(cwd: &Path, scope: &Scope) -> Result<PathBuf> {
    let directory = process::text(cwd, &["rev-parse", "--git-common-dir"], scope).await?;
    canonical(&cantrip_config::resolve(cwd, Path::new(&directory))).await
}
async fn index(cwd: &Path, scope: &Scope) -> Result<String> {
    let index = process::text(cwd, &["rev-parse", "--git-path", "index"], scope).await?;
    let index = cantrip_config::resolve(cwd, Path::new(&index));
    let contents = tokio::fs::read(&index)
        .await
        .map_err(|error| io_error("open", &index, error))?;
    scope.check()?;
    Ok(review::digest(&[&contents]))
}
async fn state(source: &Path, target: &Path, scope: &Scope) -> Result<State> {
    let (source_path, target_path, source_common, target_common) = tokio::join!(
        canonical(source),
        canonical(target),
        common(source, scope),
        common(target, scope)
    );
    if source_path? == target_path? {
        bail!("Choose a different worktree for the moved changes.");
    }
    if source_common? != target_common? {
        bail!("Changes can only move between worktrees of one repository.");
    }
    let (source_idle, target_idle) =
        tokio::join!(review::idle(source, scope), review::idle(target, scope));
    source_idle?;
    target_idle?;
    let head = JsString::from("HEAD");
    let (source_status, target_status, source_head, target_head, patch, index) = tokio::join!(
        status::status(source, scope),
        status::status(target, scope),
        history::resolve(source, &head, scope),
        history::resolve(target, &head, scope),
        review::patch(
            source,
            &["diff", "--binary", "--no-ext-diff", "HEAD"],
            scope
        ),
        index(source, scope)
    );
    let source_status = source_status?;
    let target_status = target_status?;
    let source_head = source_head?;
    let target_head = target_head?;
    let patch = patch?;
    let index = index?;
    let files = source_status["files"].as_array().unwrap();
    if files.is_empty() {
        bail!("The source worktree has no changes to move.");
    }
    review::clean(&target_status, "Moving changes")?;
    let mut untracked_paths = files
        .iter()
        .filter(|file| file["indexStatus"] == "?" && file["worktreeStatus"] == "?")
        .map(|file| file["path"].as_js_string().unwrap().clone())
        .collect::<Vec<_>>();
    untracked_paths.sort_by(|a, b| a.units().cmp(b.units()));
    let untracked = stream::iter(untracked_paths)
        .map(|path| async move {
            if !diff::safe(&path) {
                return Err(history::message(
                    "The untracked path ",
                    &path,
                    " is not safe to move.",
                ));
            }
            let hash = process::text(source, &["hash-object", "--", &path.lossy()], scope).await?;
            Ok::<_, anyhow::Error>(json!({"path":path,"hash":hash}))
        })
        .buffered(4)
        .try_collect::<Vec<_>>()
        .await?;
    let mut changed = IndexSet::new();
    for file in files {
        changed.insert(file["path"].as_js_string().unwrap().clone());
        if let Some(original) = file["originalPath"].as_js_string() {
            changed.insert(original.clone());
        }
    }
    let mut changed = changed.into_iter().collect::<Vec<_>>();
    changed.sort_by(|a, b| a.units().cmp(b.units()));
    let content = stream::iter(changed)
        .map(|path| async move {
            let hash = process::text(source, &["hash-object", "--", &path.lossy()], scope)
                .await
                .ok();
            scope.check()?;
            Ok::<_, anyhow::Error>(json!({"path":path,"hash":hash}))
        })
        .buffered(4)
        .try_collect::<Vec<_>>()
        .await?;
    let header=json!({"sourceHead":source_head,"targetHead":target_head,"sourceStatus":source_status,"targetStatus":target_status,
        "untracked":untracked,"changedContent":content,"indexTree":index}).stringify();
    let token = review::digest(&[header.as_bytes(), b"\0", patch.text.lossy().as_bytes()]);
    Ok(State {
        source_status,
        target_status,
        source_head,
        target_head,
        patch,
        untracked,
        token,
    })
}
async fn conflict(target: &Path, head: &str, patch: &JsString, scope: &Scope) -> Result<bool> {
    if patch.is_empty() {
        return Ok(false);
    }
    let temporary = tempfile::Builder::new()
        .prefix("cantrip-worktree-move-preview-")
        .tempdir()?;
    let preview = temporary.path().join("worktree");
    let patch_path = temporary.path().join("changes.patch");
    let preview_text = paths::text(&preview);
    let patch_text = paths::text(&patch_path);
    tokio::fs::write(&patch_path, patch.lossy().as_bytes()).await?;
    let added = process::run(
        target,
        &["worktree", "add", "--detach", &preview_text.lossy(), head],
        scope,
    )
    .await;
    let added_successfully = added.is_ok();
    let outcome = match added {
        Ok(_) => {
            managed::outcome(
                &preview,
                &["apply", "--index", "--3way", &patch_text.lossy()],
                &[],
                scope,
            )
            .await
        }
        Err(error) => Err(error),
    };
    // Cancellation ends the accepted operation, but never abandons its owned
    // preview registration or disposable checkout.
    let cleanup = Scope::default();
    if added_successfully {
        let _ = managed::outcome(&preview, &["reset", "--hard", head], &[], &cleanup).await;
        let _ = managed::outcome(&preview, &["clean", "-fd"], &[], &cleanup).await;
    }
    // Git can register the checkout before its add child is stopped. Remove
    // that owned registration even if add did not report successful completion.
    let _ = managed::outcome(
        target,
        &["worktree", "remove", "--force", &preview_text.lossy()],
        &[],
        &cleanup,
    )
    .await;
    Ok(!outcome?.0)
}
pub async fn preview(
    target: &Path,
    source: &Path,
    request: &Value,
    scope: &Scope,
) -> Result<Value> {
    let state = state(source, target, scope).await?;
    let mut collisions = 0;
    for file in &state.untracked {
        let target =
            cantrip_config::resolve(target, &paths::native(file["path"].as_js_string().unwrap()));
        if tokio::fs::symlink_metadata(target).await.is_ok() {
            collisions += 1;
        }
    }
    let truncated = state.patch.truncated();
    let conflict = if truncated {
        false
    } else {
        conflict(target, &state.target_head, &state.patch.text, scope).await?
    };
    let mut warnings = Vec::new();
    if truncated {
        warnings.push("The patch preview is truncated, so the complete move is validated when Git applies it.".to_owned());
    }
    if !state.untracked.is_empty() {
        let n = state.untracked.len();
        warnings.push(format!(
            "{n} untracked {} included in the move.",
            if n == 1 { "file is" } else { "files are" }
        ));
    }
    if collisions > 0 {
        warnings.push(format!(
            "{collisions} untracked {} in the target worktree.",
            if collisions == 1 {
                "path already exists"
            } else {
                "paths already exist"
            }
        ));
    }
    let would_conflict = conflict || collisions > 0;
    if would_conflict {
        warnings.push("The target may require conflict resolution. Cantrip retains a recovery stash until the move is resolved.".to_owned());
    }
    let branch = |status: &Value, head: &str| {
        status["branch"]
            .as_js_string()
            .filter(|value| !value.is_empty())
            .cloned()
            .unwrap_or_else(|| head[..10].into())
    };
    let count = state.source_status["files"].as_array().unwrap().len();
    let summary = super::branches::render(
        &format!(
            "Move {count} changed {} from {{}} to {{}}.",
            if count == 1 { "file" } else { "files" }
        ),
        &[
            &branch(&state.source_status, &state.source_head),
            &branch(&state.target_status, &state.target_head),
        ],
    );
    checked(
        "gitWorktreeChangesMovePreviewSchema",
        &json!({"request":request,"token":state.token,"destructive":true,"summary":summary,"warnings":warnings,
        "sourceBranch":state.source_status["branch"].as_js_string().filter(|branch|!branch.is_empty()),"sourceHead":state.source_head,
        "targetBranch":state.target_status["branch"].as_js_string().filter(|branch|!branch.is_empty()),"targetHead":state.target_head,
        "files":state.source_status["files"],"patch":state.patch.bounded(),"patchTruncated":truncated,"wouldConflict":would_conflict}),
    )
}
pub async fn apply(
    target: &Path,
    source: &Path,
    request: &Value,
    token: &JsString,
    scope: &Scope,
) -> Result<Value> {
    let preview = preview(target, source, request, scope).await?;
    if preview["token"].as_js_string() != Some(token) {
        bail!("The source or target worktree changed after this preview. Review the move again.");
    }
    let before = stashes::list(source, scope).await?;
    let token = preview["token"].as_str().unwrap();
    let message = super::branches::render(
        "Cantrip move from {} ({})",
        &[
            request["sourceWorktreeId"].as_js_string().unwrap(),
            &token[..12].into(),
        ],
    );
    process::run(
        source,
        &[
            "stash",
            "push",
            "--include-untracked",
            "--message",
            &message.lossy(),
        ],
        scope,
    )
    .await?;
    let after = stashes::list(source, scope).await?;
    let created = after["stashes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|candidate| {
            !before["stashes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|previous| previous["hash"] == candidate["hash"])
        })
        .ok_or_else(|| anyhow::anyhow!("Git did not create the recovery stash for this move."))?;
    let target_ref = process::text(target, &["symbolic-ref", "-q", "HEAD"], scope)
        .await
        .ok();
    scope.check()?;
    let head = preview["targetHead"].as_str().unwrap();
    let checkpoint = stash_actions::checkpoint(target, head, token, scope).await?;
    let hash = created["hash"].as_str().unwrap();
    let outcome =
        managed::outcome(target, &["stash", "apply", "--index", hash], &[], scope).await?;
    let target_status = status::status(target, scope).await?;
    let conflicts = managed::conflicts(&target_status);
    if !outcome.0 && conflicts.is_empty() {
        managed::restore_stash(
            target,
            &json!({"originalHead":head,"targetRef":target_ref,"checkpointRef":checkpoint}),
            None,
            scope,
        )
        .await?;
        let restored =
            managed::outcome(source, &["stash", "apply", "--index", hash], &[], scope).await?;
        if restored.0 {
            stashes::drop_hash(source, hash, scope).await?;
        }
        bail!(
            "{}",
            if restored.0 {
                if outcome.1.is_empty() {
                    "Git could not apply the changes to the target worktree.".into()
                } else {
                    outcome.1
                }
            } else {
                format!(
                    "{}\nThe source recovery stash {} was retained because restoring it also failed: {}",
                    outcome.1,
                    created["ref"].as_str().unwrap(),
                    restored.1
                )
            }
        );
    }
    if outcome.0 {
        stashes::drop_hash(target, hash, scope).await?;
        process::run(target, &["update-ref", "-d", &checkpoint], scope).await?;
    }
    let stash = if outcome.0 {
        None
    } else {
        stashes::list(target, scope).await?["stashes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|candidate| candidate["hash"] == hash)
            .cloned()
    };
    let operation = if conflicts.is_empty() {
        Value::Null
    } else {
        json!({"type":"stash","state":"conflicted","originalHead":head,"currentHead":history::resolve(target,&"HEAD".into(),scope).await?,
        "sourceRef":super::branches::render("apply:move-{}",&[request["sourceWorktreeId"].as_js_string().unwrap()]),"sourceRevision":hash,"targetRef":target_ref,"targetRevision":head,
        "pendingCommits":vec![hash],"currentStep":1,"totalSteps":1,"checkpointRef":checkpoint,"conflictedPaths":conflicts})
    };
    checked(
        "gitWorktreeChangesMoveResultSchema",
        &json!({"output":if outcome.0{outcome.1}else{format!("{}\nRecovery stash retained as {}.",outcome.1,created["ref"].as_str().unwrap())},
        "status":target_status,"sourceStatus":status::status(source,scope).await?,"stash":stash,"conflictedPaths":conflicts,"operation":operation}),
    )
}
