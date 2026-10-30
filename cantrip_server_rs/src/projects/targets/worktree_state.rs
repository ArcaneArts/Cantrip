//! Lifecycle writes and removal constraints retain the reference repository's
//! context admission and transaction boundaries.
use super::{TargetRepository, reads};
use crate::wire::{Value, value::json};
use anyhow::{Context, Result, bail};

impl TargetRepository {
    pub async fn rollback_worktree_creation(
        &self,
        owner: &str,
        project: &str,
        worker: &str,
        created: &Value,
    ) -> Result<bool> {
        let origin = created["origin"]
            .as_str()
            .context("Created worktree origin")?;
        if origin != "agent" && origin != "cantrip" {
            return Ok(false);
        }
        let sources = self.database.query("SELECT s.id FROM project_sources s INNER JOIN projects p ON p.id=s.project_id AND p.owner_id=$1 WHERE p.id=$2 AND s.worker_id=$3 AND s.removed_at IS NULL LIMIT 1", &[&owner,&project,&worker]).await?;
        let Some(source) = sources.first() else {
            return Ok(false);
        };
        let source = source.get::<String>(0)?;
        let id = created["id"].as_str().context("Created worktree id")?;
        let path = created["path"].as_str().context("Created worktree path")?;
        let (id, path, origin, worker) = (
            id.to_owned(),
            path.to_owned(),
            origin.to_owned(),
            worker.to_owned(),
        );
        self.database.transaction(|tx| Box::pin(async move {
            let rows = tx.query("SELECT to_jsonb(w)::text FROM project_worktrees w WHERE id=$1 LIMIT 1", &[&id]).await?;
            let Some(row) = rows.first() else { return Ok(true); };
            let row = reads::parse(row.get(0)?)?;
            if row["project_source_id"] != source.as_str() || row["worker_id"] != worker.as_str() || row["absolute_path"] != path.as_str() || row["is_primary"] == true || row["origin"] != origin.as_str() { return Ok(false); }
            let deleted = tx.query("DELETE FROM project_worktrees WHERE id=$1 AND project_source_id=$2 AND worker_id=$3 AND absolute_path=$4 AND is_primary=false AND origin=$5 RETURNING id", &[&id,&source,&worker,&path,&origin]).await?;
            Ok(deleted.len()==1)
        })).await
    }

    pub async fn set_worktree_lifecycle(
        &self,
        owner: &str,
        project: &str,
        worktree: &str,
        state: &str,
    ) -> Result<Option<Value>> {
        let now = crate::auth::now();
        // Recovery can update a non-executable row, but only through its active
        // source and owning project. Keep that authorization in the mutation.
        let rows = self.database.query("UPDATE project_worktrees w SET lifecycle_state=$1,updated_at=$2 WHERE id=$3 AND project_source_id IN (SELECT s.id FROM project_sources s INNER JOIN projects p ON p.id=s.project_id WHERE p.owner_id=$4 AND p.id=$5 AND s.removed_at IS NULL) RETURNING to_jsonb(w)::text", &[&state,&now,&worktree,&owner,&project]).await?;
        rows.first()
            .map(|row| reads::worktree(&reads::parse(row.get(0)?)?, project))
            .transpose()
    }

    pub async fn observe_worktree(
        &self,
        owner: &str,
        project: &str,
        worktree: &str,
        observed: &Value,
    ) -> Result<Option<Value>> {
        let Some(context) = self.worktree_context(owner, project, worktree).await? else {
            return Ok(None);
        };
        if context["worktree"]["path"] != observed["path"] {
            bail!("Worker status referred to a different worktree path.");
        }
        let now = crate::auth::now();
        let state = if observed["missing"] == true {
            "missing"
        } else if observed["prunable"] == true {
            "prunable"
        } else {
            "ready"
        };
        let observed = postgres_types::Json(observed);
        let rows = self.database.query("UPDATE project_worktrees w SET branch=$1::jsonb->>'branch',detached=($1::jsonb->>'detached')::boolean,head=$1::jsonb->>'head',lifecycle_state=$2,locked=($1::jsonb->>'locked')::boolean,lock_reason=$1::jsonb->>'lockReason',last_scanned_at=$3,updated_at=$3 WHERE id=$4 RETURNING to_jsonb(w)::text", &[&observed,&state,&now,&worktree]).await?;
        rows.first()
            .map(|row| reads::worktree(&reads::parse(row.get(0)?)?, project))
            .transpose()
    }

    pub async fn worktree_removal_blockers(
        &self,
        owner: &str,
        project: &str,
        worktree: &str,
    ) -> Result<Option<Value>> {
        if self
            .worktree_context(owner, project, worktree)
            .await?
            .is_none()
        {
            return Ok(None);
        }
        let ids = async |query: &str| -> Result<Vec<Value>> {
            self.database
                .query(query, &[&worktree])
                .await?
                .iter()
                .map(|row| Ok(Value::String(row.get::<String>(0)?.into())))
                .collect()
        };
        let (chats, leases, terminals, codes) = tokio::try_join!(
            ids(
                "SELECT id FROM chats WHERE active_worktree_id=$1 AND status IN ('running','waiting-for-approval')"
            ),
            ids(
                "SELECT chat_id FROM chat_execution_lanes WHERE worktree_id=$1 AND state <> 'released'"
            ),
            ids(
                "SELECT id FROM terminals WHERE worktree_id=$1 AND status='running' AND kind <> 'run-configuration'"
            ),
            ids("SELECT id FROM code_tabs WHERE worktree_id=$1"),
        )?;
        Ok(Some(
            json!({"activeChatIds":chats,"activeLeaseChatIds":leases,"runningTerminalIds":terminals,"boundCodeTabIds":codes}),
        ))
    }
}
