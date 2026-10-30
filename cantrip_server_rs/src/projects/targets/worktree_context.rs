//! Owner-scoped execution contexts for protected repository and worktree commands.
use super::{TargetRepository, reads};
use crate::wire::{Value, value::json};
use anyhow::Result;

impl TargetRepository {
    pub async fn worktree_context(
        &self,
        owner: &str,
        project: &str,
        worktree: &str,
    ) -> Result<Option<Value>> {
        let rows = self.database.query(
            "SELECT p.id,s.id,s.absolute_path,w.worker_id,to_jsonb(w)::text FROM project_worktrees w INNER JOIN project_sources s ON s.id=w.project_source_id INNER JOIN projects p ON p.id=s.project_id AND p.owner_id=$1 WHERE p.id=$2 AND w.id=$3 AND s.removed_at IS NULL AND w.lifecycle_state='ready' LIMIT 1",
            &[&owner, &project, &worktree],
        ).await?;
        rows.first().map(|row| {
            let project = row.get::<String>(0)?;
            let worktree = reads::worktree(&reads::parse(row.get(4)?)?, &project)?;
            Ok(json!({"projectId":project,"projectSourceId":row.get::<String>(1)?,"sourcePath":row.get::<String>(2)?,"workerId":row.get::<String>(3)?,"worktree":worktree}))
        }).transpose()
    }

    pub async fn github_context(
        &self,
        owner: &str,
        project: &str,
        worker: Option<&str>,
    ) -> Result<Option<Value>> {
        let rows = self.database.query(
            "SELECT p.github_repository_full_name,p.github_repository_url,s.id,s.worker_id FROM projects p INNER JOIN project_sources s ON s.project_id=p.id WHERE p.id=$1 AND p.owner_id=$2 AND s.removed_at IS NULL AND ($3::text IS NULL OR s.worker_id=$3) ORDER BY s.created_at ASC LIMIT 1",
            &[&project, &owner, &worker.filter(|v| !v.is_empty())],
        ).await?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let name = row.get::<Option<String>>(0)?;
        let url = row.get::<Option<String>>(1)?;
        let (Some(name), Some(url)) = (
            name.filter(|v| !v.is_empty()),
            url.filter(|v| !v.is_empty()),
        ) else {
            return Ok(None);
        };
        let source = row.get::<String>(2)?;
        let worker = row.get::<String>(3)?;
        let provision = self.database.query(
            "SELECT repository FROM project_replica_jobs WHERE owner_id=$1 AND project_id=$2 AND project_replica_id=$3 AND worker_id=$4 AND kind='provision' AND state='succeeded' ORDER BY completed_at DESC LIMIT 1",
            &[&owner, &project, &source, &worker],
        ).await?;
        let provision = provision
            .first()
            .map(|r| r.get::<Option<String>>(0))
            .transpose()?
            .flatten();
        Ok(Some(
            json!({"nameWithOwner":provision.unwrap_or(name),"url":url,"workerId":worker}),
        ))
    }
}
