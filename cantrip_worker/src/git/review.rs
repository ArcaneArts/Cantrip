//! Existing review guards, canonical fingerprints and bounded Git metadata.
use super::{diff, history, managed, process};
use crate::filesystem::Scope;
use anyhow::{Result, bail};
use cantrip_wire::{JsString, Value, value::json};
use sha2::{Digest, Sha256};
use std::path::Path;
pub(super) fn digest(parts: &[&[u8]]) -> String {
    let mut hash = Sha256::new();
    for bytes in parts {
        hash.update(bytes);
    }
    hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
}
pub(super) async fn workspace(cwd: &Path, scope: &Scope) -> Result<String> {
    let (status, patch) = tokio::join!(
        process::raw(
            cwd,
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            scope
        ),
        process::raw(cwd, &["diff", "--binary", "HEAD"], scope)
    );
    Ok(digest(&[status?.as_bytes(), b"\0", patch?.as_bytes()]))
}
pub(super) fn token(action: &Value, context: &Value, workspace: &str, patch: &JsString) -> String {
    let header = json!({"action":action,"context":context,"workspace":workspace}).stringify();
    digest(&[header.as_bytes(), b"\0", patch.lossy().as_bytes()])
}
pub(super) async fn idle(cwd: &Path, scope: &Scope) -> Result<()> {
    const MESSAGE: &str =
        "Finish or abort the active Git operation before starting another commit action.";
    for marker in ["CHERRY_PICK_HEAD", "REVERT_HEAD", "MERGE_HEAD"] {
        if managed::succeeds(cwd, &["rev-parse", "--verify", "-q", marker], scope).await? {
            bail!(MESSAGE);
        }
    }
    if managed::path_file(cwd, "rebase-merge/head-name", scope)
        .await?
        .is_some()
        || managed::path_file(cwd, "rebase-apply/head-name", scope)
            .await?
            .is_some()
    {
        bail!(MESSAGE);
    }
    if managed::path_file(cwd, "BISECT_START", scope)
        .await?
        .is_some()
    {
        bail!("Finish or reset the active Git bisect before starting another operation.");
    }
    Ok(())
}
pub(super) fn clean(status: &Value, action: &str) -> Result<()> {
    if !status["files"].as_array().unwrap().is_empty() {
        bail!(
            "{action} requires a clean selected worktree. Commit, stash, or discard its changes first."
        );
    }
    Ok(())
}
pub(super) async fn branch(cwd: &Path, scope: &Scope) -> Result<String> {
    let branch = process::text(cwd, &["symbolic-ref", "-q", "HEAD"], scope)
        .await
        .unwrap_or_default();
    scope.check()?;
    if !branch.starts_with("refs/heads/") {
        bail!("This Git operation requires the selected worktree to be on a local branch.");
    }
    Ok(branch)
}
pub(super) async fn range(cwd: &Path, range: &str, scope: &Scope) -> Result<Vec<String>> {
    let output = process::text(cwd, &["rev-list", "--reverse", range], scope).await?;
    let revisions = output
        .split('\n')
        .map(process::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    if revisions.len() > 10_000 {
        bail!("This operation includes more than 10,000 commits. Narrow the selected range first.");
    }
    Ok(revisions)
}
pub(super) async fn summary(cwd: &Path, revision: &str, scope: &Scope) -> Result<Value> {
    let output = process::raw(
        cwd,
        &[
            "show",
            "-s",
            "--date=iso-strict",
            "--format=%H%x00%h%x00%s%x00%an%x00%aI",
            revision,
        ],
        scope,
    )
    .await?;
    let fields = output
        .trim_end_matches(cantrip_wire::text::whitespace)
        .split('\0')
        .collect::<Vec<_>>();
    let f = |index| fields.get(index).copied().unwrap_or("");
    if [0, 1, 3, 4].iter().any(|&i| f(i).is_empty()) {
        return Err(history::message(
            "Commit ",
            &revision.into(),
            " could not be inspected.",
        ));
    }
    Ok(json!({"hash":f(0),"shortHash":f(1),"subject":f(2),"authorName":f(3),"authoredAt":f(4)}))
}
pub(super) async fn summaries(
    cwd: &Path,
    revisions: &[String],
    scope: &Scope,
) -> Result<Vec<Value>> {
    futures::future::try_join_all(
        revisions
            .iter()
            .map(|revision| summary(cwd, revision, scope)),
    )
    .await
}
pub(super) struct Patch {
    pub text: JsString,
    pub truncated: bool,
}
impl Patch {
    pub fn bounded(&self) -> JsString {
        JsString::new(
            self.text
                .units()
                .iter()
                .take(diff::PATCH_LIMIT)
                .copied()
                .collect(),
        )
    }
    pub fn truncated(&self) -> bool {
        self.truncated || self.text.len() > diff::PATCH_LIMIT
    }
}
pub(super) async fn patch(cwd: &Path, args: &[&str], scope: &Scope) -> Result<Patch> {
    let output = process::capture(cwd, args, scope).await?;
    if !output.overflow && output.code != Some(0) {
        bail!("{}", output.error);
    }
    Ok(Patch {
        text: JsString::from(String::from_utf8_lossy(&output.bytes).as_ref()),
        truncated: output.overflow,
    })
}
