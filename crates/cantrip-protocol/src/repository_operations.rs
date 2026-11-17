//! Pure metadata and access rules from packages/protocol repository-operation.
//! Authorization and operation execution remain in the server/worker adapters.
use super::{Parsed, ValidationError, Value, value::json};
pub const METADATA_FIELDS: &[&str] = &[
    "branch",
    "canonicalPath",
    "displayPath",
    "existingPath",
    "gitCommonDir",
    "linkPath",
    "lockReason",
    "managedRoot",
    "message",
    "name",
    "nameWithOwner",
    "originalPath",
    "originUrl",
    "path",
    "placementPath",
    "primaryPath",
    "pruneReason",
    "prunedPaths",
    "removedPath",
    "repositoryId",
    "requestedPath",
    "revision",
    "rootPath",
    "sourceDisplayPath",
    "sourcePath",
    "setupError",
    "startPoint",
    "upstream",
    "url",
    "warning",
    "warnings",
    "worktreePath",
];

pub fn operation_access(kind: &str) -> Option<&'static str> {
    match kind {
        "git.history" => Some("read"),
        "git.change-summary" => Some("read"),
        "git.graph.snapshot" => Some("read"),
        "git.graph.metrics" => Some("read"),
        "git.graph.commit-overlay" => Some("read"),
        "git.file.history" => Some("read"),
        "git.file.blame" => Some("read"),
        "git.commit.search" => Some("read"),
        "git.recovery.list" => Some("read"),
        "git.recovery.preview" => Some("read"),
        "git.recovery.apply" => Some("write"),
        "git.commit.get" => Some("read"),
        "git.commit.signature.get" => Some("read"),
        "git.refs.list" => Some("read"),
        "git.compare" => Some("read"),
        "git.revision.diff" => Some("read"),
        "git.status" => Some("read"),
        "git.diff" => Some("read"),
        "git.patch.preview" => Some("read"),
        "git.patch.apply" => Some("write"),
        "git.stash.list" => Some("read"),
        "git.stash.create" => Some("write"),
        "git.stash.diff" => Some("read"),
        "git.stash.action.preview" => Some("read"),
        "git.stash.action.apply" => Some("write"),
        "git.branch.list" => Some("read"),
        "git.branch.action.preview" => Some("read"),
        "git.branch.action.apply" => Some("write"),
        "git.remote.list" => Some("read"),
        "git.remote.action.preview" => Some("read"),
        "git.remote.action.apply" => Some("write"),
        "git.submodule.list" => Some("read"),
        "git.submodule.action.preview" => Some("read"),
        "git.submodule.action.apply" => Some("write"),
        "git.lfs.status" => Some("read"),
        "git.lfs.action.preview" => Some("read"),
        "git.lfs.action.apply" => Some("write"),
        "git.tag.list" => Some("read"),
        "git.tag.get" => Some("read"),
        "git.tag.action.preview" => Some("read"),
        "git.tag.action.apply" => Some("write"),
        "git.commit.action.preview" => Some("read"),
        "git.commit.action.apply" => Some("write"),
        "git.worktree.changes.preview" => Some("read"),
        "git.worktree.changes.apply" => Some("write"),
        "git.operation.current" => Some("read"),
        "git.operation.preview" => Some("read"),
        "git.operation.start" => Some("write"),
        "git.operation.control" => Some("write"),
        "git.operation.amend" => Some("write"),
        "git.conflicts.list" => Some("read"),
        "git.conflicts.get" => Some("read"),
        "git.conflicts.preview" => Some("read"),
        "git.conflicts.apply" => Some("write"),
        "git.action" => Some("write"),
        "git.force-push.preview" => Some("read"),
        "git.force-push.apply" => Some("write"),
        "git.agent.generate" => Some("read"),
        "worktree.status" => Some("read"),
        "repository.metadata.register" => Some("write"),
        "repository.metadata.resolve" => Some("read"),
        "workspace.root.attach" => Some("write"),
        "github.auth.status" => Some("read"),
        "github.repositories.cached" => Some("read"),
        "github.repositories.list" => Some("read"),
        "github.repository-owners.list" => Some("read"),
        "github.repositories.create" => Some("write"),
        "github.issues.list" => Some("read"),
        "github.inbox.list" => Some("read"),
        "github.issue.get" => Some("read"),
        "github.issue.create" => Some("write"),
        "github.issue.comment" => Some("write"),
        "github.issue.close" => Some("write"),
        "github.pull-requests.list" => Some("read"),
        "github.pull-request.get" => Some("read"),
        "github.pull-request.agent-context" => Some("read"),
        "github.pull-request.create" => Some("write"),
        "github.pull-request.comment" => Some("write"),
        "github.pull-request.review.submit" => Some("write"),
        "github.pull-request.review.comment" => Some("write"),
        "github.pull-request.review.reply" => Some("write"),
        "github.pull-request.review.mutate" => Some("write"),
        "github.pull-request.lifecycle.preview" => Some("read"),
        "github.pull-request.lifecycle.apply" => Some("write"),
        "github.pull-request.checkout.prepare" => Some("read"),
        "github.actions.overview" => Some("read"),
        "github.actions.run.get" => Some("read"),
        "github.actions.run.logs" => Some("read"),
        "github.actions.workflow.dispatch" => Some("write"),
        "github.actions.run.action" => Some("write"),
        "github.actions.run.checkout.prepare" => Some("read"),
        "github.releases.list" => Some("read"),
        "github.release.get" => Some("read"),
        "github.release.create" => Some("write"),
        _ => None,
    }
}
pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
) -> Result<bool, ValidationError> {
    if !matches!(
        tag,
        "repository-metadata-fields" | "repository-metadata-count"
    ) {
        return Ok(false);
    }
    let fields = result
        .value
        .as_ref()
        .and_then(Value::as_object)
        .ok_or(ValidationError::Operation)?;
    let (valid, message) = if tag == "repository-metadata-fields" {
        (
            fields.keys().all(|key| {
                key.as_str()
                    .is_some_and(|key| METADATA_FIELDS.contains(&key))
            }),
            "Repository metadata contains an unsupported field.",
        )
    } else {
        (fields.len() <= 64, "Repository metadata is too large.")
    };
    if !valid {
        result.issue(json!({"code":"custom"}), path, message.into(), false);
    }
    Ok(true)
}
