use super::{query, raw, text};
use crate::{
    database::{Executor, Transaction},
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::Result;

#[derive(Debug)]
pub(super) struct LeaseError {
    pub busy: bool,
    pub message: String,
}
impl std::fmt::Display for LeaseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for LeaseError {}
fn conflict(branch: &str, busy: bool) -> anyhow::Error {
    LeaseError {
        busy,
        message: format!(
            "Logical branch {branch} is already leased by another agent in this project."
        ),
    }
    .into()
}
fn unique(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        if let Some(pg) = cause.downcast_ref::<tokio_postgres::Error>()
            && let Some(code) = pg.code()
            && code.code() == "23505"
        {
            return true;
        }
        if let Some(pglite::Error::Database { sqlstate, .. }) =
            cause.downcast_ref::<pglite::Error>()
            && sqlstate.as_str() == "23505"
        {
            return true;
        }
        let message = cause.to_string().to_lowercase();
        message.contains("project_branch_leases_active_branch_unique")
            || message.contains("duplicate key")
    })
}
pub(super) async fn acquire(
    tx: &Transaction<'_>,
    project: &str,
    chat: &str,
    lane: &str,
    root: &Value,
) -> Result<()> {
    let ex = Executor::Transaction(tx);
    let branch = super::optional(&root["branch"])?;
    let Some(branch) = branch.filter(|s| !s.is_empty()) else {
        if truthy(root.get("detached")) {
            return Ok(());
        }
        if query(
            ex,
            "SELECT id FROM project_sources WHERE project_id=$1 AND removed_at IS NULL LIMIT 2",
            &[&project],
            &[json!(project)],
        )
        .await?
        .len()
            > 1
        {
            return Err(LeaseError{busy:false,message:"The selected replica has not reported its current branch, so Cantrip cannot safely coordinate this turn across workers yet.".to_owned()}.into());
        }
        return Ok(());
    };
    let now = crate::auth::now();
    let rows=query(ex,"SELECT to_jsonb(b)::text FROM project_branch_leases b WHERE chat_execution_lane_id=$1 LIMIT 1",&[&lane],&[json!(lane)]).await?;
    let existing = rows.first().map(raw).transpose()?;
    if let Some(existing) = &existing {
        if existing["project_id"] != project || existing["branch_name"] != branch {
            return Err(conflict(&branch, false));
        }
        if existing["state"] == "active" {
            return Ok(());
        }
    }
    let holders=query(ex,"SELECT jsonb_build_object('id',b.id,'chat_id',l.chat_id)::text FROM project_branch_leases b LEFT JOIN chat_execution_lanes l ON l.id=b.chat_execution_lane_id WHERE b.project_id=$1 AND b.branch_name=$2 AND b.state='active' LIMIT 1",&[&project,&branch],&[json!(project),json!(branch)]).await?;
    if let Some(holder) = holders.first().map(raw).transpose()? {
        if holder["chat_id"] != chat {
            return Err(conflict(&branch, true));
        }
        let id = text(&holder["id"])?;
        query(ex,"UPDATE project_branch_leases SET state='released',released_at=$1,updated_at=$1 WHERE id=$2",&[&now,&id],&[json!(crate::auth::iso(now)),json!(id)]).await?;
    }
    let worker = text(&root["worker_id"])?;
    let worktree = text(&root["id"])?;
    let result = if let Some(existing) = existing {
        let id = text(&existing["id"])?;
        query(ex,"UPDATE project_branch_leases SET state='active',worker_id=$1,worktree_id=$2,released_at=NULL,updated_at=$3 WHERE id=$4",&[&worker,&worktree,&now,&id],&[json!(worker),json!(worktree),json!(crate::auth::iso(now)),json!(id)]).await
    } else {
        let id = uuid::Uuid::new_v4().to_string();
        query(ex,"INSERT INTO project_branch_leases(id,project_id,branch_name,chat_execution_lane_id,worktree_id,worker_id,state) VALUES($1,$2,$3,$4,$5,$6,'active')",&[&id,&project,&branch,&lane,&worktree,&worker],&[json!(id),json!(project),json!(branch),json!(lane),json!(worktree),json!(worker)]).await
    };
    match result {
        Err(error) if unique(&error) => Err(conflict(&branch, true)),
        other => other.map(|_| ()),
    }
}
pub(super) async fn release(tx: &Transaction<'_>, lane: &str) -> Result<()> {
    let now = crate::auth::now();
    query(Executor::Transaction(tx),"UPDATE project_branch_leases SET state='released',released_at=$1,updated_at=$1 WHERE chat_execution_lane_id=$2 AND state='active'",&[&now,&lane],&[json!(crate::auth::iso(now)),json!(lane)]).await?;
    Ok(())
}
