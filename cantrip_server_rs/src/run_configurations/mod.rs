//! Durable Run configuration lifecycle and worker observation fencing.
pub mod lifecycle;
pub mod observations;
mod operations;
pub mod retirement;
mod secret_writes;
pub mod secrets;
use crate::{
    database::Database,
    wire::{self, Value, value::json},
};
use anyhow::{Context, Result, bail};
use std::sync::Arc;

pub struct Repository {
    database: Arc<Database>,
}
fn raw(text: String) -> Result<Value> {
    Ok(serde_json::from_str(&text)?)
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key].as_str().context("Run configuration field")
}
fn summary(row: &Value) -> Result<Value> {
    let mut result = Value::Object(Default::default());
    for (key, column) in [
        ("id", "id"),
        ("projectId", "project_id"),
        ("configurationId", "configuration_id"),
        ("worktreeId", "worktree_id"),
        ("workerId", "worker_id"),
        ("terminalId", "terminal_id"),
        ("definitionRevision", "definition_revision"),
        ("codexEnvironmentRevision", "codex_environment_revision"),
        ("generation", "generation"),
        ("requestedOperationId", "requested_operation_id"),
        ("state", "state"),
        ("exitCode", "exit_code"),
        ("signal", "signal"),
        ("failure", "failure"),
    ] {
        result[key] = row[column].clone();
    }
    for (key, column) in [
        ("startedAt", "started_at"),
        ("endedAt", "ended_at"),
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
    ] {
        result[key] = if row[column].is_null() {
            Value::Null
        } else {
            Value::String(
                wire::date_iso_milliseconds(
                    row[column]
                        .as_js_string()
                        .and_then(wire::date_milliseconds)
                        .context("Invalid time value")?,
                )
                .context("Invalid time value")?
                .into(),
            )
        };
    }
    Ok(result)
}
impl Repository {
    pub async fn active_identities(&self, owner: &str, worker: &str) -> Result<Vec<Value>> {
        let rows=self.database.query("SELECT to_jsonb(r)::text FROM run_configuration_runtimes r WHERE owner_id=$1 AND worker_id=$2 AND state IN ('starting','running','restarting','stopping') ORDER BY created_at ASC LIMIT 256", &[&owner,&worker]).await?;
        rows.iter()
            .map(|row| {
                let row = raw(row.get(0)?)?;
                let mut result = Value::Object(Default::default());
                for (key, column) in [
                    ("runtimeId", "id"),
                    ("projectId", "project_id"),
                    ("configurationId", "configuration_id"),
                    ("worktreeId", "worktree_id"),
                    ("workerId", "worker_id"),
                    ("definitionRevision", "definition_revision"),
                    ("codexEnvironmentRevision", "codex_environment_revision"),
                    ("generation", "generation"),
                    ("operationId", "requested_operation_id"),
                    ("terminalId", "terminal_id"),
                ] {
                    result[key] = row[column].clone();
                }
                Ok(result)
            })
            .collect()
    }
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    pub async fn get(
        &self,
        owner: &str,
        project: &str,
        configuration: &str,
        worktree: &str,
    ) -> Result<Option<Value>> {
        let rows=self.database.query("SELECT to_jsonb(r)::text FROM run_configuration_runtimes r INNER JOIN projects p ON p.id=r.project_id AND p.owner_id=$1 WHERE r.project_id=$2 AND r.configuration_id=$3 AND r.worktree_id=$4 LIMIT 1", &[&owner,&project,&configuration,&worktree]).await?;
        rows.first()
            .map(|row| summary(&raw(row.get(0)?)?))
            .transpose()
    }
    pub async fn list(
        &self,
        owner: &str,
        project: &str,
        configuration: Option<&str>,
        worktree: Option<&str>,
        limit: i64,
    ) -> Result<Vec<Value>> {
        let configuration = configuration.filter(|v| !v.is_empty());
        let worktree = worktree.filter(|v| !v.is_empty());
        let limit = limit.clamp(1, 256);
        self.database.query("SELECT to_jsonb(r)::text FROM run_configuration_runtimes r INNER JOIN projects p ON p.id=r.project_id AND p.owner_id=$1 WHERE r.project_id=$2 AND ($3::text IS NULL OR r.configuration_id=$3) AND ($4::text IS NULL OR r.worktree_id=$4) ORDER BY (r.state IN ('starting','running','restarting','stopping')) DESC,r.updated_at DESC,r.configuration_id ASC LIMIT $5", &[&owner,&project,&configuration,&worktree,&limit]).await?.iter().map(|row|summary(&raw(row.get(0)?)?)).collect()
    }
    pub async fn delete(&self, owner: &str, project: &str, ids: &[String]) -> Result<usize> {
        if ids.is_empty() {
            return Ok(0);
        }
        Ok(self.database.query("DELETE FROM run_configuration_runtimes WHERE owner_id=$1 AND project_id=$2 AND id=ANY($3::text[]) AND state NOT IN ('starting','running','restarting','stopping') RETURNING id", &[&owner,&project,&ids]).await?.len())
    }
    pub async fn observe(
        &self,
        owner: &str,
        worker: &str,
        observation: &Value,
    ) -> Result<Option<Value>> {
        let (owner, worker, observation) =
            (owner.to_owned(), worker.to_owned(), observation.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let rows=tx.query("SELECT to_jsonb(r)::text FROM run_configuration_runtimes r WHERE id=$1 AND owner_id=$2 LIMIT 1 FOR UPDATE", &[&text(&observation,"runtimeId")?,&owner]).await?;
            let Some(row)=rows.first() else {return Ok(None);}; let current=raw(row.get(0)?)?;
            if current["worker_id"] != worker.as_str(){return Ok(None);}
            for (key,column) in [("projectId","project_id"),("configurationId","configuration_id"),("worktreeId","worktree_id"),("definitionRevision","definition_revision"),("codexEnvironmentRevision","codex_environment_revision"),("terminalId","terminal_id")] {
                if current[column] != observation[key] {bail!("Worker Run configuration state does not match its durable identity.");}
            }
            let unchanged=|reason:&str|->Result<Option<Value>>{Ok(Some(json!({"applied":false,"reason":reason,"runtime":summary(&current)?})))};
            let observed_generation=observation["generation"].as_f64().context("Observed generation")?;
            let generation=current["generation"].as_f64().context("Stored generation")?;
            if observed_generation<generation {return unchanged("stale-generation");}
            if observed_generation>generation {bail!("Worker Run configuration generation is ahead of durable state.");}
            if observation["operationId"] != current["requested_operation_id"] {return unchanged("stale-operation");}
            if observation["state"] == current["state"] {return unchanged("unchanged");}
            let allowed:&[&str]=match text(&current,"state")? {
                "starting"=> &["running","stopping","exited","failed","lost"],
                "running"=> &["stopping","exited","failed","lost"],
                "restarting"=> &["starting","running","stopping","exited","failed","lost"],
                "stopping"=> &["idle","exited","failed","lost"],
                _=> &[],
            };
            if !allowed.contains(&text(&observation,"state")?) {return unchanged("invalid-transition");}
            let observed=postgres_types::Json(observation);
            let now=crate::auth::now(); let generation=generation as i32;
            let rows=tx.query("UPDATE run_configuration_runtimes r SET state=$1::jsonb->>'state',started_at=coalesce(nullif($1::jsonb->>'startedAt','')::timestamptz,started_at),ended_at=nullif($1::jsonb->>'endedAt','')::timestamptz,exit_code=($1::jsonb->>'exitCode')::integer,signal=$1::jsonb->>'signal',failure=nullif($1::jsonb->'failure','null'::jsonb),updated_at=$2 WHERE id=$3 AND owner_id=$4 AND generation=$5 AND requested_operation_id=$6 AND state=$7 RETURNING to_jsonb(r)::text", &[&observed,&now,&text(&current,"id")?,&owner,&generation,&text(&current,"requested_operation_id")?,&text(&current,"state")?]).await?;
            let Some(row)=rows.first() else {bail!("The Run configuration runtime changed during its observation.");};
            Ok(Some(json!({"applied":true,"reason":"applied","runtime":summary(&raw(row.get(0)?)?)?})))
        })).await
    }
}
