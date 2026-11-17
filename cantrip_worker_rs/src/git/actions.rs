//! Existing basic Git actions, executed as arguments to the native Git tool.
//! Managed merge/rebase/stash operations keep their separate ownership protocol.
use super::{GitError, process, status};
use crate::filesystem::Scope;
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use std::path::Path;

fn paths(action: &Value) -> Vec<String> {
    action["paths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_js_string().unwrap().lossy().into_owned())
        .collect()
}
async fn run_paths(cwd: &Path, prefix: &[&str], paths: &[String], scope: &Scope) -> Result<String> {
    let arguments = prefix
        .iter()
        .copied()
        .chain(paths.iter().map(String::as_str))
        .collect::<Vec<_>>();
    process::run(cwd, &arguments, scope).await
}
async fn succeeds(cwd: &Path, args: &[&str], scope: &Scope) -> Result<bool> {
    let succeeds = process::bytes(cwd, args, scope).await.is_ok();
    scope.check()?;
    Ok(succeeds)
}
async fn unstage(cwd: &Path, paths: Option<&[String]>, scope: &Scope) -> Result<String> {
    if succeeds(cwd, &["rev-parse", "--verify", "HEAD"], scope).await? {
        match paths {
            Some(paths) => run_paths(cwd, &["reset", "--quiet", "HEAD", "--"], paths, scope).await,
            None => process::run(cwd, &["reset", "--quiet", "HEAD"], scope).await,
        }
    } else {
        run_paths(
            cwd,
            &["rm", "--cached", "-r", "--ignore-unmatch", "--"],
            paths.unwrap_or(&[".".into()]),
            scope,
        )
        .await
    }
}
async fn discard(cwd: &Path, requested: Option<&[JsString]>, scope: &Scope) -> Result<String> {
    let status = status::status(cwd, scope).await?;
    let changes = status["files"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| {
            v["unstaged"] == true
                && requested.is_none_or(|paths| paths.contains(v["path"].as_js_string().unwrap()))
        })
        .collect::<Vec<_>>();
    if let Some(requested) = requested {
        let missing = requested
            .iter()
            .filter(|path| {
                !changes
                    .iter()
                    .any(|v| v["path"].as_js_string() == Some(*path))
            })
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            let mut message = JsString::from("No unstaged change exists for ")
                .units()
                .to_vec();
            for (index, path) in missing.iter().enumerate() {
                if index != 0 {
                    message.extend_from_slice(&[44, 32]);
                }
                message.extend_from_slice(path.units());
            }
            message.push(46);
            return Err(GitError(JsString::new(message)).into());
        }
    }
    if changes.iter().any(|v| {
        v["indexStatus"] == "U"
            || v["worktreeStatus"] == "U"
            || (v["indexStatus"] == "D" && v["worktreeStatus"] == "D")
            || (v["indexStatus"] == "A" && v["worktreeStatus"] == "A")
    }) {
        bail!("Resolve conflicts before discarding unstaged changes.");
    }
    let mut tracked = Vec::new();
    let mut untracked = Vec::new();
    for change in changes {
        let path = change["path"].as_js_string().unwrap().lossy().into_owned();
        if change["indexStatus"] == "?" && change["worktreeStatus"] == "?" {
            untracked.push(path);
        } else {
            tracked.push(path);
        }
    }
    let mut output = Vec::new();
    if !tracked.is_empty() {
        output.push(
            run_paths(
                cwd,
                &["--literal-pathspecs", "restore", "--worktree", "--"],
                &tracked,
                scope,
            )
            .await?,
        );
    }
    if !untracked.is_empty() {
        output.push(
            run_paths(
                cwd,
                &["--literal-pathspecs", "clean", "-f", "--"],
                &untracked,
                scope,
            )
            .await?,
        );
    }
    Ok(output
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n"))
}
async fn checkout(cwd: &Path, branch: &str, scope: &Scope) -> Result<String> {
    process::run(cwd, &["check-ref-format", "--branch", branch], scope).await?;
    let local = succeeds(
        cwd,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
        scope,
    )
    .await?;
    let remote = succeeds(
        cwd,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/remotes/{branch}"),
        ],
        scope,
    )
    .await?;
    if !local && remote {
        let local_name = branch.split('/').skip(1).collect::<Vec<_>>().join("/");
        let tracking = !local_name.is_empty()
            && succeeds(
                cwd,
                &[
                    "show-ref",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{local_name}"),
                ],
                scope,
            )
            .await?;
        if tracking {
            process::run(cwd, &["switch", &local_name], scope).await
        } else {
            process::run(cwd, &["switch", "--track", branch], scope).await
        }
    } else {
        process::run(cwd, &["switch", branch], scope).await
    }
}
async fn push(cwd: &Path, scope: &Scope) -> Result<String> {
    let upstream = process::text(
        cwd,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
        scope,
    )
    .await
    .unwrap_or_default();
    scope.check()?;
    if !upstream.is_empty() {
        return process::run(cwd, &["push"], scope).await;
    }
    let branch = process::text(cwd, &["branch", "--show-current"], scope).await?;
    if branch.is_empty() {
        bail!("Cannot push a detached HEAD.");
    }
    let remotes = process::text(cwd, &["remote"], scope).await?;
    let remotes = remotes
        .split('\n')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    let Some(remote) = remotes
        .iter()
        .copied()
        .find(|r| *r == "origin")
        .or_else(|| remotes.first().copied())
    else {
        bail!("This repository has no Git remote.");
    };
    process::run(cwd, &["push", "--set-upstream", remote, &branch], scope).await
}
/// `action` has already passed the shared worker-command/Git-action schema.
pub async fn action(cwd: &Path, action: &Value, scope: &Scope) -> Result<Value> {
    scope.check()?;
    let output = match action["type"].as_str().unwrap() {
        "stage" => run_paths(cwd, &["add", "--"], &paths(action), scope).await?,
        "unstage" => unstage(cwd, Some(&paths(action)), scope).await?,
        "stageAll" => process::run(cwd, &["add", "-A"], scope).await?,
        "unstageAll" => unstage(cwd, None, scope).await?,
        "discard" => {
            let requested = action["paths"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_js_string().unwrap().clone())
                .collect::<Vec<_>>();
            discard(cwd, Some(&requested), scope).await?
        }
        "discardAll" => discard(cwd, None, scope).await?,
        "commit" => {
            if action["all"] == true {
                process::run(cwd, &["add", "-A"], scope).await?;
            }
            process::run(
                cwd,
                &[
                    "commit",
                    "-m",
                    &action["message"].as_js_string().unwrap().lossy(),
                ],
                scope,
            )
            .await?
        }
        "pull" => {
            let fetched = process::run(cwd, &["fetch", "--all", "--prune"], scope).await?;
            let pulled = process::run(cwd, &["pull", "--ff-only"], scope).await?;
            [fetched, pulled]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        }
        "push" => push(cwd, scope).await?,
        "checkout" => {
            checkout(
                cwd,
                &action["branch"].as_js_string().unwrap().lossy(),
                scope,
            )
            .await?
        }
        "createBranch" => {
            let name = action["name"].as_js_string().unwrap().lossy();
            process::run(cwd, &["check-ref-format", "--branch", &name], scope).await?;
            process::run(cwd, &["switch", "-c", &name], scope).await?
        }
        _ => bail!("Git action is not implemented by the native worker."),
    };
    checked(
        "gitActionResultSchema",
        &json!({"status":status::status(cwd,scope).await?,"output":output}),
    )
}
