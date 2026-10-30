use super::{Repository, raw, summary, text};
use crate::{
    database::Transaction,
    project_layout,
    wire::{Value, value::json},
};
use anyhow::{Context, Result, bail, ensure};

fn active(row: &Value) -> bool {
    matches!(
        row["state"].as_str(),
        Some("starting" | "running" | "restarting" | "stopping")
    )
}
fn operation(row: &Value) -> Result<Value> {
    let runtime = summary(row)?;
    let mut result = Value::Object(Default::default());
    for key in [
        "id",
        "projectId",
        "configurationId",
        "worktreeId",
        "workerId",
        "generation",
        "definitionRevision",
        "codexEnvironmentRevision",
        "createdAt",
    ] {
        result[key] = runtime[key].clone();
    }
    for (key, column) in [
        ("runtimeId", "runtime_id"),
        ("operation", "operation"),
        ("outcome", "outcome"),
    ] {
        result[key] = row[column].clone();
    }
    Ok(result)
}
async fn replay(tx: &Transaction<'_>, owner: &str, input: &Value, row: &Value) -> Result<Value> {
    ensure!(
        row["owner_id"] == owner,
        "The Run configuration operation identity is already in use."
    );
    for (key, column) in [
        ("projectId", "project_id"),
        ("configurationId", "configuration_id"),
        ("worktreeId", "worktree_id"),
        ("workerId", "worker_id"),
        ("operation", "operation"),
        ("definitionRevision", "definition_revision"),
        ("codexEnvironmentRevision", "codex_environment_revision"),
    ] {
        ensure!(
            row[column] == input[key],
            "The Run configuration operation identity is already in use."
        );
    }
    let runtime = if let Some(id) = row["runtime_id"].as_str() {
        tx.query("SELECT to_jsonb(r)::text FROM run_configuration_runtimes r WHERE id=$1 AND owner_id=$2 LIMIT 1", &[&id,&owner]).await?.first().map(|row|summary(&raw(row.get(0)?)?)).transpose()?.unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    Ok(json!({"operation":operation(row)?,"replayed":true,"runtime":runtime}))
}
async fn find_operation(tx: &Transaction<'_>, id: &str) -> Result<Option<Value>> {
    tx.query(
        "SELECT to_jsonb(o)::text FROM run_configuration_runtime_operations o WHERE id=$1 LIMIT 1",
        &[&id],
    )
    .await?
    .first()
    .map(|row| raw(row.get(0)?))
    .transpose()
}
async fn find_runtime(tx: &Transaction<'_>, input: &Value) -> Result<Option<Value>> {
    tx.query("SELECT to_jsonb(r)::text FROM run_configuration_runtimes r WHERE project_id=$1 AND configuration_id=$2 AND worktree_id=$3 LIMIT 1 FOR UPDATE", &[&text(input,"projectId")?,&text(input,"configurationId")?,&text(input,"worktreeId")?]).await?.first().map(|row|raw(row.get(0)?)).transpose()
}
impl Repository {
    pub async fn operation_result(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        let rows = self.database.query("SELECT to_jsonb(o)::text FROM run_configuration_runtime_operations o WHERE id=$1 AND owner_id=$2 LIMIT 1", &[&id,&owner]).await?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let row = raw(row.get(0)?)?;
        let runtime = if let Some(id) = row["runtime_id"].as_str() {
            self.database.query("SELECT to_jsonb(r)::text FROM run_configuration_runtimes r WHERE id=$1 AND owner_id=$2 LIMIT 1", &[&id,&owner]).await?.first().map(|row|summary(&raw(row.get(0)?)?)).transpose()?.unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        Ok(Some(
            json!({"operation":operation(&row)?,"replayed":true,"runtime":runtime}),
        ))
    }

    /// Persist admission and the operation receipt in one transaction. Replays
    /// return current runtime state, while retaining the original receipt.
    pub async fn request_operation(&self, owner: &str, input: &Value) -> Result<Value> {
        let position =
            project_layout::next_position(&self.database, text(input, "projectId")?).await?;
        let (owner, input) = (owner.to_owned(), input.clone());
        self.database
            .transaction(|tx| Box::pin(admit(tx, owner, input, position)))
            .await
    }
}

async fn admit(tx: &Transaction<'_>, owner: String, input: Value, position: i64) -> Result<Value> {
    let id = text(&input, "operationId")?;
    if let Some(row) = find_operation(tx, id).await? {
        return replay(tx, &owner, &input, &row).await;
    }
    let project = text(&input, "projectId")?;
    let worktree = text(&input, "worktreeId")?;
    let worker = text(&input, "workerId")?;
    let configuration = text(&input, "configurationId")?;
    let requested = text(&input, "operation")?;
    let placements=tx.query("SELECT w.worker_id FROM project_worktrees w INNER JOIN project_sources s ON s.id=w.project_source_id INNER JOIN projects p ON p.id=s.project_id AND p.owner_id=$1 WHERE p.id=$2 AND w.id=$3 AND w.worker_id=$4 AND w.lifecycle_state='ready' AND s.removed_at IS NULL LIMIT 1", &[&owner,&project,&worktree,&worker]).await?;
    ensure!(
        !placements.is_empty(),
        "The Run configuration target worktree is not available on that worker."
    );
    let mut current = find_runtime(tx, &input).await?;
    let definition = input["definitionRevision"].as_str();
    let codex = input["codexEnvironmentRevision"].as_str();
    if current.is_none() && requested == "start" {
        let runtime_id = uuid::Uuid::new_v4().to_string();
        tx.query("INSERT INTO run_configuration_runtimes (id,owner_id,project_id,configuration_id,worktree_id,worker_id,definition_revision,codex_environment_revision,generation,requested_operation_id,state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,'idle') ON CONFLICT (project_id,configuration_id,worktree_id) DO NOTHING", &[&runtime_id,&owner,&project,&configuration,&worktree,&worker,&definition,&codex,&id]).await?;
        current = find_runtime(tx, &input).await?;
    }
    if let Some(row) = find_operation(tx, id).await? {
        return replay(tx, &owner, &input, &row).await;
    }
    let mut generation = current
        .as_ref()
        .and_then(|r| r["generation"].as_f64())
        .unwrap_or(0.0) as i32;
    let outcome = match current.as_ref() {
        None => "not-active",
        Some(row) if requested == "start" && active(row) => "already-active",
        Some(row) if requested == "restart" => {
            if active(row) {
                generation += 1;
                "accepted"
            } else {
                "not-active"
            }
        }
        Some(row) if requested == "stop" => {
            if row["state"] == "stopping" {
                "already-stopping"
            } else if active(row) {
                "accepted"
            } else {
                "not-active"
            }
        }
        Some(_) => {
            generation += 1;
            "accepted"
        }
    };
    if let Some(row) = current.as_ref() {
        ensure!(
            !active(row) || row["worker_id"] == worker,
            "The active Run configuration runtime belongs to another worker."
        );
    }
    if let Some(row) = current
        .as_ref()
        .filter(|row| outcome == "accepted" && row["terminal_id"].is_null())
    {
        let runtime_id = text(row, "id")?;
        let inserted=tx.query("INSERT INTO terminals (id,project_id,kind,protected_label,protected_state,position,status,active_worker_id,worktree_id,linked_chat_id,run_configuration_id,run_configuration_runtime_id,service_enabled) VALUES ($1,$2,'run-configuration',NULL,NULL,$3::bigint::integer,'running',$4,$5,NULL,$6,$1,false) ON CONFLICT (id) DO NOTHING RETURNING to_jsonb(terminals)::text", &[&runtime_id,&project,&position,&worker,&worktree,&configuration]).await?;
        let created_terminal = !inserted.is_empty();
        let terminals = if inserted.is_empty() {
            tx.query(
                "SELECT to_jsonb(t)::text FROM terminals t WHERE id=$1 LIMIT 1",
                &[&runtime_id],
            )
            .await?
        } else {
            inserted
        };
        let terminal = terminals
            .first()
            .map(|row| raw(row.get(0)?))
            .transpose()?
            .context("The Run configuration terminal identity belongs to another surface.")?;
        ensure!(
            terminal["project_id"] == project
                && terminal["kind"] == "run-configuration"
                && terminal["active_worker_id"] == worker
                && terminal["worktree_id"] == worktree
                && terminal["run_configuration_id"] == configuration
                && terminal["run_configuration_runtime_id"] == runtime_id,
            "The Run configuration terminal identity belongs to another surface."
        );
        let now = crate::auth::now();
        let bound=tx.query("UPDATE run_configuration_runtimes r SET terminal_id=$1,updated_at=$2 WHERE id=$1 AND owner_id=$3 AND terminal_id IS NULL RETURNING to_jsonb(r)::text", &[&runtime_id,&now,&owner]).await?;
        let bound = bound
            .first()
            .context("Could not bind the Run configuration terminal.")?;
        if created_terminal {
            project_layout::attach_terminal(
                tx,
                project,
                runtime_id,
                &json!({"targetRegion":"bottom"}),
            )
            .await?;
        }
        current = Some(raw(bound.get(0)?)?);
    }
    let runtime_id = current.as_ref().and_then(|row| row["id"].as_str());
    let receipts=tx.query("INSERT INTO run_configuration_runtime_operations (id,owner_id,project_id,configuration_id,worktree_id,runtime_id,worker_id,operation,outcome,generation,definition_revision,codex_environment_revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING RETURNING to_jsonb(run_configuration_runtime_operations)::text", &[&id,&owner,&project,&configuration,&worktree,&runtime_id,&worker,&requested,&outcome,&generation,&definition,&codex]).await?;
    let Some(receipt) = receipts.first() else {
        let raced = find_operation(tx, id)
            .await?
            .context("Could not recover the Run configuration operation.")?;
        return replay(tx, &owner, &input, &raced).await;
    };
    if let Some(row) = current.as_ref().filter(|_| outcome == "accepted") {
        let state = match requested {
            "start" => "starting",
            "restart" => "restarting",
            _ => "stopping",
        };
        let launch = requested != "stop";
        let now = crate::auth::now();
        let previous_generation = row["generation"].as_f64().context("Runtime generation")? as i32;
        let updated=tx.query("UPDATE run_configuration_runtimes r SET worker_id=$1,definition_revision=CASE WHEN $2 THEN $3 ELSE definition_revision END,codex_environment_revision=CASE WHEN $2 THEN $4 ELSE codex_environment_revision END,generation=$5,requested_operation_id=$6,state=$7,started_at=CASE WHEN $2 THEN NULL ELSE started_at END,ended_at=NULL,exit_code=CASE WHEN $2 THEN NULL ELSE exit_code END,signal=CASE WHEN $2 THEN NULL ELSE signal END,failure=CASE WHEN $2 THEN NULL ELSE failure END,updated_at=$8 WHERE id=$9 AND owner_id=$10 AND generation=$11 AND state=$12 RETURNING to_jsonb(r)::text", &[&worker,&launch,&definition,&codex,&generation,&id,&state,&now,&text(row,"id")?,&owner,&previous_generation,&text(row,"state")?]).await?;
        let Some(updated) = updated.first() else {
            bail!("The Run configuration runtime changed during the operation.");
        };
        current = Some(raw(updated.get(0)?)?);
    }
    Ok(
        json!({"operation":operation(&raw(receipt.get(0)?)?)?,"replayed":false,"runtime":current.as_ref().map(summary).transpose()?.unwrap_or(Value::Null)}),
    )
}
