//! Stash selections, protected reviews and recovery checkpoints using real Git.
use super::{diff, history, managed, process, review, stashes, status};
use crate::filesystem::Scope;
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use std::{ffi::OsString, path::Path};

fn find_new(before: &Value, after: &Value) -> Option<Value> {
    after["stashes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|stash| {
            !before["stashes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|old| old["hash"] == stash["hash"])
        })
        .cloned()
}
async fn shelf(cwd: &Path, request: &Value, scope: &Scope) -> Result<String> {
    let state = status::status(cwd, scope).await?;
    let files = state["files"].as_array().unwrap();
    let tracked = files
        .iter()
        .filter(|f| f["unstaged"] == true && f["indexStatus"] != "?")
        .map(|f| f["path"].as_js_string().unwrap().lossy().into_owned())
        .collect::<Vec<_>>();
    let untracked = files
        .iter()
        .filter(|f| {
            request["includeUntracked"] == true
                && f["indexStatus"] == "?"
                && f["worktreeStatus"] == "?"
        })
        .map(|f| f["path"].as_js_string().unwrap().lossy().into_owned())
        .collect::<Vec<_>>();
    if tracked.is_empty() && untracked.is_empty() {
        bail!("No matching unstaged or untracked changes to stash.");
    }
    let temporary = tempfile::Builder::new()
        .prefix("cantrip-stash-index-")
        .tempdir()?;
    let environment = vec![(
        OsString::from("GIT_INDEX_FILE"),
        temporary.path().join("index").into_os_string(),
    )];
    let head = history::resolve(cwd, &"HEAD".into(), scope).await?;
    process::raw_environment(cwd, &["read-tree", "HEAD"], scope, &environment).await?;
    if !tracked.is_empty() {
        let mut args = vec!["diff", "--binary", "--no-ext-diff", "--no-textconv", "--"];
        args.extend(tracked.iter().map(String::as_str));
        let patch = process::raw(cwd, &args, scope).await?;
        if let Err(error) = process::input(
            cwd,
            &["apply", "--cached", "--binary", "-"],
            &patch,
            scope,
            &environment,
        )
        .await
        {
            scope.check()?;
            bail!(
                "The unstaged changes overlap staged content and cannot be shelved independently: {}",
                super::error_message(&error).lossy()
            );
        }
    }
    let tree =
        process::trim(&process::raw_environment(cwd, &["write-tree"], scope, &environment).await?);
    process::raw_environment(cwd, &["read-tree", "HEAD"], scope, &environment).await?;
    let base =
        process::trim(&process::raw_environment(cwd, &["write-tree"], scope, &environment).await?);
    let index = process::text(
        cwd,
        &[
            "commit-tree",
            &base,
            "-p",
            &head,
            "-m",
            &format!("index on {}", &head[..12]),
        ],
        scope,
    )
    .await?;
    let mut parents = vec!["-p".to_owned(), head.clone(), "-p".into(), index];
    if !untracked.is_empty() {
        process::raw_environment(cwd, &["read-tree", "--empty"], scope, &environment).await?;
        let mut args = vec!["add", "--"];
        args.extend(untracked.iter().map(String::as_str));
        process::raw_environment(cwd, &args, scope, &environment).await?;
        let tree = process::trim(
            &process::raw_environment(cwd, &["write-tree"], scope, &environment).await?,
        );
        let untracked = process::text(
            cwd,
            &[
                "commit-tree",
                &tree,
                "-p",
                &head,
                "-m",
                &format!("untracked files on {}", &head[..12]),
            ],
            scope,
        )
        .await?;
        parents.extend(["-p".into(), untracked]);
    }
    let branch = process::text(cwd, &["branch", "--show-current"], scope).await?;
    let message = format!(
        "On {branch}: {}",
        request["message"].as_js_string().unwrap().lossy()
    );
    let mut args = vec!["commit-tree", &tree];
    args.extend(parents.iter().map(String::as_str));
    args.extend(["-m", &message]);
    let stash = process::text(cwd, &args, scope).await?;
    process::run(
        cwd,
        &[
            "stash",
            "store",
            "-m",
            &request["message"].as_js_string().unwrap().lossy(),
            &stash,
        ],
        scope,
    )
    .await?;
    if !tracked.is_empty() {
        let mut args = vec!["checkout", "--"];
        args.extend(tracked.iter().map(String::as_str));
        process::run(cwd, &args, scope).await?;
    }
    if !untracked.is_empty() {
        let mut args = vec!["clean", "-f", "--"];
        args.extend(untracked.iter().map(String::as_str));
        process::run(cwd, &args, scope).await?;
    }
    temporary.close()?;
    Ok("Saved selected unstaged changes".into())
}
pub async fn create(cwd: &Path, request: &Value, scope: &Scope) -> Result<Value> {
    let before = stashes::list(cwd, scope).await?;
    let output = if request["includeStaged"] != true {
        shelf(cwd, request, scope).await?
    } else {
        let message = request["message"].as_js_string().unwrap().lossy();
        let mut args = vec!["stash", "push", "-m", &message];
        if request["includeUnstaged"] != true {
            args.push("--staged");
        }
        if request["includeUntracked"] == true {
            args.push("--include-untracked");
        }
        process::run(cwd, &args, scope).await?
    };
    let after = stashes::list(cwd, scope).await?;
    let stash = find_new(&before, &after)
        .ok_or_else(|| anyhow::anyhow!("Git did not create a stash for this selection."))?;
    checked(
        "gitStashMutationResultSchema",
        &json!({"output":output,"status":status::status(cwd,scope).await?,"stash":stash,"conflictedPaths":Vec::<Value>::new()}),
    )
}
pub async fn file_diff(cwd: &Path, command: &Value, scope: &Scope) -> Result<Value> {
    let path = command["path"].as_js_string().unwrap();
    if !diff::safe(path) {
        bail!("Invalid stash diff path.");
    }
    let hash = command["hash"].as_str().unwrap();
    let list = stashes::list(cwd, scope).await?;
    let file = list["stashes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["hash"] == hash)
        .and_then(|stash| {
            stash["files"]
                .as_array()
                .unwrap()
                .iter()
                .find(|f| f["path"].as_js_string() == Some(path))
                .map(|file| (stash, file))
        });
    let Some((stash, file)) = file else {
        return Err(history::message("No stash change exists for ", path, "."));
    };
    let text = path.lossy();
    let untracked = stash["includesUntracked"] == true
        && managed::succeeds(cwd, &["cat-file", "-e", &format!("{hash}^3:{text}")], scope).await?;
    let base = format!("{hash}^1");
    let target = if untracked {
        format!("{hash}^3")
    } else {
        hash.to_owned()
    };
    let patch = review::patch(
        cwd,
        &[
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            &format!(
                "--unified={}",
                command["contextLines"].as_u64().unwrap_or(3)
            ),
            &base,
            &target,
            "--",
            &text,
        ],
        scope,
    )
    .await?;
    let binary = file["binary"] == true;
    let (old, new) = tokio::join!(
        diff::object(cwd, Some(format!("{base}:{text}")), path, binary, scope),
        diff::object(cwd, Some(format!("{target}:{text}")), path, binary, scope)
    );
    checked(
        "gitStashFileDiffSchema",
        &json!({"hash":hash,"path":path,"patch":patch.bounded(),"truncated":patch.truncated(),"binary":binary,"oldFile":old?,"newFile":new?}),
    )
}
pub async fn preview(cwd: &Path, action: &Value, scope: &Scope) -> Result<Value> {
    let list = stashes::list(cwd, scope).await?;
    let clear = action["type"] == "clear";
    if clear && list["truncated"] == true {
        bail!(
            "The stash list exceeds the bounded preview. Drop stashes individually before clearing all."
        );
    }
    let selected = list["stashes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|v| clear || (v["ref"] == action["ref"] && v["hash"] == action["hash"]))
        .cloned()
        .collect::<Vec<_>>();
    if selected.is_empty() {
        bail!(
            "{}",
            if clear {
                "There are no stashes to clear."
            } else {
                "The selected stash no longer exists at that position."
            }
        );
    }
    if action["type"] == "branch" {
        process::run(
            cwd,
            &[
                "check-ref-format",
                "--branch",
                &action["branch"].as_js_string().unwrap().lossy(),
            ],
            scope,
        )
        .await?;
    }
    let workspace = review::workspace(cwd, scope).await?;
    let state = status::status(cwd, scope).await?;
    let identities = selected
        .iter()
        .map(|s| {
            format!(
                "{}:{}",
                s["ref"].as_str().unwrap(),
                s["hash"].as_str().unwrap()
            )
        })
        .collect::<Vec<_>>()
        .join("\0");
    let token = review::digest(&[
        action.stringify().as_bytes(),
        b"\0",
        identities.as_bytes(),
        b"\0",
        workspace.as_bytes(),
    ]);
    let warnings = if state["files"].as_array().unwrap().is_empty() {
        Vec::<&str>::new()
    } else {
        vec!["The selected worktree has local changes; applying this stash may conflict."]
    };
    checked(
        "gitStashActionPreviewSchema",
        &json!({"action":action,"stashes":selected,"destructive":matches!(action["type"].as_str(),Some("pop"|"drop"|"clear"|"branch")),"token":token,"warnings":warnings}),
    )
}
pub(super) async fn checkpoint(
    cwd: &Path,
    head: &str,
    token: &str,
    scope: &Scope,
) -> Result<String> {
    let dirty = !status::status(cwd, scope).await?["files"]
        .as_array()
        .unwrap()
        .is_empty();
    let checkpoint = format!(
        "refs/cantrip/checkpoints/stash-{}-{}-{}",
        &head[..12],
        &token[..12],
        if dirty { "dirty" } else { "clean" }
    );
    if !dirty {
        process::run(cwd, &["update-ref", &checkpoint, head, ""], scope).await?;
        return Ok(checkpoint);
    }
    let before = stashes::list(cwd, scope).await?;
    process::run(
        cwd,
        &[
            "stash",
            "push",
            "--include-untracked",
            "--message",
            &format!("Cantrip recovery {}", &token[..12]),
        ],
        scope,
    )
    .await?;
    let created = find_new(&before, &stashes::list(cwd, scope).await?)
        .ok_or_else(|| anyhow::anyhow!("Git did not create the stash recovery point."))?;
    let hash = created["hash"].as_str().unwrap();
    process::run(cwd, &["update-ref", &checkpoint, hash, ""], scope).await?;
    process::run(cwd, &["stash", "apply", "--index", &checkpoint], scope).await?;
    stashes::drop_hash(cwd, hash, scope).await?;
    Ok(checkpoint)
}
pub async fn apply(cwd: &Path, action: &Value, token: &JsString, scope: &Scope) -> Result<Value> {
    let preview = preview(cwd, action, scope).await?;
    if preview["token"].as_js_string() != Some(token) {
        bail!(
            "The stash or working changes no longer match this preview. Review the action again."
        );
    }
    let kind = action["type"].as_str().unwrap();
    let resumable = matches!(kind, "apply" | "pop" | "branch");
    let head = if resumable {
        Some(history::resolve(cwd, &"HEAD".into(), scope).await?)
    } else {
        None
    };
    let target = if resumable {
        let v = process::text(cwd, &["symbolic-ref", "-q", "HEAD"], scope)
            .await
            .ok();
        scope.check()?;
        v
    } else {
        None
    };
    let checkpoint = if let Some(head) = &head {
        Some(self::checkpoint(cwd, head, preview["token"].as_str().unwrap(), scope).await?)
    } else {
        None
    };
    let context = json!({"originalHead":head,"targetRef":target,"checkpointRef":checkpoint});
    let hash = action["hash"].as_str().unwrap_or("");
    let branch = action["branch"].as_js_string().map(JsString::lossy);
    let outcome = if kind == "clear" {
        managed::outcome(cwd, &["stash", "clear"], &[], scope).await?
    } else if kind == "drop" {
        managed::outcome(
            cwd,
            &["stash", "drop", action["ref"].as_str().unwrap()],
            &[],
            scope,
        )
        .await?
    } else if kind == "branch" {
        let branch = branch.as_deref().unwrap();
        let created =
            managed::outcome(cwd, &["branch", branch, &format!("{hash}^1")], &[], scope).await?;
        if !created.0 {
            managed::restore_stash(cwd, &context, Some(branch), scope).await?;
            bail!("{}", created.1);
        }
        let switched = managed::outcome(cwd, &["switch", branch], &[], scope).await?;
        if switched.0 {
            managed::outcome(cwd, &["stash", "apply", hash], &[], scope).await?
        } else {
            switched
        }
    } else {
        managed::outcome(cwd, &["stash", "apply", hash], &[], scope).await?
    };
    let state = status::status(cwd, scope).await?;
    let conflicts = managed::conflicts(&state);
    if !outcome.0 && conflicts.is_empty() {
        if resumable {
            managed::restore_stash(cwd, &context, branch.as_deref(), scope).await?;
        }
        bail!(
            "{}",
            if outcome.1.is_empty() {
                "Git stash action failed."
            } else {
                &outcome.1
            }
        );
    }
    if outcome.0 && matches!(kind, "pop" | "branch") {
        stashes::drop_hash(cwd, hash, scope).await?;
    }
    if outcome.0
        && let Some(checkpoint) = &checkpoint
    {
        process::run(cwd, &["update-ref", "-d", checkpoint], scope).await?;
    }
    let stash = if kind == "apply" {
        stashes::list(cwd, scope).await?["stashes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["hash"] == hash)
            .cloned()
    } else {
        None
    };
    let operation = if !conflicts.is_empty() && head.is_some() && checkpoint.is_some() {
        let source = if kind == "branch" {
            JsString::new(
                "branch:"
                    .encode_utf16()
                    .chain(
                        action["branch"]
                            .as_js_string()
                            .unwrap()
                            .units()
                            .iter()
                            .copied(),
                    )
                    .chain(":".encode_utf16())
                    .chain(
                        action["ref"]
                            .as_js_string()
                            .unwrap()
                            .units()
                            .iter()
                            .copied(),
                    )
                    .collect(),
            )
        } else {
            format!("{kind}:{}", action["ref"].as_str().unwrap()).into()
        };
        json!({"type":"stash","state":"conflicted","originalHead":head,"currentHead":history::resolve(cwd,&"HEAD".into(),scope).await?,"sourceRef":source,"sourceRevision":hash,"targetRef":target,"targetRevision":head,"pendingCommits":[hash],"currentStep":1,"totalSteps":1,"checkpointRef":checkpoint,"conflictedPaths":conflicts})
    } else {
        Value::Null
    };
    checked(
        "gitStashMutationResultSchema",
        &json!({"output":outcome.1,"status":state,"stash":stash,"conflictedPaths":conflicts,"operation":operation}),
    )
}
