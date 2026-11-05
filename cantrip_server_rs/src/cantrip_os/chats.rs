//! Immutable chat placement over the same canonical source and worktree leases.
use super::{Repository, checked, decode, text};
use crate::database::{Executor, Transaction};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};

pub(crate) fn available(source: &Value) -> Result<()> {
    let b = &source["binding"];
    let i = &source["instance"];
    ensure!(
        b["state"] == "ready"
            && i["status"] == "connected"
            && !i["runtimeGeneration"].is_null()
            && b["provisionedAttachmentGeneration"] == i["attachmentGeneration"]
            && b["provisionedRuntimeGeneration"] == i["runtimeGeneration"],
        "The selected OS project binding is unavailable."
    );
    Ok(())
}
pub async fn select(ex: Executor<'_, '_>, owner: &str, project: &str, id: &str) -> Result<Value> {
    let source = Repository::context_with(ex, owner, project, id).await?;
    available(&source)?;
    let rows = decode(
        ex.query(
            "SELECT to_jsonb(t)::text FROM project_worktrees t WHERE t.id=$1",
            &[&text(&source["binding"], "worktreeId")?],
        )
        .await?,
    )?;
    let worktree = rows.first().context("The OS worktree is unavailable.")?;
    ensure!(
        worktree["lifecycle_state"] == "ready",
        "The OS worktree is unavailable."
    );
    Ok(
        json!({"source":source,"selected":{"workerId":source["instance"]["workerId"],"worktree":{"id":worktree["id"],"isPrimary":worktree["is_primary"],"head":worktree["head"]}}}),
    )
}
pub async fn capture(tx: &Transaction<'_>, chat: &str, source: &Value) -> Result<()> {
    let b = &source["binding"];
    let i = &source["instance"];
    tx.query("INSERT INTO cantrip_os_chat_placements(chat_id,binding_id,binding_generation,attachment_generation,runtime_generation) VALUES($1,$2,$3,$4,$5)",&[&chat,&text(b,"id")?,&text(b,"bindingGeneration")?,&text(i,"attachmentGeneration")?,&text(i,"runtimeGeneration")?]).await?;
    Ok(())
}
pub async fn resolve(
    ex: Executor<'_, '_>,
    owner: &str,
    chat: &str,
    worktree: &Value,
) -> Result<Option<Value>> {
    let rows=decode(ex.query("SELECT jsonb_build_object('placement',to_jsonb(p),'project',c.project_id)::text FROM cantrip_os_chat_placements p JOIN chats c ON c.id=p.chat_id AND c.owner_id=$1 WHERE p.chat_id=$2",&[&owner,&chat]).await?)?;
    let Some(row) = rows.first() else {
        ensure!(
            worktree["location_kind"] != "cantrip-os",
            "This Linux source requires an explicit OS chat placement."
        );
        return Ok(None);
    };
    ensure!(
        worktree["lifecycle_state"] == "ready",
        "The OS worktree is unavailable."
    );
    let p = &row["placement"];
    let source =
        Repository::context_with(ex, owner, text(row, "project")?, text(p, "binding_id")?).await?;
    available(&source)?;
    let b = &source["binding"];
    let i = &source["instance"];
    ensure!(
        b["bindingGeneration"] == p["binding_generation"]
            && i["attachmentGeneration"] == p["attachment_generation"]
            && i["runtimeGeneration"] == p["runtime_generation"]
            && b["worktreeId"] == worktree["id"]
            && i["workerId"] == worktree["worker_id"],
        "CantripOS execution placement is unavailable or changed; no host fallback was attempted."
    );
    let execution = execution_for_source(owner, &source, p)?;
    Ok(Some(json!({"cwd":b["guestPath"],"osExecution":execution})))
}

pub(crate) fn execution_for_source(owner: &str, source: &Value, p: &Value) -> Result<Value> {
    let b = &source["binding"];
    let i = &source["instance"];
    let w = &source["workspace"];
    checked(
        "cantripOsExecutionSchema",
        json!({"kind":"cantrip-os","transport":source["transport"],"scope":{"ownerId":owner,"workerId":i["workerId"],"instanceId":i["id"],"guestInstanceId":i["guestInstanceId"],"attachmentGeneration":p["attachment_generation"],"runtimeGeneration":p["runtime_generation"],"bindingId":b["id"],"bindingGeneration":p["binding_generation"],"projectId":b["projectId"],"projectSourceId":b["projectSourceId"],"sourceKind":source["sourceKind"],"worktreeId":b["worktreeId"],"workspaceId":w["id"],"guestWorkspaceId":w["guestWorkspaceId"],"uid":w["uid"],"gid":w["gid"],"homeGuestPath":w["homeGuestPath"],"guestPath":b["guestPath"],"mode":b["mode"],"linkedWorkerPath":b["linkedWorkerPath"],"dependencyOverlays":b["dependencyOverlays"]}}),
    )
}
