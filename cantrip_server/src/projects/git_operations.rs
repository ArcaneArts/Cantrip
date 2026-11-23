//! Durable managed Git state retained for active worker observations.
use crate::{
    database::{Database, Row},
    wire::{Value, value::json},
};
use anyhow::{Context, Result, bail, ensure};
use std::sync::Arc;

pub struct Repository {
    database: Arc<Database>,
}

fn text(value: &Value, key: &str) -> Result<String> {
    Ok(value[key]
        .as_js_string()
        .context("Git operation field")?
        .lossy()
        .into_owned())
}
fn optional_text(value: &Value, key: &str) -> Result<Option<String>> {
    if value[key].is_null() {
        Ok(None)
    } else {
        text(value, key).map(Some)
    }
}
fn timestamp(value: &Value) -> Result<Value> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    let millis = value
        .as_js_string()
        .and_then(crate::wire::date_milliseconds)
        .context("Invalid time value")?;
    Ok(json!(
        crate::wire::date_iso_milliseconds(millis).context("Invalid time value")?
    ))
}
fn record(row: &Row) -> Result<Value> {
    let raw: Value = serde_json::from_str(&row.get::<String>(0)?)?;
    let mut result = Value::Object(Default::default());
    for (key, column) in [
        ("id", "id"),
        ("projectId", "project_id"),
        ("worktreeId", "worktree_id"),
        ("workerId", "worker_id"),
        ("type", "type"),
        ("state", "state"),
        ("originalHead", "original_head"),
        ("currentHead", "current_head"),
        ("sourceRef", "source_ref"),
        ("sourceRevision", "source_revision"),
        ("targetRef", "target_ref"),
        ("targetRevision", "target_revision"),
        ("pendingCommits", "pending_commits"),
        ("currentStep", "current_step"),
        ("totalSteps", "total_steps"),
        ("conflictedPaths", "conflicted_paths"),
        ("output", "output"),
        ("checkpointRef", "checkpoint_ref"),
        ("pausedAction", "paused_action"),
        ("error", "error"),
    ] {
        result[key] = raw[column].clone();
    }
    for (key, column) in [
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
        ("completedAt", "completed_at"),
    ] {
        result[key] = timestamp(&raw[column])?;
    }
    Ok(result)
}
fn first(rows: &[Row]) -> Result<Option<Value>> {
    rows.first().map(record).transpose()
}

pub fn context(operation: &Value) -> Value {
    let mut result = Value::Object(Default::default());
    for key in [
        "type",
        "originalHead",
        "sourceRef",
        "sourceRevision",
        "targetRef",
        "targetRevision",
        "pendingCommits",
        "totalSteps",
        "checkpointRef",
    ] {
        result[key] = operation[key].clone();
    }
    result
}
pub fn terminal(state: &Value) -> bool {
    matches!(state.as_str(), Some("completed" | "failed" | "aborted"))
}
pub fn observation_matches(state: &Value, observation: &Value) -> bool {
    ["state", "currentHead", "currentStep", "totalSteps"]
        .iter()
        .all(|key| state[*key] == observation[*key])
        && state["pendingCommits"].as_array().map(Vec::len)
            == observation["pendingCommitCount"]
                .as_u64()
                .map(|v| v as usize)
        && state["conflictedPaths"].as_array().map(Vec::len)
            == observation["conflictedPathCount"]
                .as_u64()
                .map(|v| v as usize)
        && state.get("pausedAction").unwrap_or(&Value::Null) == &observation["pausedAction"]
}

