//! Reflog/lost-commit inspection and reviewed checkpointed ref recovery.
use super::{branches, history, inspection, managed, process, review, status};
use crate::filesystem::Scope;
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use std::path::Path;
fn explanation(subject: &str) -> (String, String) {
    let (action, detail) = subject.split_once(':').unwrap_or((subject, subject));
    let action = JsString::from(process::trim(action))
        .lowercase()
        .lossy()
        .into_owned();
    let detail = process::trim(detail);
    let explanation = match action.as_str() {
        "checkout" => {
            if detail.starts_with("moving from ") {
                format!("The worktree switched {detail}.")
            } else {
                "The worktree changed its checked-out revision.".into()
            }
        }
        "reset" => {
            if detail.is_empty() {
                "HEAD or its branch was reset to another revision.".into()
            } else {
                format!("HEAD or its branch was reset ({detail}).")
            }
        }
        _ if action.starts_with("commit") => {
            if detail.is_empty() {
                "A commit moved the current branch forward.".into()
            } else {
                format!("A commit was recorded: {detail}")
            }
        }
        _ if action.starts_with("rebase") => {
            if detail.is_empty() {
                "A rebase rewrote or moved this reference.".into()
            } else {
                format!("A rebase moved this reference ({detail}).")
            }
        }
        "merge" => {
            if detail.is_empty() {
                "A merge moved this reference.".into()
            } else {
                format!("A merge moved this reference ({detail}).")
            }
        }
        "pull" => {
            if detail.is_empty() {
                "A pull updated this reference from a remote.".into()
            } else {
                format!("A pull updated this reference ({detail}).")
            }
        }
        _ => {
            if subject.is_empty() {
                "Git recorded a reference movement to this commit.".into()
            } else {
                format!("Git recorded this reference movement: {subject}")
            }
        }
    };
    (
        if action.is_empty() {
            "reflog".into()
        } else {
            action
        },
        explanation,
    )
}
fn occurred(selector: &str) -> Result<Option<String>> {
    let Some((_, suffix)) = selector.rsplit_once("@{") else {
        return Ok(None);
    };
    let Some(suffix) = suffix.strip_suffix('}') else {
        return Ok(None);
    };
    let fields = suffix.split_whitespace().collect::<Vec<_>>();
    if fields.len() != 2
        || fields[0].is_empty()
        || !fields[0].bytes().all(|b| b.is_ascii_digit())
        || fields[1].len() != 5
        || !fields[1].starts_with(['+', '-'])
        || !fields[1].as_bytes()[1..].iter().all(u8::is_ascii_digit)
    {
        return Ok(None);
    }
    let seconds = fields[0].parse::<f64>().unwrap_or(f64::INFINITY);
    if !seconds.is_finite() {
        return Ok(None);
    }
    let milliseconds = seconds * 1000.;
    if milliseconds > 8_640_000_000_000_000. {
        bail!("Invalid time value");
    }
    Ok(cantrip_wire::date::iso_milliseconds(milliseconds as i64))
}
pub async fn list(cwd: &Path, command: &Value, scope: &Scope) -> Result<Value> {
    let kind = command["kind"].as_str().unwrap();
    let limit = command["limit"].as_u64().unwrap() as usize;
    let cursor = command["cursor"].as_u64().unwrap() as usize;
    let mut parsed = Vec::new();
    if kind == "reflog" {
        let output = process::capture(
            cwd,
            &[
                "log",
                "-g",
                "--all",
                "--date=raw",
                &format!("--skip={cursor}"),
                &format!("--max-count={}", limit + 1),
                "--format=%H%x00%h%x00%gD%x00%gs%x00%gn%x00%ge%x1e",
            ],
            scope,
        )
        .await?;
        let unborn =
            String::from_utf8_lossy(&output.stderr).contains("does not have any commits yet");
        if (output.code != Some(0) || output.overflow) && !unborn {
            bail!("{}", output.error);
        }
        let text = if unborn {
            String::new()
        } else {
            String::from_utf8_lossy(&output.bytes).into_owned()
        };
        for record in text
            .split('\x1e')
            .map(process::trim)
            .filter(|s| !s.is_empty())
        {
            let fields = record.split('\0').collect::<Vec<_>>();
            let f = |i| fields.get(i).copied().unwrap_or("");
            if [0, 1, 2].iter().any(|&i| f(i).is_empty()) {
                continue;
            }
            let (action, explanation) = explanation(f(3));
            parsed.push(json!({"kind":kind,"selector":f(2),"hash":f(0),"shortHash":f(1),"subject":f(3),"action":action,"explanation":explanation,
                "actorName":(!f(4).is_empty()).then(||f(4)),"actorEmail":(!f(5).is_empty()).then(||f(5)),"occurredAt":occurred(f(2))?}));
        }
    } else {
        let output = match process::capture(
            cwd,
            &["fsck", "--no-reflogs", "--unreachable", "--no-progress"],
            scope,
        )
        .await
        {
            Ok(output) => String::from_utf8_lossy(&output.bytes).into_owned(),
            Err(_) => {
                scope.check()?;
                String::new()
            }
        };
        let mut hashes = output
            .split('\n')
            .filter_map(|line| {
                let line = line.trim();
                let hash = line
                    .strip_prefix("dangling commit ")
                    .or_else(|| line.strip_prefix("unreachable commit "))?;
                history::hash(hash).then(|| hash.to_owned())
            })
            .collect::<Vec<_>>();
        hashes.sort();
        for hash in hashes.into_iter().skip(cursor).take(limit + 1) {
            let output = process::raw(
                cwd,
                &[
                    "show",
                    "-s",
                    "--date=iso-strict",
                    "--format=%h%x00%s%x00%an%x00%ae%x00%aI",
                    &hash,
                ],
                scope,
            )
            .await?;
            let fields = output
                .trim_end_matches(cantrip_wire::text::whitespace)
                .split('\0')
                .collect::<Vec<_>>();
            let f = |i| fields.get(i).copied().unwrap_or("");
            parsed.push(json!({"kind":kind,"selector":hash,"hash":hash,"shortHash":if f(0).is_empty(){&hash[..10]}else{f(0)},"action":"unreachable","subject":f(1),
                "explanation":"This commit is not reachable from a current ref or reflog and may be recoverable until Git prunes it.",
                "actorName":(!f(2).is_empty()).then(||f(2)),"actorEmail":(!f(3).is_empty()).then(||f(3)),"occurredAt":(!f(4).is_empty()).then(||f(4))}));
        }
    }
    let more = parsed.len() > limit;
    parsed.truncate(limit);
    let next = more.then_some(cursor + parsed.len());
    checked(
        "gitRecoveryCandidateListSchema",
        &json!({"kind":kind,"entries":parsed,"hasMore":more,"nextCursor":next}),
    )
}
pub async fn preview(cwd: &Path, action: &Value, scope: &Scope) -> Result<Value> {
    review::idle(cwd, scope).await?;
    let head = JsString::from("HEAD");
    let (head, target, status, workspace) = tokio::join!(
        history::resolve(cwd, &head, scope),
        history::resolve(cwd, action["target"].as_js_string().unwrap(), scope),
        status::status(cwd, scope),
        review::workspace(cwd, scope)
    );
    let head = head?;
    let target = target?;
    let status = status?;
    let workspace = workspace?;
    let kind = action["type"].as_str().unwrap();
    let branch = action["branch"].as_js_string();
    let branch_text = branch.map(JsString::lossy);
    let mut warnings = Vec::<JsString>::new();
    let mut before = None;
    if let Some(branch_text) = branch_text.as_deref() {
        process::run(cwd, &["check-ref-format", "--branch", branch_text], scope).await?;
        let reference = format!("refs/heads/{branch_text}");
        if kind == "createBranch" {
            if managed::succeeds(cwd, &["show-ref", "--verify", "--quiet", &reference], scope)
                .await?
            {
                return Err(history::message(
                    "Local branch ",
                    branch.unwrap(),
                    " already exists.",
                ));
            }
        } else {
            before = history::resolve(cwd, &reference.into(), scope).await.ok();
            scope.check()?;
            if before.is_none() {
                return Err(history::message(
                    "Local branch ",
                    branch.unwrap(),
                    " does not exist.",
                ));
            }
            if let Some(owner) = branches::owners(cwd, scope).await?.get(branch_text) {
                let message = if owner["current"] == true {
                    branches::render(
                        "{} is checked out in this worktree. Use a reset to restore its HEAD.",
                        &[branch.unwrap()],
                    )
                } else {
                    branches::render(
                        "{} is checked out in worktree {} and cannot be moved here.",
                        &[branch.unwrap(), owner["label"].as_js_string().unwrap()],
                    )
                };
                return Err(super::GitError(message).into());
            }
            warnings.push(
                format!(
                    "The branch ref moves from {} to {} without changing this worktree.",
                    &before.as_ref().unwrap()[..10],
                    &target[..10]
                )
                .into(),
            );
        }
    } else {
        let files = status["files"].as_array().unwrap();
        let mode = action["mode"].as_str().unwrap();
        if mode == "hard" && !files.is_empty() {
            warnings.push(format!("Hard reset overwrites tracked changes in {} changed path{}; untracked files remain.",files.len(),if files.len()==1{""}else{"s"}).into());
        } else if mode == "mixed" && files.iter().any(|file| file["staged"] == true) {
            warnings.push("Mixed reset removes staged changes from the index but keeps their working-tree content.".into());
        } else if mode == "soft" {
            warnings
                .push("Soft reset moves HEAD while preserving the index and working tree.".into());
        }
    }
    let base = before.as_deref().unwrap_or(&head);
    let (commits, files) = tokio::join!(
        inspection::comparison_commits(cwd, base, &target, scope),
        inspection::files(cwd, Some(base), &target, scope)
    );
    let (commits, truncated) = commits?;
    let files = files?;
    if !commits.is_empty() {
        warnings.push(
            format!(
                "{}{} commit{} would no longer be reachable from the moved ref.",
                commits.len(),
                if truncated { "+" } else { "" },
                if commits.len() == 1 { "" } else { "s" }
            )
            .into(),
        );
    }
    let header =
        json!({"action":action,"currentHead":head,"targetRevision":target,"branchBefore":before})
            .stringify();
    let token = review::digest(&[header.as_bytes(), b"\0", workspace.as_bytes()]);
    let checkpoint = (kind != "createBranch").then(|| {
        format!(
            "refs/cantrip/recovery/{}-{}-{}",
            if kind == "reset" { "reset" } else { "branch" },
            &base[..12],
            &token[..12]
        )
    });
    let short = JsString::from(&target[..10]);
    let confirmation = if kind == "createBranch" {
        branches::render("CREATE {} AT {}", &[branch.unwrap(), &short])
    } else if kind == "restoreBranch" {
        branches::render("RESTORE {} TO {}", &[branch.unwrap(), &short])
    } else {
        format!(
            "RESET --{} TO {}",
            action["mode"].as_str().unwrap().to_ascii_uppercase(),
            &target[..10]
        )
        .into()
    };
    let summary = if kind == "createBranch" {
        branches::render(
            "Create recovery branch {} at {}.",
            &[branch.unwrap(), &short],
        )
    } else if kind == "restoreBranch" {
        branches::render("Restore local branch {} to {}.", &[branch.unwrap(), &short])
    } else {
        format!(
            "Reset this worktree from {} to {} using --{}.",
            &head[..10],
            &target[..10],
            action["mode"].as_str().unwrap()
        )
        .into()
    };
    checked(
        "gitRecoveryPreviewSchema",
        &json!({"action":action,"token":token,"destructive":kind!="createBranch","summary":summary,"warnings":warnings,"confirmation":confirmation,
        "targetRevision":target,"currentHead":head,"branchBefore":before,"checkpointRef":checkpoint,"commitsRemoved":commits,"commitsRemovedTruncated":truncated,
        "files":files.files,"filesTruncated":files.truncated,"status":status}),
    )
}
pub async fn apply(cwd: &Path, request: &Value, scope: &Scope) -> Result<Value> {
    let action = &request["action"];
    let preview = preview(cwd, action, scope).await?;
    if preview["token"] != request["token"] {
        bail!(
            "The worktree or selected revision changed after this preview. Review the recovery action again."
        );
    }
    if preview["confirmation"] != request["confirmation"] {
        return Err(history::message(
            "Type ",
            preview["confirmation"].as_js_string().unwrap(),
            " exactly to confirm this recovery action.",
        ));
    }
    let kind = action["type"].as_str().unwrap();
    if let Some(checkpoint) = preview["checkpointRef"].as_js_string() {
        let target = if kind == "restoreBranch" {
            preview["branchBefore"].as_str().unwrap()
        } else {
            preview["currentHead"].as_str().unwrap()
        };
        let existing = history::resolve(cwd, checkpoint, scope).await.ok();
        scope.check()?;
        if existing.as_ref().is_some_and(|existing| existing != target) {
            bail!("The generated recovery checkpoint already points elsewhere.");
        }
        if existing.is_none() {
            process::run(cwd, &["update-ref", &checkpoint.lossy(), target, ""], scope).await?;
        }
    }
    let target = preview["targetRevision"].as_str().unwrap();
    let output = if kind == "createBranch" {
        process::run(
            cwd,
            &[
                "branch",
                &action["branch"].as_js_string().unwrap().lossy(),
                target,
            ],
            scope,
        )
        .await?
    } else if kind == "restoreBranch" {
        process::run(
            cwd,
            &[
                "update-ref",
                &format!(
                    "refs/heads/{}",
                    action["branch"].as_js_string().unwrap().lossy()
                ),
                target,
                preview["branchBefore"].as_str().unwrap(),
            ],
            scope,
        )
        .await?
    } else {
        process::run(
            cwd,
            &[
                "reset",
                &format!("--{}", action["mode"].as_str().unwrap()),
                target,
            ],
            scope,
        )
        .await?
    };
    checked(
        "gitRecoveryResultSchema",
        &json!({"action":action,"output":output,"checkpointRef":preview["checkpointRef"],"headBefore":preview["currentHead"],
        "headAfter":history::resolve(cwd,&"HEAD".into(),scope).await?,"status":status::status(cwd,scope).await?}),
    )
}
