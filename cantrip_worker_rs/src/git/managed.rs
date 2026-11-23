//! Recovery of existing managed operations from Git markers and durable context.
use super::{editor, history, process, stashes, status};
use crate::filesystem::Scope;
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use indexmap::IndexSet;
use std::{ffi::OsString, path::Path};

pub(super) async fn path_file(cwd: &Path, relative: &str, scope: &Scope) -> Result<Option<String>> {
    let resolved = process::text(cwd, &["rev-parse", "--git-path", relative], scope).await?;
    let file = cantrip_config::resolve(cwd, Path::new(&resolved));
    let value = tokio::fs::read(file)
        .await
        .ok()
        .map(|bytes| process::trim(&String::from_utf8_lossy(&bytes)));
    scope.check()?;
    Ok(value)
}
async fn paused(cwd: &Path, context: &Value, scope: &Scope) -> Result<Option<String>> {
    if !editor::interactive(context) {
        return Ok(None);
    }
    let done = path_file(cwd, "rebase-merge/done", scope)
        .await?
        .unwrap_or_default();
    let action = done
        .split('\n')
        .next_back()
        .unwrap_or("")
        .split_whitespace()
        .next()
        .unwrap_or("");
    Ok(["pick", "reword", "edit", "squash", "fixup", "drop"]
        .contains(&action)
        .then(|| action.to_owned()))
}
pub(super) async fn succeeds(cwd: &Path, args: &[&str], scope: &Scope) -> Result<bool> {
    let success = process::bytes(cwd, args, scope).await.is_ok();
    scope.check()?;
    Ok(success)
}
pub(super) async fn marker(cwd: &Path, kind: &str, scope: &Scope) -> Result<bool> {
    Ok(match kind {
        "stash" => true,
        "bisect" => path_file(cwd, "BISECT_START", scope).await?.is_some(),
        "merge" => succeeds(cwd, &["rev-parse", "--verify", "-q", "MERGE_HEAD"], scope).await?,
        "rebase" => {
            path_file(cwd, "rebase-merge/head-name", scope)
                .await?
                .is_some()
                || path_file(cwd, "rebase-apply/head-name", scope)
                    .await?
                    .is_some()
        }
        _ => {
            succeeds(
                cwd,
                &[
                    "rev-parse",
                    "--verify",
                    "-q",
                    if kind == "cherry-pick" {
                        "CHERRY_PICK_HEAD"
                    } else {
                        "REVERT_HEAD"
                    },
                ],
                scope,
            )
            .await?
        }
    })
}
pub(super) fn conflicts(status: &Value) -> Vec<Value> {
    status["files"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|file| {
            let pair = format!(
                "{}{}",
                file["indexStatus"].as_str().unwrap(),
                file["worktreeStatus"].as_str().unwrap()
            );
            pair.contains('U') || ["AA", "DD"].contains(&pair.as_str())
        })
        .map(|file| file["path"].clone())
        .collect()
}
async fn progress(cwd: &Path, context: &Value, scope: &Scope) -> Result<(u64, Vec<Value>)> {
    let kind = context["type"].as_str().unwrap();
    let original = context["pendingCommits"].as_array().unwrap();
    let total = context["totalSteps"].as_u64().unwrap();
    let mut pending;
    if kind == "bisect" {
        let bad = history::resolve(cwd, &"refs/bisect/bad".into(), scope)
            .await
            .unwrap_or_else(|_| context["targetRevision"].as_str().unwrap().to_owned());
        let good = process::raw(
            cwd,
            &[
                "for-each-ref",
                "--format=%(objectname)",
                "refs/bisect/good-*",
            ],
            scope,
        )
        .await
        .unwrap_or_default();
        let good: Vec<_> = good.split('\n').filter(|s| !s.is_empty()).collect();
        let mut args = vec!["rev-list", "--max-count=10001", &bad];
        if !good.is_empty() {
            args.push("--not");
            args.extend(good);
        }
        let remaining = process::text(cwd, &args, scope).await.unwrap_or_default();
        pending = remaining
            .split('\n')
            .filter(|revision| original.iter().any(|v| v == *revision))
            .map(|s| json!(s))
            .collect::<Vec<_>>();
        if pending.len() > 10_000 {
            bail!("Bisect progress exceeds the supported 10,000 commits.");
        }
    } else if ["merge", "revert", "stash"].contains(&kind) {
        return Ok((1, original.clone()));
    } else {
        let todo = if kind == "rebase" {
            match path_file(cwd, "rebase-merge/git-rebase-todo", scope).await? {
                Some(todo) => Some(todo),
                None => path_file(cwd, "rebase-apply/git-rebase-todo", scope).await?,
            }
        } else {
            path_file(cwd, "sequencer/todo", scope).await?
        }
        .unwrap_or_default();
        let revisions = todo
            .split('\n')
            .map(process::trim)
            .filter(|s| !s.is_empty() && !s.starts_with('#'))
            .filter_map(|line| line.split_whitespace().nth(1).map(str::to_owned))
            .collect::<Vec<_>>();
        let revisions = futures::future::join_all(revisions.iter().map(|revision| async {
            history::resolve(cwd, &revision.as_str().into(), scope)
                .await
                .ok()
        }))
        .await;
        let current = history::resolve(
            cwd,
            &if kind == "rebase" {
                "REBASE_HEAD"
            } else {
                "CHERRY_PICK_HEAD"
            }
            .into(),
            scope,
        )
        .await
        .ok();
        let revisions: IndexSet<_> = current
            .into_iter()
            .chain(revisions.into_iter().flatten())
            .collect();
        pending = revisions.into_iter().map(|s| json!(s)).collect();
    }
    scope.check()?;
    if pending.is_empty() {
        pending = original.clone();
    }
    Ok((
        total.min(
            total
                .saturating_sub(pending.len() as u64)
                .saturating_add(1)
                .max(1),
        ),
        pending,
    ))
}
pub async fn inspect(
    cwd: &Path,
    context: &Value,
    output: &JsString,
    hint: Option<&str>,
    scope: &Scope,
) -> Result<Value> {
    let head = JsString::from("HEAD");
    let (status, head, marker, progress, paused) = tokio::join!(
        status::status(cwd, scope),
        history::resolve(cwd, &head, scope),
        marker(cwd, context["type"].as_str().unwrap(), scope),
        progress(cwd, context, scope),
        paused(cwd, context, scope)
    );
    let status = status?;
    let head = head?;
    let marker = marker?;
    let paused = paused?;
    let active = hint.is_none() && marker;
    let conflicts = conflicts(&status);
    let (step, pending) = progress?;
    let state = if active {
        if conflicts.is_empty() {
            "awaiting-user-action"
        } else {
            "conflicted"
        }
    } else if let Some(hint) = hint {
        hint
    } else if context["originalHead"] == head {
        "aborted"
    } else {
        "completed"
    };
    let mut result = context.clone();
    result["state"] = json!(state);
    result["currentHead"] = json!(head);
    result["currentStep"] = if state == "completed" {
        context["totalSteps"].clone()
    } else {
        json!(step)
    };
    result["pendingCommits"] = json!(if state == "completed" {
        Vec::<Value>::new()
    } else {
        pending
    });
    result["conflictedPaths"] = json!(conflicts);
    result["output"] = json!(JsString::new(
        output
            .units()
            .iter()
            .skip(output.len().saturating_sub(1_000_000))
            .copied()
            .collect()
    ));
    result["status"] = status;
    result["pausedAction"] = json!(if active { paused } else { None });
    checked("gitManagedOperationWorkerStateSchema", &result)
}
pub(super) async fn outcome(
    cwd: &Path,
    args: &[&str],
    environment: &[(OsString, OsString)],
    scope: &Scope,
) -> Result<(bool, String)> {
    let result = process::run_environment(cwd, args, scope, environment).await;
    scope.check()?;
    Ok(match result {
        Ok(output) => (true, output),
        Err(error) => (false, super::error_message(&error).lossy().into_owned()),
    })
}
async fn stash_source(context: &Value) -> Result<(Option<String>, bool)> {
    let source = context["sourceRef"]
        .as_js_string()
        .map(|s| s.lossy())
        .unwrap_or_default();
    if source.starts_with("apply:") {
        return Ok((None, source.starts_with("apply:move-")));
    }
    if source.starts_with("pop:") {
        return Ok((None, true));
    }
    if let Some(source) = source.strip_prefix("branch:") {
        let branch = source.split(':').next().unwrap_or("");
        if branch.is_empty() {
            bail!("The stash branch operation is invalid.");
        }
        return Ok((Some(branch.to_owned()), true));
    }
    bail!("The durable stash operation metadata is invalid.")
}
pub(super) async fn restore_stash(
    cwd: &Path,
    context: &Value,
    branch: Option<&str>,
    scope: &Scope,
) -> Result<String> {
    let head = context["originalHead"].as_str().unwrap();
    let mut outputs = vec![
        process::run(cwd, &["reset", "--hard", head], scope).await?,
        process::run(cwd, &["clean", "-fd"], scope).await?,
    ];
    if let Some(branch) = branch {
        let target = context["targetRef"].as_js_string().map(|s| s.lossy());
        let args = if let Some(target) = target.as_deref() {
            vec![
                "switch",
                target.strip_prefix("refs/heads/").unwrap_or(target),
            ]
        } else {
            vec!["switch", "--detach", head]
        };
        outputs.push(process::run(cwd, &args, scope).await?);
        outputs.push(process::run(cwd, &["reset", "--hard", head], scope).await?);
        outputs.push(process::run(cwd, &["clean", "-fd"], scope).await?);
        if succeeds(
            cwd,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
            scope,
        )
        .await?
        {
            outputs.push(process::run(cwd, &["branch", "-D", branch], scope).await?);
        }
    }
    let checkpoint = context["checkpointRef"].as_js_string().unwrap().lossy();
    if checkpoint.ends_with("-dirty") {
        outputs.push(process::run(cwd, &["stash", "apply", "--index", &checkpoint], scope).await?);
    }
    Ok(outputs
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n"))
}
pub async fn control(cwd: &Path, context: &Value, action: &str, scope: &Scope) -> Result<Value> {
    let kind = context["type"].as_str().unwrap();
    if !marker(cwd, kind, scope).await? {
        return inspect(cwd, context, &"".into(), None, scope).await;
    }
    let status = status::status(cwd, scope).await?;
    if kind == "bisect" {
        if !["good", "bad", "skip", "reset", "abort"].contains(&action) {
            bail!("Bisect accepts good, bad, skip, or reset controls.");
        }
        let (success, output) = outcome(
            cwd,
            &[
                "bisect",
                if ["reset", "abort"].contains(&action) {
                    "reset"
                } else {
                    action
                },
            ],
            &[],
            scope,
        )
        .await?;
        let still_active = marker(cwd, "bisect", scope).await?;
        let hint = (success && !still_active).then_some(if action == "abort" {
            "aborted"
        } else {
            "completed"
        });
        let state = inspect(cwd, context, &output.as_str().into(), hint, scope).await?;
        if !success {
            bail!("{output}");
        }
        return Ok(state);
    }
    if ["good", "bad", "reset"].contains(&action) {
        bail!("{action} is only valid for a bisect operation.");
    }
    if action == "continue" && !conflicts(&status).is_empty() {
        bail!("Resolve and stage every conflicted path before continuing this operation.");
    }
    if action == "skip" && kind == "merge" {
        bail!("Merge operations cannot skip a commit.");
    }
    if action == "skip" && kind == "stash" {
        bail!("Stash operations cannot skip a step.");
    }
    if kind == "stash" {
        let Some(checkpoint) = context["checkpointRef"]
            .as_js_string()
            .filter(|s| !s.is_empty())
        else {
            bail!(
                "The durable stash operation is missing recovery metadata and cannot be controlled safely."
            )
        };
        let Some(source) = context["sourceRevision"].as_str().filter(|s| !s.is_empty()) else {
            bail!(
                "The durable stash operation is missing recovery metadata and cannot be controlled safely."
            )
        };
        let (branch, drop) = stash_source(context).await?;
        let output = if action == "abort" {
            restore_stash(cwd, context, branch.as_deref(), scope).await?
        } else if drop {
            stashes::drop_hash(cwd, source, scope).await?
        } else {
            String::new()
        };
        process::run(cwd, &["update-ref", "-d", &checkpoint.lossy()], scope).await?;
        return inspect(
            cwd,
            context,
            &output.as_str().into(),
            Some(if action == "abort" {
                "aborted"
            } else {
                "completed"
            }),
            scope,
        )
        .await;
    }
    let args = [
        kind,
        match action {
            "abort" => "--abort",
            "skip" => "--skip",
            _ => "--continue",
        },
    ];
    let environment = editor::environment(cwd, context, scope).await?;
    let (success, output) = outcome(cwd, &args, &environment, scope).await?;
    let still_active = marker(cwd, kind, scope).await?;
    let hint = (success && !still_active).then_some(if action == "abort" {
        "aborted"
    } else {
        "completed"
    });
    let state = inspect(cwd, context, &output.as_str().into(), hint, scope).await?;
    if !success
        && !matches!(
            state["state"].as_str(),
            Some("conflicted" | "awaiting-user-action")
        )
    {
        bail!("{output}");
    }
    if matches!(state["state"].as_str(), Some("completed" | "aborted")) {
        editor::cleanup(cwd, context, scope).await?;
    }
    Ok(state)
}
pub async fn amend(
    cwd: &Path,
    context: &Value,
    message: Option<&JsString>,
    scope: &Scope,
) -> Result<Value> {
    if !editor::interactive(context) {
        bail!("Only an interactive rebase edit step can be amended here.");
    }
    if !marker(cwd, "rebase", scope).await? {
        return inspect(cwd, context, &"".into(), None, scope).await;
    }
    if paused(cwd, context, scope).await?.as_deref() != Some("edit") {
        bail!("The interactive rebase is not paused at an edit step.");
    }
    let status = status::status(cwd, scope).await?;
    if !conflicts(&status).is_empty() {
        bail!("Resolve and stage every conflict before amending the edit step.");
    }
    let staged = !succeeds(cwd, &["diff", "--cached", "--quiet"], scope).await?;
    if !staged && message.is_none_or(|s| s.is_empty()) {
        bail!("Stage an edit or enter a replacement commit message before amending.");
    }
    let environment = editor::environment(cwd, context, scope).await?;
    let text = message.map(|s| s.lossy());
    let mut args = vec![
        "-c",
        "commit.gpgSign=false",
        "commit",
        "--amend",
        "--no-verify",
    ];
    if let Some(message) = &text {
        args.extend(["--message", message]);
    } else {
        args.push("--no-edit");
    }
    let (success, amended) = outcome(cwd, &args, &environment, scope).await?;
    if !success {
        bail!("{amended}");
    }
    let (success, continued) = outcome(cwd, &["rebase", "--continue"], &environment, scope).await?;
    let still_active = marker(cwd, "rebase", scope).await?;
    let output = [amended, continued.clone()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let state = inspect(
        cwd,
        context,
        &output.as_str().into(),
        (success && !still_active).then_some("completed"),
        scope,
    )
    .await?;
    if !success
        && !matches!(
            state["state"].as_str(),
            Some("conflicted" | "awaiting-user-action")
        )
    {
        bail!("{continued}");
    }
    if state["state"] == "completed" {
        editor::cleanup(cwd, context, scope).await?;
    }
    Ok(state)
}
