//! Reviewed commit mutations and their resumable Git operation state.
use super::{history, inspection, managed, process, review, status};
use crate::filesystem::{Scope, paths};
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use indexmap::IndexSet;
use std::path::Path;

async fn revisions(cwd: &Path, action: &Value, scope: &Scope) -> Result<Vec<String>> {
    let kind = action["type"].as_str().unwrap();
    if kind != "cherryPick" {
        let revision = if kind == "amend" {
            &"HEAD".into()
        } else {
            action["revision"].as_js_string().unwrap()
        };
        return Ok(vec![history::resolve(cwd, revision, scope).await?]);
    }
    let selection = &action["selection"];
    let revisions = if selection["type"] == "commits" {
        futures::future::try_join_all(
            selection["revisions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|revision| history::resolve(cwd, revision.as_js_string().unwrap(), scope)),
        )
        .await?
    } else {
        let from = history::resolve(
            cwd,
            selection["fromRevision"].as_js_string().unwrap(),
            scope,
        )
        .await?;
        let to =
            history::resolve(cwd, selection["toRevision"].as_js_string().unwrap(), scope).await?;
        // Source returns equal bounds before its merge-commit check.
        if from == to {
            return Ok(vec![from]);
        }
        if !managed::succeeds(cwd, &["merge-base", "--is-ancestor", &from, &to], scope).await? {
            bail!("The first range commit must be an ancestor of the last commit.");
        }
        let output = process::text(
            cwd,
            &[
                "rev-list",
                "--reverse",
                "--ancestry-path",
                &format!("{from}..{to}"),
            ],
            scope,
        )
        .await?;
        std::iter::once(from)
            .chain(
                output
                    .split('\n')
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
            )
            .collect()
    };
    let revisions: IndexSet<_> = revisions.into_iter().collect();
    if revisions.len() > 1000 {
        bail!("Cherry-pick ranges are limited to 1,000 commits.");
    }
    for revision in &revisions {
        let parents = process::text(cwd, &["show", "-s", "--format=%P", revision], scope).await?;
        if parents.split(' ').filter(|s| !s.is_empty()).count() > 1 {
            bail!(
                "Merge commit {} needs an explicit mainline and cannot be included in a cherry-pick range.",
                &revision[..10]
            );
        }
    }
    Ok(revisions.into_iter().collect())
}
struct Effect {
    files: Vec<Value>,
    patch: JsString,
    truncated: bool,
    conflicts: bool,
}
async fn effect(cwd: &Path, head: &str, args: &[&str], scope: &Scope) -> Result<Effect> {
    let temporary = tempfile::Builder::new()
        .prefix("cantrip-commit-preview-")
        .tempdir()?;
    let path = temporary.path().join("worktree");
    let text = paths::text(&path).lossy().into_owned();
    let result = async {
        process::run(cwd, &["worktree", "add", "--detach", &text, head], scope).await?;
        let (success, output) = managed::outcome(&path, args, &[], scope).await?;
        let status = status::status(&path, scope).await?;
        let conflicts = !managed::conflicts(&status).is_empty();
        if !success && !conflicts {
            bail!("{output}");
        }
        let patch =
            review::patch(&path, &["diff", "--binary", "--no-ext-diff", "HEAD"], scope).await?;
        Ok(Effect {
            files: status["files"].as_array().unwrap().clone(),
            patch: patch.bounded(),
            truncated: patch.truncated(),
            conflicts,
        })
    }
    .await;
    // Accepted commands are drained on shutdown. A fresh cleanup scope lets a
    // canceled preview still remove the actual owned Git worktree registration.
    let cleanup = Scope::default();
    let _ = managed::outcome(&path, &["cherry-pick", "--abort"], &[], &cleanup).await;
    let _ = managed::outcome(&path, &["revert", "--abort"], &[], &cleanup).await;
    let _ = managed::outcome(
        cwd,
        &["worktree", "remove", "--force", &text],
        &[],
        &cleanup,
    )
    .await;
    temporary.close()?;
    result
}
pub async fn preview(cwd: &Path, action: &Value, scope: &Scope) -> Result<Value> {
    review::idle(cwd, scope).await?;
    let head_revision = JsString::from("HEAD");
    let (status, head) = tokio::join!(
        status::status(cwd, scope),
        history::resolve(cwd, &head_revision, scope)
    );
    let status = status?;
    let head = head?;
    let revisions = revisions(cwd, action, scope).await?;
    let commits = review::summaries(cwd, &revisions, scope).await?;
    let kind = action["type"].as_str().unwrap();
    let mut warnings = Vec::<String>::new();
    let summary;
    let effect;
    if kind == "cherryPick" {
        review::clean(&status, "Cherry-pick")?;
        let mut args = vec!["cherry-pick", "--no-commit"];
        args.extend(revisions.iter().map(String::as_str));
        effect = self::effect(cwd, &head, &args, scope).await?;
        summary = format!(
            "Cherry-pick {} {} onto {}.",
            revisions.len(),
            if revisions.len() == 1 {
                "commit"
            } else {
                "commits"
            },
            &head[..10]
        );
    } else if kind == "revert" {
        review::clean(&status, "Revert")?;
        let detail = inspection::detail(
            cwd,
            &json!({"revision":revisions[0],"parentIndex":0,"revisions":Vec::<Value>::new()}),
            scope,
        )
        .await?;
        let parents = detail["parents"].as_array().unwrap().len();
        let mainline = action["mainlineParent"].as_u64();
        if parents > 1 {
            if mainline.is_none_or(|index| index as usize > parents) {
                bail!(
                    "Merge commit {} requires a mainline parent between 1 and {parents}.",
                    detail["shortHash"].as_str().unwrap()
                );
            }
            warnings.push(format!(
                "Parent {} is treated as the mainline for this merge revert.",
                mainline.unwrap()
            ));
        } else if mainline.is_some() {
            bail!("Only merge commits accept a mainline parent.");
        }
        let mut args = vec!["revert", "--no-commit"];
        let number = mainline.map(|index| index.to_string());
        if let Some(number) = &number {
            args.extend(["-m", number]);
        }
        args.push(&revisions[0]);
        effect = self::effect(cwd, &head, &args, scope).await?;
        summary = format!(
            "Revert {} on {}.",
            commits[0]["shortHash"].as_str().unwrap(),
            &head[..10]
        );
    } else {
        let files = status["files"].as_array().unwrap();
        if files.iter().any(|f| f["unstaged"] == true) {
            bail!(
                "{} is blocked while the selected worktree has unstaged or conflicted changes.",
                if kind == "amend" { "Amend" } else { "Fixup" }
            );
        }
        let staged = files
            .iter()
            .filter(|f| f["staged"] == true)
            .cloned()
            .collect::<Vec<_>>();
        let message = action["message"]
            .as_js_string()
            .is_some_and(|v| !v.is_empty());
        if kind == "fixup" && staged.is_empty() {
            bail!("A fixup commit requires staged changes.");
        }
        if kind == "amend" && staged.is_empty() && !message {
            bail!("Amend requires staged changes or a replacement message.");
        }
        let patch = review::patch(
            cwd,
            &["diff", "--cached", "--binary", "--no-ext-diff", "HEAD"],
            scope,
        )
        .await?;
        let count = staged.len();
        if kind == "amend" {
            warnings.push(
                "Amending replaces HEAD. Cantrip creates a recovery reference before committing."
                    .into(),
            );
            summary = format!(
                "{} {} with {count} staged {}.",
                if message {
                    "Replace the message and amend"
                } else {
                    "Amend"
                },
                &head[..10],
                if count == 1 { "file" } else { "files" }
            );
        } else {
            summary = format!(
                "Create a fixup commit for {} from {count} staged {}.",
                commits[0]["shortHash"].as_str().unwrap(),
                if count == 1 { "file" } else { "files" }
            );
        }
        effect = Effect {
            files: staged,
            patch: patch.bounded(),
            truncated: patch.truncated(),
            conflicts: false,
        };
    }
    if effect.conflicts {
        warnings.push("The preview found conflicts. Applying starts a resumable Git operation and leaves conflicts in Working changes.".into());
    }
    let workspace = review::workspace(cwd, scope).await?;
    let header = json!({"action":action,"head":head,"revisions":revisions,"workspace":workspace})
        .stringify();
    let token = review::digest(&[header.as_bytes(), b"\0", effect.patch.lossy().as_bytes()]);
    let checkpoint = (kind == "amend").then(|| {
        format!(
            "refs/cantrip/checkpoints/amend-{}-{}",
            &head[..12],
            &token[..12]
        )
    });
    checked(
        "gitCommitActionPreviewSchema",
        &json!({"action":action,"token":token,"destructive":matches!(kind,"revert"|"amend"),"summary":summary,"warnings":warnings,"resolvedRevisions":revisions,"commits":commits,"files":effect.files,"patch":effect.patch,"patchTruncated":effect.truncated,"wouldConflict":effect.conflicts,"checkpointRef":checkpoint}),
    )
}
pub async fn apply(cwd: &Path, action: &Value, token: &JsString, scope: &Scope) -> Result<Value> {
    let preview = preview(cwd, action, scope).await?;
    if preview["token"].as_js_string() != Some(token) {
        bail!(
            "The worktree, selected commits, or staged patch changed after this preview. Review the action again."
        );
    }
    let before = history::resolve(cwd, &"HEAD".into(), scope).await?;
    let revisions = preview["resolvedRevisions"].as_array().unwrap();
    let kind = action["type"].as_str().unwrap();
    let output;
    let mut operation = Value::Null;
    if matches!(kind, "cherryPick" | "revert") {
        let git_kind = if kind == "cherryPick" {
            "cherry-pick"
        } else {
            "revert"
        };
        let marker = if kind == "cherryPick" {
            "CHERRY_PICK_HEAD"
        } else {
            "REVERT_HEAD"
        };
        let mut args = vec![git_kind];
        let number = action["mainlineParent"].as_u64().map(|v| v.to_string());
        if kind == "revert" {
            args.push("--no-edit");
            if let Some(number) = &number {
                args.extend(["-m", number]);
            }
        }
        args.extend(revisions.iter().map(|v| v.as_str().unwrap()));
        let (success, text) = managed::outcome(cwd, &args, &[], scope).await?;
        output = text;
        let status = status::status(cwd, scope).await?;
        let conflicts = managed::conflicts(&status);
        if !success
            && !managed::succeeds(cwd, &["rev-parse", "--verify", "-q", marker], scope).await?
        {
            bail!("{output}");
        }
        let step = if success {
            revisions.len()
        } else if kind == "cherryPick" {
            let current = history::resolve(cwd, &marker.into(), scope).await.ok();
            scope.check()?;
            current
                .and_then(|hash| revisions.iter().position(|v| v.as_str() == Some(&hash)))
                .map_or(1, |i| i + 1)
        } else {
            1
        };
        operation = json!({"type":git_kind,"state":if success {"completed"}else if !conflicts.is_empty(){"conflicted"}else{"awaiting-user-action"},"originalHead":before,"currentHead":history::resolve(cwd,&"HEAD".into(),scope).await?,"sourceRevisions":revisions,"currentStep":step,"totalSteps":revisions.len(),"conflictedPaths":conflicts});
    } else if kind == "amend" {
        process::run(
            cwd,
            &[
                "update-ref",
                preview["checkpointRef"].as_str().unwrap(),
                &before,
                "",
            ],
            scope,
        )
        .await?;
        let message = action["message"].as_js_string().map(JsString::lossy);
        let args = if let Some(message) = &message {
            vec!["commit", "--amend", "-m", message]
        } else {
            vec!["commit", "--amend", "--no-edit"]
        };
        output = process::run(cwd, &args, scope).await?;
    } else {
        output = process::run(
            cwd,
            &[
                "commit",
                &format!("--fixup={}", revisions[0].as_str().unwrap()),
            ],
            scope,
        )
        .await?;
    }
    checked(
        "gitCommitActionResultSchema",
        &json!({"output":output,"status":status::status(cwd,scope).await?,"headBefore":before,"headAfter":history::resolve(cwd,&"HEAD".into(),scope).await?,"checkpointRef":preview["checkpointRef"].clone(),"operation":operation}),
    )
}
pub fn managed_state(result: &Value) -> Result<Option<Value>> {
    let operation = &result["operation"];
    if operation.is_null() {
        return Ok(None);
    }
    let revisions = operation["sourceRevisions"].as_array().unwrap();
    let pending = if operation["state"] == "completed" {
        Vec::new()
    } else {
        revisions
            .iter()
            .skip(operation["currentStep"].as_u64().unwrap().saturating_sub(1) as usize)
            .cloned()
            .collect()
    };
    let branch = result["status"]["branch"]
        .as_js_string()
        .filter(|s| !s.is_empty())
        .map(|s| {
            JsString::new(
                "refs/heads/"
                    .encode_utf16()
                    .chain(s.units().iter().copied())
                    .collect(),
            )
        });
    Ok(Some(checked(
        "gitManagedOperationWorkerStateSchema",
        &json!({"type":operation["type"].clone(),"originalHead":operation["originalHead"].clone(),"sourceRef":Value::Null,"sourceRevision":revisions.first().cloned().unwrap_or(Value::Null),"targetRef":branch,"targetRevision":operation["originalHead"].clone(),"pendingCommits":pending,"totalSteps":operation["totalSteps"].clone(),"checkpointRef":result["checkpointRef"].clone(),"state":operation["state"].clone(),"currentHead":operation["currentHead"].clone(),"currentStep":operation["currentStep"].clone(),"conflictedPaths":operation["conflictedPaths"].clone(),"output":result["output"].clone(),"status":result["status"].clone()}),
    )?))
}
