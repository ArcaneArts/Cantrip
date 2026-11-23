use super::{Scope, error, paths};
use crate::routing::Registry;
use anyhow::Result;
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};

/// Matches attachWorkspaceRoot: aliases/symlinks are accepted and canonicalized;
/// only opaque canonical-path handles leave this endpoint.
pub async fn attach_root(
    requested: &JsString,
    registry: &Registry,
    scope: &Scope,
) -> Result<Value> {
    scope.check()?;
    let requested = paths::native(&requested.trim());
    if !paths::absolute(&requested) {
        return Err(error(
            "invalid-root",
            "Workspace root must be an absolute path on the worker.",
        ));
    }
    let canonical = paths::canonical(&requested).await.map_err(|_| {
        error(
            "root-unavailable",
            "Workspace root does not exist or is inaccessible.",
        )
    })?;
    let metadata = tokio::fs::metadata(&canonical)
        .await
        .map_err(|_| error("root-unavailable", "Workspace root is inaccessible."))?;
    if !metadata.is_dir() {
        return Err(error("invalid-root", "Workspace root is not a directory."));
    }
    let directory = tokio::fs::read_dir(&canonical)
        .await
        .map_err(|_| error("root-unavailable", "Workspace root is inaccessible."))?;
    drop(directory);
    scope.check()?;
    let protected = registry
        .protect_metadata(
            &json!({"rootPath":paths::text(&canonical),"displayPath":paths::text(&canonical)}),
        )
        .await?;
    checked(
        "workspaceRootAttachmentSchema",
        &json!({"rootPathHandle":protected["rootPath"],"displayHandle":protected["displayPath"]}),
    )
}
