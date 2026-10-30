//! Worker-reported paths are accepted only against the owned bindings that
//! were sent to that worker. Conflicting source resolutions are not applied.
use super::TargetRepository;
use crate::wire::{Value, value::json};
use anyhow::{Context, Result};
use indexmap::IndexMap;
use std::collections::HashSet;

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().context("Observation path field")
}
impl TargetRepository {
    pub async fn observation_context(
        &self,
        owner: &str,
        worker: &str,
        source: &str,
        worktree: &str,
    ) -> Result<Option<Value>> {
        let rows = self.database.query("SELECT p.id,w.root_kind,s.absolute_path,w.worker_id,w.id,w.absolute_path FROM project_worktrees w INNER JOIN project_sources s ON s.id=w.project_source_id INNER JOIN projects p ON p.id=s.project_id AND p.owner_id=$1 WHERE w.worker_id=$2 AND s.source_kind='git' AND w.root_kind='git-worktree' AND s.absolute_path=$3 AND w.absolute_path=$4 AND s.removed_at IS NULL LIMIT 1", &[&owner,&worker,&source,&worktree]).await?;
        rows.first().map(|row| Ok(json!({"projectId":row.get::<String>(0)?,"rootKind":row.get::<String>(1)?,"sourcePath":row.get::<String>(2)?,"workerId":row.get::<String>(3)?,"worktreeId":row.get::<String>(4)?,"worktreePath":row.get::<String>(5)?}))).transpose()
    }

    pub async fn observation_source(
        &self,
        owner: &str,
        project: &str,
        connected: &(dyn Fn(&str) -> bool + Send + Sync),
    ) -> Result<Option<Value>> {
        let rows = self.database.query("SELECT s.id,w.worker_id,w.absolute_path,w.id FROM projects p INNER JOIN project_sources s ON s.project_id=p.id INNER JOIN project_worktrees w ON w.project_source_id=s.id AND w.is_primary=true LEFT JOIN user_settings u ON u.user_id=p.owner_id WHERE p.id=$1 AND p.owner_id=$2 AND s.removed_at IS NULL AND w.lifecycle_state='ready' ORDER BY coalesce(s.worker_id=p.preferred_worker_id,false) DESC,coalesce(s.worker_id=u.default_worker_id,false) DESC,s.created_at ASC,s.id ASC", &[&project,&owner]).await?;
        let values = rows.iter().map(|row| Ok(json!({"projectReplicaId":row.get::<String>(0)?,"workerId":row.get::<String>(1)?,"cwd":row.get::<String>(2)?,"worktreeId":row.get::<String>(3)?}))).collect::<Result<Vec<_>>>()?;
        Ok(values
            .iter()
            .find(|value| connected(value["workerId"].as_str().unwrap()))
            .or(values.first())
            .cloned())
    }

    pub async fn active_observation_operation(
        &self,
        owner: &str,
        project: &str,
        worktree: &str,
    ) -> Result<Option<Value>> {
        let rows = self.database.query("SELECT to_jsonb(g)::text FROM git_operations g INNER JOIN projects p ON p.id=g.project_id AND p.owner_id=$1 WHERE g.project_id=$2 AND g.worktree_id=$3 AND g.state IN ('queued','running','conflicted','awaiting-user-action') ORDER BY g.updated_at DESC LIMIT 1", &[&owner,&project,&worktree]).await?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let operation: Value = serde_json::from_str(&row.get::<String>(0)?)?;
        let mut context = Value::Object(Default::default());
        for (key, column) in [
            ("type", "type"),
            ("originalHead", "original_head"),
            ("sourceRef", "source_ref"),
            ("sourceRevision", "source_revision"),
            ("targetRef", "target_ref"),
            ("targetRevision", "target_revision"),
            ("pendingCommits", "pending_commits"),
            ("totalSteps", "total_steps"),
            ("checkpointRef", "checkpoint_ref"),
        ] {
            context[key] = operation[column].clone();
        }
        Ok(Some(
            json!({"id":operation["id"],"workerId":operation["worker_id"],"context":context}),
        ))
    }

