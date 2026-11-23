//! Reviewed managed-operation previews and starts. Rehearsals use actual Git in
//! an owned disposable worktree, with no mutations to the selected checkout.
use super::{editor, history, inspection, managed, process, review, status};
use crate::filesystem::{Scope, paths};
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use indexmap::IndexSet;
use std::path::Path;

async fn normalize(
    cwd: &Path,
    action: &Value,
    upstream: &str,
    head: &str,
    scope: &Scope,
) -> Result<(Value, Vec<Value>, JsString)> {
    if !managed::succeeds(cwd, &["merge-base", "--is-ancestor", upstream, head], scope).await? {
        bail!(
            "Interactive rebase requires an upstream commit that is an ancestor of the current HEAD."
        );
    }
    let revisions = review::range(cwd, &format!("{upstream}..{head}"), scope).await?;
    if revisions.is_empty() {
        bail!("There are no commits after the selected upstream to rewrite.");
    }
    let summaries = review::summaries(cwd, &revisions, scope).await?;
    let todo = action["todo"].as_array().unwrap();
    let todo = if todo.is_empty() {
        revisions
            .iter()
            .map(|revision| json!({"action":"pick","revision":revision,"message":Value::Null}))
            .collect::<Vec<_>>()
    } else {
        todo.clone()
    };
    if todo.len() != revisions.len() {
        bail!("The rebase todo must contain every selected commit once.");
    }
    let expected: IndexSet<_> = revisions.iter().map(String::as_str).collect();
    let mut seen = IndexSet::new();
    let mut retained = 0;
    for item in &todo {
        let revision = item["revision"].as_str().unwrap();
        if !expected.contains(revision) || !seen.insert(revision) {
            bail!("The rebase todo must contain every selected commit exactly once.");
        }
        let action = item["action"].as_str().unwrap();
        if matches!(action, "squash" | "fixup") && retained == 0 {
            bail!("{action} cannot be the first retained step in the rebase todo.");
        }
        if action != "drop" {
            retained += 1;
        }
    }
    if retained == 0 {
        bail!("Interactive rebase must retain at least one commit.");
    }
    let commits = todo
        .iter()
        .map(|item| {
            summaries
                .iter()
                .find(|summary| summary["hash"] == item["revision"])
                .unwrap()
                .clone()
        })
        .collect::<Vec<_>>();
    let todo_text = todo
        .iter()
        .zip(&commits)
        .map(|(item, summary)| {
            format!(
                "{} {} {}",
                item["action"].as_str().unwrap(),
                item["revision"].as_str().unwrap(),
                summary["subject"].as_str().unwrap()
            )
            .trim_end_matches(cantrip_wire::text::whitespace)
            .to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut action = action.clone();
    action["todo"] = json!(todo);
    Ok((action, commits, todo_text.into()))
}
async fn published(cwd: &Path, base: &str, head: &str, scope: &Scope) -> Result<Vec<String>> {
    let output = process::raw(
        cwd,
        &[
            "for-each-ref",
            "--format=%(refname:short)%00%(objectname)%00%(symref)",
            "refs/remotes",
        ],
        scope,
    )
    .await
    .unwrap_or_default();
    let refs = output
        .split('\n')
        .filter(|s| !s.is_empty())
        .filter_map(|line| {
            let fields = line.split('\0').collect::<Vec<_>>();
            (fields.len() >= 2
                && !fields[0].is_empty()
                && !fields[1].is_empty()
                && fields.get(2).is_none_or(|s| s.is_empty()))
            .then(|| (fields[0], fields[1]))
        })
        .take(1000)
        .collect::<Vec<_>>();
    let mut found = IndexSet::new();
    for batch in refs.chunks(16) {
        let results = futures::future::join_all(batch.iter().map(|&(name, revision)| async move {
            let common = process::text(cwd, &["merge-base", head, revision], scope)
                .await
                .unwrap_or_default();
            let yes = !common.is_empty()
                && common != base
                && managed::succeeds(cwd, &["merge-base", "--is-ancestor", base, &common], scope)
                    .await?;
            Ok::<_, anyhow::Error>((name, yes))
        }))
        .await;
        for result in results {
            let (name, yes) = result?;
            if yes {
                found.insert(name.to_owned());
            }
        }
    }
    scope.check()?;
    let collator = status::collator()?;
    let mut found = found.into_iter().collect::<Vec<_>>();
    found.sort_by(|a, b| {
        collator.compare_utf16_icu4c(
            &a.encode_utf16().collect::<Vec<_>>(),
            &b.encode_utf16().collect::<Vec<_>>(),
        )
    });
    Ok(found)
}
fn preview_files(status: &Value) -> Vec<Value> {
    status["files"].as_array().unwrap().iter().map(|file| {
        let pair=format!("{}{}",file["indexStatus"].as_str().unwrap(),file["worktreeStatus"].as_str().unwrap());
        let status=if pair.contains('U')||matches!(pair.as_str(),"AA"|"DD"){"unmerged"}else{inspection::status(if file["indexStatus"]!=" "&&file["indexStatus"]!="?" {file["indexStatus"].as_str().unwrap()}else{file["worktreeStatus"].as_str().unwrap()})};
        json!({"path":file["path"].clone(),"originalPath":file["originalPath"].clone(),"status":status,"additions":Value::Null,"deletions":Value::Null,"binary":false})
    }).collect()
}
struct Effect {
    files: Vec<Value>,
    patch: JsString,
    truncated: bool,
    conflicts: bool,
}
async fn effect(
    cwd: &Path,
    action: &Value,
    head: &str,
    source: &str,
    scope: &Scope,
) -> Result<Effect> {
    let temporary = tempfile::Builder::new()
        .prefix("cantrip-operation-preview-")
        .tempdir()?;
    let path = temporary.path().join("worktree");
    let rewrite = temporary.path().join("rewrite-state");
    let path_text = paths::text(&path);
    let path_text = path_text.lossy();
    let result = async {
        process::run(
            cwd,
            &["worktree", "add", "--detach", &path_text, head],
            scope,
        )
        .await?;
        let kind = action["type"].as_str().unwrap();
        let mut args = vec![
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgSign=false",
        ];
        if kind == "merge" {
            args.extend(["merge", "--no-edit", source]);
        } else {
            args.push("rebase");
            if kind == "interactiveRebase" {
                args.push("--interactive");
            }
            args.push(source);
        }
        let environment = if kind == "interactiveRebase" {
            editor::prepare(&path, action, &Value::Null, Some(&rewrite), scope).await?
        } else {
            editor::environment(&path, &Value::Null, scope).await?
        };
        let mut outcome = managed::outcome(&path, &args, &environment, scope).await?;
        let mut state = status::status(&path, scope).await?;
        let mut conflicts = managed::conflicts(&state);
        if kind == "interactiveRebase" {
            for _ in action["todo"].as_array().unwrap() {
                if !conflicts.is_empty() || !managed::marker(&path, "rebase", scope).await? {
                    break;
                }
                outcome =
                    managed::outcome(&path, &["rebase", "--continue"], &environment, scope).await?;
                state = status::status(&path, scope).await?;
                conflicts = managed::conflicts(&state);
            }
        }
        if !outcome.0 && conflicts.is_empty() {
            bail!("{}", outcome.1);
        }
        if !conflicts.is_empty() {
            let patch =
                review::patch(&path, &["diff", "--binary", "--no-ext-diff", "HEAD"], scope).await?;
            return Ok(Effect {
                files: preview_files(&state),
                patch: patch.bounded(),
                truncated: patch.truncated(),
                conflicts: true,
            });
        }
        let preview_head = history::resolve(&path, &"HEAD".into(), scope).await?;
        let diff_args = ["diff", "--binary", "--no-ext-diff", head, &preview_head];
        let (files, patch) = tokio::join!(
            inspection::files(&path, Some(head), &preview_head, scope),
            review::patch(&path, &diff_args, scope)
        );
        let files = files?;
        let patch = patch?;
        Ok(Effect {
            files: files.files,
            patch: patch.bounded(),
            truncated: files.truncated || patch.truncated(),
            conflicts: false,
        })
    }
    .await;
    // A stopped request still owns its temporary checkout. Cleanup uses a fresh
    // scope so its stop token cannot prevent abort/remove of those owned files.
    let cleanup = Scope::default();
    let _ = managed::outcome(&path, &["merge", "--abort"], &[], &cleanup).await;
    let _ = managed::outcome(&path, &["rebase", "--abort"], &[], &cleanup).await;
    let _ = managed::outcome(
        cwd,
        &["worktree", "remove", "--force", &path_text],
        &[],
        &cleanup,
    )
    .await;
    temporary.close()?;
    result
}
fn context(
    kind: &str,
    head: &str,
    source_ref: &Value,
    source: &str,
    target: &str,
    target_revision: &str,
    pending: Vec<String>,
) -> Value {
    let total = pending.len().max(1);
    json!({"type":kind,"originalHead":head,"sourceRef":source_ref,"sourceRevision":source,"targetRef":target,"targetRevision":target_revision,"pendingCommits":pending,"totalSteps":total,"checkpointRef":Value::Null})
}
async fn bisect(cwd: &Path, action: &Value, scope: &Scope) -> Result<Value> {
    let head = JsString::from("HEAD");
    let (state, head, target, good, bad) = tokio::join!(
        status::status(cwd, scope),
        history::resolve(cwd, &head, scope),
        review::branch(cwd, scope),
        history::resolve(cwd, action["goodRef"].as_js_string().unwrap(), scope),
        history::resolve(cwd, action["badRef"].as_js_string().unwrap(), scope)
    );
    let state = state?;
    let head = head?;
    let target = target?;
    let good = good?;
    let bad = bad?;
    review::clean(&state, "Bisect")?;
    if good == bad {
        bail!("Bisect good and bad revisions must be different.");
    }
    if !managed::succeeds(cwd, &["merge-base", "--is-ancestor", &good, &bad], scope).await? {
        bail!("The known-good revision must be an ancestor of the known-bad revision.");
    }
    let pending = review::range(cwd, &format!("{good}..{bad}"), scope).await?;
    if pending.is_empty() {
        bail!("No commits exist between the selected bisect bounds.");
    }
    let count = pending.len();
    let args = ["diff", "--binary", "--no-ext-diff", &good, &bad];
    let (commits, changed, patch, workspace) = tokio::join!(
        review::summaries(cwd, &pending, scope),
        inspection::files(cwd, Some(&good), &bad, scope),
        review::patch(cwd, &args, scope),
        review::workspace(cwd, scope)
    );
    let commits = commits?;
    let changed = changed?;
    let patch = patch?;
    let workspace = workspace?;
    let mut context = context(
        "bisect",
        &head,
        &action["goodRef"],
        &good,
        &target,
        &bad,
        pending,
    );
    let provisional = review::token(action, &context, &workspace, &patch.text);
    context["checkpointRef"] = json!(format!(
        "refs/cantrip/checkpoints/bisect-{}-{}",
        &head[..12],
        &provisional[..12]
    ));
    let summary = format!(
        "Bisect {count} candidate {} between known-good {} and known-bad {}.",
        if count == 1 { "commit" } else { "commits" },
        &good[..10],
        &bad[..10]
    );
    checked(
        "gitManagedOperationPreviewSchema",
        &json!({"action":action,"token":review::token(action,&context,&workspace,&patch.text),"destructive":false,"summary":summary,"warnings":["Bisect temporarily checks out candidate commits in this worktree. Reset bisect to restore the original branch and HEAD."],"context":context,"commits":commits,"files":changed.files,"patch":patch.bounded(),"patchTruncated":changed.truncated||patch.truncated(),"wouldConflict":false,"todo":Vec::<Value>::new(),"todoText":"","publishedRefs":Vec::<Value>::new()}),
    )
}
pub async fn preview(cwd: &Path, action: &Value, scope: &Scope) -> Result<Value> {
    review::idle(cwd, scope).await?;
    let kind = action["type"].as_str().unwrap();
    if kind == "bisect" {
        return bisect(cwd, action, scope).await;
    }
    let source_ref = &action[if kind == "interactiveRebase" {
        "upstreamRef"
    } else {
        "sourceRef"
    }];
    let head = JsString::from("HEAD");
    let (state, head, target, source) = tokio::join!(
        status::status(cwd, scope),
        history::resolve(cwd, &head, scope),
        review::branch(cwd, scope),
        history::resolve(cwd, source_ref.as_js_string().unwrap(), scope)
    );
    let state = state?;
    let head = head?;
    let target = target?;
    let source = source?;
    review::clean(&state, if kind == "merge" { "Merge" } else { "Rebase" })?;
    if source == head {
        bail!("The selected source already resolves to the current HEAD.");
    }
    let (action, commits, todo_text) = if kind == "interactiveRebase" {
        normalize(cwd, action, &source, &head, scope).await?
    } else {
        let range = if kind == "merge" {
            format!("{head}..{source}")
        } else {
            format!("{source}..{head}")
        };
        let revisions = review::range(cwd, &range, scope).await?;
        (
            action.clone(),
            review::summaries(cwd, &revisions, scope).await?,
            "".into(),
        )
    };
    let pending = commits
        .iter()
        .map(|commit| commit["hash"].as_str().unwrap().to_owned())
        .collect();
    let effect = effect(cwd, &action, &head, &source, scope).await?;
    let published = if kind == "interactiveRebase" {
        published(cwd, &source, &head, scope).await?
    } else {
        Vec::new()
    };
    let mut context = context(
        if kind == "merge" { "merge" } else { "rebase" },
        &head,
        source_ref,
        &source,
        &target,
        &head,
        pending,
    );
    let workspace = review::workspace(cwd, scope).await?;
    let provisional = review::token(&action, &context, &workspace, &effect.patch);
    if kind != "merge" {
        context["checkpointRef"] = json!(format!(
            "refs/cantrip/checkpoints/{}-{}-{}",
            if kind == "interactiveRebase" {
                "rewrite"
            } else {
                "rebase"
            },
            &head[..12],
            &provisional[..12]
        ));
    }
    let token = review::token(&action, &context, &workspace, &effect.patch);
    let branch = target.strip_prefix("refs/heads/").unwrap_or(&target);
    let (prefix, suffix) = match kind {
        "merge" => (
            "Merge ".to_owned(),
            format!(" ({}) into {branch}.", &source[..10]),
        ),
        "interactiveRebase" => (
            format!(
                "Rewrite {} commits on {branch} after ",
                action["todo"].as_array().unwrap().len()
            ),
            format!(" ({}).", &source[..10]),
        ),
        _ => (
            format!("Rebase {branch} onto "),
            format!(" ({}).", &source[..10]),
        ),
    };
    let summary = JsString::new(
        prefix
            .encode_utf16()
            .chain(source_ref.as_js_string().unwrap().units().iter().copied())
            .chain(suffix.encode_utf16())
            .collect(),
    );
    let mut warnings = Vec::new();
    if effect.conflicts {
        warnings.push("The preview found conflicts. Starting leaves the operation resumable in the selected worktree.".to_owned());
    }
    if kind != "merge" {
        warnings.push("Rebase rewrites commit identities. Cantrip creates a recovery reference before it starts.".into());
    }
    if !published.is_empty() {
        warnings.push(format!("This plan rewrites commits already reachable from {} {}. Updating the remote requires a separately reviewed force-with-lease push.",if published.len()==1{"remote-tracking ref"}else{"remote-tracking refs"},published.join(", ")));
    }
    let todo = action
        .get("todo")
        .cloned()
        .unwrap_or_else(|| json!(Vec::<Value>::new()));
    checked(
        "gitManagedOperationPreviewSchema",
        &json!({"action":action,"token":token,"destructive":kind!="merge","summary":summary,"warnings":warnings,"context":context,"commits":commits,"todo":todo,"todoText":todo_text,"publishedRefs":published,"files":effect.files,"patch":effect.patch,"patchTruncated":effect.truncated,"wouldConflict":effect.conflicts}),
    )
}
pub async fn start(cwd: &Path, action: &Value, token: &JsString, scope: &Scope) -> Result<Value> {
    let preview = preview(cwd, action, scope).await?;
    if preview["token"].as_js_string() != Some(token) {
        bail!(
            "The worktree or selected revisions changed after this preview. Review the operation again."
        );
    }
    let context = &preview["context"];
    if let Some(checkpoint) = context["checkpointRef"].as_str() {
        process::run(
            cwd,
            &[
                "update-ref",
                checkpoint,
                context["originalHead"].as_str().unwrap(),
            ],
            scope,
        )
        .await?;
    }
    let action = &preview["action"];
    let kind = action["type"].as_str().unwrap();
    if kind == "bisect" {
        let (success, output) = managed::outcome(
            cwd,
            &[
                "bisect",
                "start",
                context["targetRevision"].as_str().unwrap(),
                context["sourceRevision"].as_str().unwrap(),
            ],
            &[],
            scope,
        )
        .await?;
        let active = managed::marker(cwd, "bisect", scope).await?;
        if !success && !active {
            bail!("{output}");
        }
        return managed::inspect(
            cwd,
            context,
            &output.as_str().into(),
            (!active).then_some("completed"),
            scope,
        )
        .await;
    }
    let source = context["sourceRevision"].as_str().unwrap();
    let args = if kind == "merge" {
        vec!["merge", "--no-edit", source]
    } else if kind == "interactiveRebase" {
        vec!["rebase", "--interactive", source]
    } else {
        vec!["rebase", source]
    };
    let environment = if kind == "interactiveRebase" {
        editor::prepare(cwd, action, context, None, scope).await?
    } else {
        editor::environment(cwd, context, scope).await?
    };
    let (success, output) = managed::outcome(cwd, &args, &environment, scope).await?;
    let active = managed::marker(cwd, context["type"].as_str().unwrap(), scope).await?;
    let state = managed::inspect(
        cwd,
        context,
        &output.as_str().into(),
        (success && !active).then_some("completed"),
        scope,
    )
    .await?;
    if !success && state["state"] == "aborted" {
        editor::cleanup(cwd, context, scope).await?;
        bail!("{output}");
    }
    if matches!(state["state"].as_str(), Some("completed" | "aborted")) {
        editor::cleanup(cwd, context, scope).await?;
    }
    Ok(state)
}
