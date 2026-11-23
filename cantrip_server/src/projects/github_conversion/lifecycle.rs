use super::*;
impl ConversionRepository {
    pub async fn claim_next(&self) -> Result<Option<Value>> {
        let at = crate::auth::now();
        self.database.transaction(|tx|Box::pin(async move {
            let rows=tx.query("SELECT to_jsonb(j)::text FROM project_github_conversion_jobs j INNER JOIN projects p ON p.id=j.project_id AND p.origin_kind='managed-folder' WHERE j.state='queued' AND j.available_at<=$1 ORDER BY j.available_at ASC,j.created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED", &[&at]).await?;
            let Some(row)=rows.first() else {return Ok(None)};
            let row=raw(row)?;let id=text(&row["id"])?;let revision=row["state_revision"].stringify();
            let command=uuid::Uuid::new_v4().to_string();let expires=at+chrono::Duration::minutes(2);
            let rows=tx.query("UPDATE project_github_conversion_jobs SET state='running',state_revision=state_revision+1,attempt=attempt+1,command_id=$2,lease_expires_at=$3,started_at=coalesce(started_at,$4),completed_at=NULL,last_error_code=NULL,error_retryable=NULL,updated_at=$4 WHERE id=$1 AND state='queued' AND state_revision=$5::text::integer RETURNING to_jsonb(project_github_conversion_jobs)::text", &[&id,&command,&expires,&at,&revision]).await?;
            let Some(row)=rows.first() else {return Ok(None)};let row=raw(row)?;
            Ok(Some(json!({"commandId":command,"confirmationToken":row["confirmation_token"],"initialCommit":if crate::wire::coercion::truthy(row.get("initial_commit_message")){json!({"message":row["initial_commit_message"]})}else{Value::Null},"job":summary(&row)?,"ownerId":row["owner_id"],"projectSourceId":row["project_source_id"]})))
        })).await
    }
    pub async fn renew(&self, id: &str, command: &str, attempt: f64) -> Result<bool> {
        let at = crate::auth::now();
        let expires = at + chrono::Duration::minutes(2);
        let attempt = Value::Number(attempt).stringify();
        Ok(self.database.query("UPDATE project_github_conversion_jobs SET lease_expires_at=$4,updated_at=$5 WHERE id=$1 AND state='running' AND command_id=$2 AND attempt=$3::text::integer RETURNING id", &[&id,&command,&attempt,&expires,&at]).await?.len()==1)
    }
    pub async fn block(&self, id: &str, command: &str, error: &Value) -> Result<Value> {
        self.settle(id, command, "blocked", error).await
    }
    pub async fn fail(&self, id: &str, command: &str, error: &Value) -> Result<Value> {
        self.settle(id, command, "failed", error).await
    }
    async fn settle(&self, id: &str, command: &str, state: &str, error: &Value) -> Result<Value> {
        let at = crate::auth::now();
        let completed = (state == "failed").then_some(at);
        let code = text(&error["code"])?;
        let retryable = error["retryable"]
            .as_bool()
            .context("Conversion retryable flag")?;
        let rows=self.database.query("UPDATE project_github_conversion_jobs SET state=$3,state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,completed_at=$4,last_error_code=$5,error_retryable=$6,updated_at=$7 WHERE id=$1 AND state='running' AND command_id=$2 RETURNING to_jsonb(project_github_conversion_jobs)::text", &[&id,&command,&state,&completed,&code,&retryable,&at]).await?;
        summary(&raw(rows.first().ok_or(ConversionError::Stale(
            "The GitHub conversion attempt is no longer current.",
        ))?)?)
    }
    pub async fn retry(&self, owner: &str, project: &str, revision: f64) -> Result<Option<Value>> {
        let at = crate::auth::now();
        let revision = Value::Number(revision).stringify();
        self.database.query("UPDATE project_github_conversion_jobs SET state='queued',state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,available_at=$4,completed_at=NULL,last_error_code=NULL,error_retryable=NULL,updated_at=$4 WHERE owner_id=$1 AND project_id=$2 AND state_revision=$3::text::integer AND state='blocked' AND error_retryable=true RETURNING to_jsonb(project_github_conversion_jobs)::text", &[&owner,&project,&revision,&at]).await?.first().map(|r|summary(&raw(r)?)).transpose()
    }
    pub async fn recover(&self, force: bool, at: chrono::DateTime<chrono::Utc>) -> Result<usize> {
        let filter = if force {
            "state='running'"
        } else {
            "state='running' AND (lease_expires_at IS NULL OR lease_expires_at<=$1)"
        };
        Ok(self.database.query(&format!("UPDATE project_github_conversion_jobs SET state='queued',state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,available_at=$1,last_error_code=NULL,error_retryable=NULL,updated_at=$1 WHERE {filter} RETURNING id"), &[&at]).await?.len())
    }
    pub async fn requeue_worker(&self, worker: &str) -> Result<usize> {
        let at = crate::auth::now();
        Ok(self.database.query("UPDATE project_github_conversion_jobs SET state='queued',state_revision=state_revision+1,available_at=$2,last_error_code=NULL,error_retryable=NULL,updated_at=$2 WHERE worker_id=$1 AND state='blocked' AND error_retryable=true RETURNING id", &[&worker,&at]).await?.len())
    }
}