    pub async fn observation_targets(
        &self,
        owner: &str,
        worker: &str,
        git_only: bool,
        limit: i64,
    ) -> Result<Vec<Value>> {
        let condition = if git_only {
            "s.source_kind='git' AND w.root_kind='git-worktree'"
        } else {
            "w.lifecycle_state='ready'"
        };
        let rows = self.database.query(&format!("SELECT p.id,w.root_kind,s.absolute_path,w.worker_id,w.id,w.absolute_path FROM project_worktrees w INNER JOIN project_sources s ON s.id=w.project_source_id INNER JOIN projects p ON p.id=s.project_id AND p.owner_id=$1 WHERE w.worker_id=$2 AND s.removed_at IS NULL AND {condition} ORDER BY w.created_at ASC LIMIT $3"), &[&owner,&worker,&limit.clamp(1,128)]).await?;
        rows.iter()
            .map(|row| {
                Ok(
                    json!({"projectId":row.get::<String>(0)?,"rootKind":row.get::<String>(1)?,
            "sourcePath":row.get::<String>(2)?,"workerId":row.get::<String>(3)?,
            "worktreeId":row.get::<String>(4)?,"worktreePath":row.get::<String>(5)?}),
                )
            })
            .collect()
    }

    pub async fn reconcile_observation_paths(
        &self,
        owner: &str,
        worker: &str,
        input: &[Value],
    ) -> Result<usize> {
        if input.is_empty() {
            return Ok(0);
        }
        let mut requested = IndexMap::new();
        for value in input {
            requested.insert(text(value, "worktreeId")?.to_owned(), value.clone());
        }
        let ids = Value::from_serialize(&requested.keys().collect::<Vec<_>>());
        let now = crate::auth::now();
        let owner = owner.to_owned();
        let worker = worker.to_owned();
        self.database.transaction(|tx| Box::pin(async move {
            let rows = tx.query("SELECT s.project_id,s.id,s.absolute_path,w.id,w.absolute_path FROM project_worktrees w INNER JOIN project_sources s ON s.id=w.project_source_id INNER JOIN projects p ON p.id=s.project_id AND p.owner_id=$1 WHERE s.worker_id=$2 AND w.worker_id=$2 AND w.id IN (SELECT jsonb_array_elements_text($3::jsonb)) AND s.removed_at IS NULL", &[&owner,&worker,&postgres_types::Json(ids)]).await?;
            let mut accepted = Vec::new();
            for row in rows {
                let project = row.get::<String>(0)?;
                let source = row.get::<String>(1)?;
                let source_path = row.get::<String>(2)?;
                let worktree = row.get::<String>(3)?;
                let worktree_path = row.get::<String>(4)?;
                let value = &requested[&worktree];
                if value["projectId"] == project.as_str()
                    && value["expectedSourcePath"] == source_path.as_str()
                    && value["expectedWorktreePath"] == worktree_path.as_str() {
                    accepted.push((source,source_path,worktree,worktree_path,value));
                }
            }
            let mut sources: IndexMap<String,(String,String)> = IndexMap::new();
            let mut inconsistent = HashSet::new();
            for (source,old,_,_,value) in &accepted {
                if inconsistent.contains(source) { continue; }
                let path = text(value,"sourcePath")?;
                if sources.get(source).is_some_and(|(_,existing)| existing != path) {
                    sources.shift_remove(source);
                    inconsistent.insert(source.clone());
                } else { sources.insert(source.clone(),(old.clone(),path.to_owned())); }
            }
            let mut changed = 0;
            for (id,(old,path)) in sources {
                if old == path { continue; }
                changed += tx.query("UPDATE project_sources SET absolute_path=$1,updated_at=$2 WHERE id=$3 AND absolute_path=$4 RETURNING id", &[&path,&now,&id,&old]).await?.len();
            }
            for (_,_,id,old,value) in accepted {
                let path = text(value,"worktreePath")?;
                if old == path { continue; }
                changed += tx.query("UPDATE project_worktrees SET absolute_path=$1,updated_at=$2 WHERE id=$3 AND absolute_path=$4 RETURNING id", &[&path,&now,&id,&old]).await?.len();
            }
            Ok(changed)
        })).await
    }
}
