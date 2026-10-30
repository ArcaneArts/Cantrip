use super::*;
impl ReplicaRepository {
    pub async fn recover(&self, force: bool, at: chrono::DateTime<chrono::Utc>) -> Result<usize> {
        let filter = if force {
            "state='running'"
        } else {
            "state='running' AND (lease_expires_at IS NULL OR lease_expires_at<=$1)"
        };
        let progress = progress("queued", 0, at);
        Ok(self.database.query(&format!("UPDATE project_replica_jobs SET state='queued',state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,available_at=$1,progress=$2::text::jsonb,last_error_code=NULL,error_retryable=NULL,updated_at=$1 WHERE {filter} RETURNING id"),&[&at,&progress]).await?.len())
    }
    pub async fn renew(&self, id: &str, command: &str, attempt: f64) -> Result<bool> {
        let at = crate::auth::now();
        let expires = at + chrono::Duration::minutes(2);
        let attempt = Value::Number(attempt).stringify();
        Ok(self.database.query("UPDATE project_replica_jobs SET lease_expires_at=$4,updated_at=$5 WHERE id=$1 AND state='running' AND command_id=$2 AND attempt=$3::text::integer RETURNING id",&[&id,&command,&attempt,&expires,&at]).await?.len()==1)
    }
    pub async fn claim_next(&self) -> Result<Option<Value>> {
        let at = crate::auth::now();
        self.database.transaction(|tx|Box::pin(async move {
            let rows=tx.query("SELECT to_jsonb(j)::text FROM project_replica_jobs j WHERE state='queued' AND available_at<=$1 ORDER BY available_at ASC,created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED",&[&at]).await?;
            let Some(row)=rows.first() else{return Ok(None)};
            let candidate=raw(row)?;let id=text(&candidate["id"])?;let revision=candidate["state_revision"].stringify();let command=uuid::Uuid::new_v4().to_string();let expires=at+chrono::Duration::minutes(2);let progress=progress("dispatching",5,at);
            let rows=tx.query("UPDATE project_replica_jobs SET state='running',state_revision=state_revision+1,attempt=attempt+1,command_id=$2,lease_expires_at=$3,started_at=coalesce(started_at,$4),cancellation_unsafe_at=$4,progress=$5::text::jsonb,last_error_code=NULL,error_retryable=NULL,updated_at=$4 WHERE id=$1 AND state='queued' AND state_revision=$6::text::integer RETURNING to_jsonb(project_replica_jobs)::text",&[&id,&command,&expires,&at,&progress,&revision]).await?;
            let Some(row)=rows.first() else{return Ok(None)};let row=raw(row)?;
            Ok(Some(json!({"ownerId":copy(&row,"owner_id"),"commandId":command,"job":summary(&row)?})))
        })).await
    }
    pub async fn update_progress(
        &self,
        id: &str,
        command: &str,
        attempt: f64,
        update: &Value,
    ) -> Result<Option<Value>> {
        let at = crate::auth::now();
        let expires = at + chrono::Duration::minutes(2);
        let attempt = Value::Number(attempt).stringify();
        let mut update = update.clone();
        update["updatedAt"] = json!(crate::auth::iso(at));
        let update = update.stringify();
        self.database.query("UPDATE project_replica_jobs SET state_revision=state_revision+1,lease_expires_at=$4,progress=$5::text::jsonb,updated_at=$6 WHERE id=$1 AND state='running' AND command_id=$2 AND attempt=$3::text::integer RETURNING to_jsonb(project_replica_jobs)::text",&[&id,&command,&attempt,&expires,&update,&at]).await?.first().map(|r|summary(&raw(r)?)).transpose()
    }
    pub async fn block(&self, id: &str, command: &str, error: &Value) -> Result<Value> {
        self.settle(id, command, "blocked", error).await
    }
    pub async fn fail(&self, id: &str, command: &str, error: &Value) -> Result<Value> {
        self.settle(id, command, "failed", error).await
    }
    async fn settle(&self, id: &str, command: &str, state: &str, error: &Value) -> Result<Value> {
        let (id, command, state, error) = (
            id.to_owned(),
            command.to_owned(),
            state.to_owned(),
            error.clone(),
        );
        let at = crate::auth::now();
        let row=self.database.transaction(|tx|Box::pin(async move {
            let completed=(state=="failed").then_some(at);let progress=progress(&state,if state=="failed"{100}else{0},at);let code=text(&error["code"])?;let retryable=error["retryable"].as_bool().context("Replica retryable flag")?;
            let rows=tx.query("UPDATE project_replica_jobs SET state=$3,state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,cancellation_unsafe_at=CASE WHEN kind='provision' THEN NULL ELSE cancellation_unsafe_at END,completed_at=$4,progress=$5::text::jsonb,last_error_code=$6,error_retryable=$7,updated_at=$8 WHERE id=$1 AND state='running' AND command_id=$2 RETURNING to_jsonb(project_replica_jobs)::text",&[&id,&command,&state,&completed,&progress,&code,&retryable,&at]).await?;
            let row=raw(rows.first().ok_or(ReplicaError::Stale("The replica job attempt is no longer current."))?)?;let project=text(&row["project_id"])?;
            update_project(tx,&project,"failed",Some(&code),at).await?;Ok(row)
        })).await?;
        summary(&row)
    }
    pub async fn retry(&self, owner: &str, id: &str, revision: f64) -> Result<Option<Value>> {
        self.transition(owner, id, revision, false).await
    }
    pub async fn cancel(&self, owner: &str, id: &str, revision: f64) -> Result<Option<Value>> {
        self.transition(owner, id, revision, true).await
    }
    async fn transition(
        &self,
        owner: &str,
        id: &str,
        revision: f64,
        cancel: bool,
    ) -> Result<Option<Value>> {
        let (owner, id, revision) = (
            owner.to_owned(),
            id.to_owned(),
            Value::Number(revision).stringify(),
        );
        let at = crate::auth::now();
        let row=self.database.transaction(|tx|Box::pin(async move {
            let progress=progress(if cancel{"cancelled"}else{"queued"},if cancel{100}else{0},at);
            let sql=if cancel {"UPDATE project_replica_jobs SET state='cancelled',state_revision=state_revision+1,progress=$5::text::jsonb,completed_at=$4,cancellation_unsafe_at=NULL,updated_at=$4 WHERE owner_id=$1 AND id=$2 AND state_revision=$3::text::integer AND state IN ('queued','blocked') AND cancellation_unsafe_at IS NULL RETURNING to_jsonb(project_replica_jobs)::text"} else {"UPDATE project_replica_jobs SET state='queued',state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,available_at=$4,completed_at=NULL,progress=$5::text::jsonb,last_error_code=NULL,error_retryable=NULL,updated_at=$4 WHERE owner_id=$1 AND id=$2 AND state_revision=$3::text::integer AND state IN ('blocked','failed') RETURNING to_jsonb(project_replica_jobs)::text"};
            let rows=tx.query(sql,&[&owner,&id,&revision,&at,&progress]).await?;let Some(row)=rows.first() else{return Ok(None)};let row=raw(row)?;let project=text(&row["project_id"])?;
            update_project(tx,&project,if cancel{"failed"}else{"cloning"},if cancel{Some("cancelled")}else{None},at).await?;Ok(Some(row))
        })).await?;
        row.map(|r| summary(&r)).transpose()
    }
    pub async fn requeue_worker(&self, worker: &str) -> Result<usize> {
        let worker = worker.to_owned();
        let at = crate::auth::now();
        self.database.transaction(|tx|Box::pin(async move {
            let progress=progress("queued",0,at);
            let rows=tx.query("UPDATE project_replica_jobs SET state='queued',state_revision=state_revision+1,available_at=$2,progress=$3::text::jsonb,last_error_code=NULL,error_retryable=NULL,updated_at=$2 WHERE worker_id=$1 AND state='blocked' AND error_retryable=true RETURNING project_id",&[&worker,&at,&progress]).await?;
            let projects=rows.iter().map(|r|r.get::<String>(0)).collect::<Result<std::collections::HashSet<_>>>()?;
            for project in projects {update_project(tx,&project,"cloning",None,at).await?;}Ok(rows.len())
        })).await
    }
}
async fn update_project(
    tx: &crate::database::Transaction<'_>,
    project: &str,
    status: &str,
    error: Option<&str>,
    at: chrono::DateTime<chrono::Utc>,
) -> Result<()> {
    let rows = tx
        .query(
            "SELECT id FROM project_sources WHERE project_id=$1 AND removed_at IS NULL LIMIT 1",
            &[&project],
        )
        .await?;
    if rows.is_empty() {
        tx.query(
            "UPDATE projects SET setup_status=$2,setup_error=$3,updated_at=$4 WHERE id=$1",
            &[&project, &status, &error, &at],
        )
        .await?;
    }
    Ok(())
}
