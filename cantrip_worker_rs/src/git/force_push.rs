use super::{history, process, review, status};
use crate::filesystem::Scope;
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{Value, value::json};
use std::path::Path;

const COMMIT_LIMIT: usize = 100;

struct CommitRange {
    commits: Vec<Value>,
    count: usize,
}

async fn commit_range(cwd: &Path, range: &str, scope: &Scope) -> Result<CommitRange> {
    let limit = format!("--max-count={}", COMMIT_LIMIT + 1);
    let (count, revisions) = tokio::try_join!(
        async { process::text(cwd, &["rev-list", "--count", range], scope).await },
        async { process::text(cwd, &["rev-list", "--reverse", &limit, range], scope).await },
    )?;
    let revisions = revisions
        .lines()
        .take(COMMIT_LIMIT)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    Ok(CommitRange {
        commits: review::summaries(cwd, &revisions, scope).await?,
        count: count.parse()?,
    })
}

async fn merge_base_matches(cwd: &Path, args: &[&str], scope: &Scope) -> Result<bool> {
    let result = process::capture(cwd, args, scope).await?;
    match (result.code, result.overflow) {
        (Some(0), false) => Ok(true),
        (Some(1), false) => Ok(false),
        _ => bail!("{}", result.error),
    }
}

pub(super) async fn preview(cwd: &Path, scope: &Scope) -> Result<Value> {
    review::idle(cwd, scope).await?;
    let current = status::status(cwd, scope).await?;
    let Some(local_branch) = current["branch"]
        .as_str()
        .filter(|branch| !branch.is_empty())
    else {
        bail!("Cannot force-push a detached HEAD.");
    };
    let Some(upstream) = current["upstream"].as_str() else {
        bail!("This branch has no upstream. Publish it with a normal push first.");
    };
    // An abbreviated upstream cannot disambiguate a slash in a remote name
    // from a slash in the branch name. Ask Git for the configured pieces.
    let local_ref = format!("refs/heads/{local_branch}");
    let target = process::text(
        cwd,
        &[
            "for-each-ref",
            "--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)",
            &local_ref,
        ],
        scope,
    )
    .await?;
    let mut fields = target.split('\0');
    let remote = fields.next().unwrap_or_default();
    if remote.is_empty() || remote == "." {
        bail!("Upstream {upstream} is not owned by a configured remote.");
    }
    let remote_ref = fields.next().unwrap_or_default();
    let Some(remote_branch) = remote_ref
        .strip_prefix("refs/heads/")
        .filter(|n| !n.is_empty())
    else {
        bail!("The upstream branch name is invalid.");
    };
    for branch in [local_branch, remote_branch] {
        process::run(cwd, &["check-ref-format", "--branch", branch], scope).await?;
    }

    let default_tracking_ref = format!("refs/remotes/{remote}/{remote_branch}");
    let tracking_ref = fields
        .next()
        .filter(|name| name.starts_with("refs/remotes/"))
        .unwrap_or(&default_tracking_ref);
    let refspec = format!("+{remote_ref}:{tracking_ref}");
    process::run(
        cwd,
        &["fetch", "--no-tags", "--refmap=", "--", remote, &refspec],
        scope,
    )
    .await?;
    let local_ref = local_ref.into();
    let tracking_ref = tracking_ref.into();
    let (local_head, expected_remote_head) = tokio::try_join!(
        history::resolve(cwd, &local_ref, scope),
        history::resolve(cwd, &tracking_ref, scope),
    )?;
    if merge_base_matches(
        cwd,
        &[
            "merge-base",
            "--is-ancestor",
            &expected_remote_head,
            &local_head,
        ],
        scope,
    )
    .await?
    {
        bail!("The remote branch is an ancestor of this branch. Use a normal push.");
    }
    if merge_base_matches(
        cwd,
        &[
            "merge-base",
            "--is-ancestor",
            &local_head,
            &expected_remote_head,
        ],
        scope,
    )
    .await?
    {
        bail!(
            "This branch has no replacement commits and is only behind its remote. Pull or rebase instead."
        );
    }
    let outgoing = format!("{expected_remote_head}..{local_head}");
    let replaced = format!("{local_head}..{expected_remote_head}");
    let (local, previous, common_base) = tokio::try_join!(
        commit_range(cwd, &outgoing, scope),
        commit_range(cwd, &replaced, scope),
        async {
            merge_base_matches(
                cwd,
                &["merge-base", &local_head, &expected_remote_head],
                scope,
            )
            .await
        },
    )?;
    if previous.count == 0 {
        bail!("The remote branch has no commits to replace. Use a normal push.");
    }

    let target = format!("{remote}/{remote_branch}");
    let mut warnings = Vec::new();
    if !common_base {
        warnings.push(
            "The local and remote histories are unrelated. This replacement is especially destructive."
                .to_owned(),
        );
    }
    let commits = if previous.count == 1 {
        "commit"
    } else {
        "commits"
    };
    warnings.push(format!(
        "{} remote {commits} will no longer be reachable from {target}.",
        previous.count
    ));
    warnings.push(format!(
        "The lease is pinned to remote commit {}. The push will fail safely if the remote moves after this preview.",
        &expected_remote_head[..12]
    ));
    let reviewed = json!({
        "localBranch": local_branch,
        "localHead": local_head,
        "remote": remote,
        "remoteBranch": remote_branch,
        "expectedRemoteHead": expected_remote_head,
    });
    let token = review::digest(&[reviewed.stringify().as_bytes()]);
    checked(
        "gitForcePushPreviewSchema",
        &json!({
            "token": token,
            "destructive": true,
            "summary": format!("Replace {target} with {local_branch} using force-with-lease."),
            "warnings": warnings,
            "remote": remote,
            "localBranch": local_branch,
            "remoteBranch": remote_branch,
            "localHead": local_head,
            "expectedRemoteHead": expected_remote_head,
            "localCommits": local.commits,
            "localCommitCount": local.count,
            "localCommitsTruncated": local.count > COMMIT_LIMIT,
            "remoteCommits": previous.commits,
            "remoteCommitCount": previous.count,
            "remoteCommitsTruncated": previous.count > COMMIT_LIMIT,
        }),
    )
}

pub(super) async fn apply(cwd: &Path, token: &str, scope: &Scope) -> Result<Value> {
    let reviewed = preview(cwd, scope).await?;
    if reviewed["token"] != token {
        bail!("The local or remote branch moved after this preview. Review the force push again.");
    }
    let remote = reviewed["remote"].as_str().unwrap();
    let branch = reviewed["remoteBranch"].as_str().unwrap();
    let local_head = reviewed["localHead"].as_str().unwrap();
    let expected = reviewed["expectedRemoteHead"].as_str().unwrap();
    let lease = format!("--force-with-lease=refs/heads/{branch}:{expected}");
    // Pass the reviewed object rather than HEAD, which can move outside the worker.
    let refspec = format!("{local_head}:refs/heads/{branch}");
    let output = process::run(
        cwd,
        &["push", "--no-follow-tags", &lease, "--", remote, &refspec],
        scope,
    )
    .await?;
    checked(
        "gitActionResultSchema",
        &json!({"status": status::status(cwd, scope).await?, "output": output}),
    )
}