impl Repository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }

    pub async fn active(
        &self,
        owner: &str,
        project: &str,
        worktree: &str,
    ) -> Result<Option<Value>> {
        first(&self.database.query("SELECT to_jsonb(g)::text FROM git_operations g INNER JOIN projects p ON p.id=g.project_id AND p.owner_id=$1 WHERE g.project_id=$2 AND g.worktree_id=$3 AND g.state IN ('queued','running','conflicted','awaiting-user-action') ORDER BY g.updated_at DESC LIMIT 1", &[&owner,&project,&worktree]).await?)
    }
    pub async fn get(
        &self,
        owner: &str,
        project: &str,
        worktree: &str,
        id: &str,
    ) -> Result<Option<Value>> {
        first(&self.database.query("SELECT to_jsonb(g)::text FROM git_operations g INNER JOIN projects p ON p.id=g.project_id AND p.owner_id=$1 WHERE g.project_id=$2 AND g.worktree_id=$3 AND g.id=$4 LIMIT 1", &[&owner,&project,&worktree,&id]).await?)
    }
    pub async fn latest(
        &self,
        owner: &str,
        project: &str,
        worktree: &str,
    ) -> Result<Option<Value>> {
        first(&self.database.query("SELECT to_jsonb(g)::text FROM git_operations g INNER JOIN projects p ON p.id=g.project_id AND p.owner_id=$1 WHERE g.project_id=$2 AND g.worktree_id=$3 ORDER BY g.updated_at DESC LIMIT 1", &[&owner,&project,&worktree]).await?)
    }
    pub async fn create(
        &self,
        owner: &str,
        project: &str,
        worktree: &str,
        worker: &str,
        input: &Value,
    ) -> Result<Value> {
        if let Some(existing) = self.active(owner, project, worktree).await? {
            bail!(
                "This worktree already has an active {} operation.",
                text(&existing, "type")?
            );
        }
        let id = uuid::Uuid::new_v4().to_string();
        first(&self.database.query("INSERT INTO git_operations(id,owner_id,project_id,worktree_id,worker_id,type,state,original_head,current_head,source_ref,source_revision,target_ref,target_revision,pending_commits,current_step,total_steps,conflicted_paths,output,checkpoint_ref,paused_action) VALUES($1,$2,$3,$4,$5,$6,'queued',$7,$7,$8,$9,$10,$11,$12::jsonb,0,$13,'[]','',$14,NULL) RETURNING to_jsonb(git_operations)::text", &[
            &id,&owner,&project,&worktree,&worker,&text(input,"type")?,&text(input,"originalHead")?,
            &optional_text(input,"sourceRef")?,&optional_text(input,"sourceRevision")?,&optional_text(input,"targetRef")?,&text(input,"targetRevision")?,
            &postgres_types::Json(&input["pendingCommits"]),&(input["totalSteps"].as_i64().context("Git operation steps")? as i32),&optional_text(input,"checkpointRef")?
        ]).await?)?.context("No rows returned while creating Git operation")
    }
    pub async fn mark_running(&self, id: &str) -> Result<Option<Value>> {
        first(&self.database.query("UPDATE git_operations SET state='running',updated_at=$2 WHERE id=$1 AND state='queued' RETURNING to_jsonb(git_operations)::text", &[&id,&crate::auth::now()]).await?)
    }
    pub async fn update(
        &self,
        owner: &str,
        project: &str,
        worktree: &str,
        id: &str,
        state: &Value,
    ) -> Result<Option<Value>> {
        let Some(current) = self.get(owner, project, worktree, id).await? else {
            return Ok(None);
        };
        ensure!(
            [
                "type",
                "originalHead",
                "sourceRef",
                "sourceRevision",
                "targetRef",
                "targetRevision",
                "checkpointRef"
            ]
            .iter()
            .all(|key| current[*key] == state[*key]),
            "Worker operation state does not match its durable record."
        );
        // JS slice counts UTF-16 units. The SQL driver's text conversion then
        // replaces a surrogate split by that boundary, just as node-postgres.
        let mut output = Vec::new();
        for value in [&current["output"], &state["output"]] {
            let value = value.as_js_string().context("Git operation output")?;
            if value.is_empty() {
                continue;
            }
            if !output.is_empty() {
                output.push(u16::from(b'\n'));
            }
            output.extend_from_slice(value.units());
        }
        let output = String::from_utf16_lossy(&output[output.len().saturating_sub(1_000_000)..]);
        let completed = terminal(&state["state"]).then(crate::auth::now);
        let updated = crate::auth::now();
        first(&self.database.query("UPDATE git_operations SET state=$2,current_head=$3,pending_commits=$4::jsonb,current_step=$5,total_steps=$6,conflicted_paths=$7::jsonb,output=$8,paused_action=$9,error=NULL,completed_at=$10,updated_at=$11 WHERE id=$1 RETURNING to_jsonb(git_operations)::text", &[
            &id,&text(state,"state")?,&text(state,"currentHead")?,&postgres_types::Json(&state["pendingCommits"]),
            &(state["currentStep"].as_i64().context("Git operation step")? as i32),&(state["totalSteps"].as_i64().context("Git operation steps")? as i32),
            &postgres_types::Json(&state["conflictedPaths"]),&output,&optional_text(state,"pausedAction")?,&completed,&updated
        ]).await?)
    }
    pub async fn fail(
        &self,
        owner: &str,
        project: &str,
        worktree: &str,
        id: &str,
        error: &crate::wire::value::JsString,
    ) -> Result<Option<Value>> {
        if self.get(owner, project, worktree, id).await?.is_none() {
            return Ok(None);
        }
        let error = String::from_utf16_lossy(&error.units()[..error.len().min(1_000_000)]);
        let completed = crate::auth::now();
        let updated = crate::auth::now();
        first(&self.database.query("UPDATE git_operations SET state='failed',error=$2,completed_at=$3,updated_at=$4 WHERE id=$1 RETURNING to_jsonb(git_operations)::text", &[&id,&error,&completed,&updated]).await?)
    }
}
