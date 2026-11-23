//! File surfaces capture the same immutable Linux authority as agent turns.
use super::{Repository, chats, text};
use crate::database::Executor;
use anyhow::{Result, ensure};
use serde_json::{Value, json};

pub async fn capture(
    ex: Executor<'_, '_>,
    owner: &str,
    project: &str,
    tree: &str,
    binding: &str,
    expected: &str,
) -> Result<Value> {
    let selected = chats::select(ex, owner, project, binding).await?;
    let source = &selected["source"];
    ensure!(
        source["binding"]["worktreeId"] == tree
            && source["instance"]["runtimeGeneration"] == expected,
        "The selected OS file source is unavailable or belongs to another worktree."
    );
    Ok(
        json!({"binding_id":binding,"binding_generation":source["binding"]["bindingGeneration"],"attachment_generation":source["instance"]["attachmentGeneration"],"runtime_generation":expected,"worker_id":source["instance"]["workerId"]}),
    )
}

pub async fn root(
    ex: Executor<'_, '_>,
    owner: &str,
    project: &str,
    tree: &str,
    worker: &str,
    captured: &Value,
) -> Result<crate::wire::Value> {
    // Resolve current worktree authority even for a host-only surface.
    let rows = super::decode(ex.query("SELECT to_jsonb(t)::text FROM project_worktrees t JOIN project_source_identities s ON s.id=t.project_source_id AND s.project_id=$1 WHERE t.id=$2 AND t.worker_id=$3", &[&project,&tree,&worker]).await?)?;
    let t = rows
        .first()
        .ok_or_else(|| anyhow::anyhow!("File checkout is unavailable."))?;
    if captured["binding_id"].is_null() {
        ensure!(
            t["location_kind"] == "worker-local",
            "This Linux source requires an explicit file placement; no host fallback was attempted."
        );
        return Ok(crate::wire::Value::from_serialize(&Value::String(
            text(t, "absolute_path")?.to_owned(),
        )));
    }
    ensure!(
        t["lifecycle_state"] == "ready",
        "The OS worktree is unavailable."
    );
    let source =
        Repository::context_with(ex, owner, project, text(captured, "binding_id")?).await?;
    chats::available(&source)?;
    ensure!(
        source["binding"]["worktreeId"] == tree
            && source["instance"]["workerId"] == worker
            && source["binding"]["bindingGeneration"] == captured["binding_generation"]
            && source["instance"]["attachmentGeneration"] == captured["attachment_generation"]
            && source["instance"]["runtimeGeneration"] == captured["runtime_generation"],
        "The file resource differs from its captured OS source; no host fallback was attempted."
    );
    Ok(crate::wire::Value::from_serialize(
        &chats::execution_for_source(owner, &source, captured)?,
    ))
}
