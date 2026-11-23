use super::*;
impl DiscoveryRepository {
    pub async fn renew_import(&self, claimed: &Value) -> Result<bool> {
        let expires = crate::auth::now() + chrono::Duration::minutes(2);
        let at = crate::auth::now();
        let id = text(&claimed["candidateId"])?;
        let command = text(&claimed["commandId"])?;
        let attempt = claimed["attempt"].stringify();
        Ok(self.database.query("UPDATE workspace_repository_candidates SET import_lease_expires_at=$4,updated_at=$5 WHERE id=$1 AND import_state='importing' AND import_command_id=$2 AND import_attempt=$3::text::integer RETURNING id", &[&id,&command,&attempt,&expires,&at]).await?.len()==1)
    }
    pub async fn block_import(&self, claimed: &Value, error: &Value) -> Result<Value> {
        self.settle_import(claimed, "blocked", error).await
    }
    pub async fn fail_import(&self, claimed: &Value, error: &Value) -> Result<Value> {
        self.settle_import(claimed, "failed", error).await
    }
    async fn settle_import(&self, claimed: &Value, state: &str, error: &Value) -> Result<Value> {
        let (claimed, state, error) = (claimed.clone(), state.to_owned(), error.clone());
        let at = crate::auth::now();
        let row=self.database.transaction(|tx|Box::pin(async move {
            let id=text(&claimed["candidateId"])?;let command=text(&claimed["commandId"])?;let attempt=claimed["attempt"].stringify();let code=text(&error["code"])?;let retryable=error["retryable"].as_bool().context("Import retryability")?;
            let rows=tx.query("UPDATE workspace_repository_candidates SET import_state=$4,import_command_id=NULL,import_error_code=$5,import_error_retryable=$6,import_available_at=NULL,import_lease_expires_at=NULL,updated_at=$7 WHERE id=$1 AND import_state='importing' AND import_command_id=$2 AND import_attempt=$3::text::integer RETURNING job_id", &[&id,&command,&attempt,&state,&code,&retryable,&at]).await?;
            let parent=rows.first().ok_or(DiscoveryError::ImportStale("The repository import attempt is no longer current."))?.get::<String>(0)?;
            let rows=tx.query("UPDATE workspace_repository_discovery_jobs SET state_revision=state_revision+1,updated_at=$2 WHERE id=$1 RETURNING to_jsonb(workspace_repository_discovery_jobs)::text", &[&parent,&at]).await?;
            raw(rows.first().context("Settling repository import")?)
        })).await?;
        job(&row)
    }
    pub async fn recover_imports(
        &self,
        force: bool,
        at: chrono::DateTime<chrono::Utc>,
    ) -> Result<usize> {
        self.database.transaction(|tx|Box::pin(async move {
            let condition=if force {"import_state='importing'"}else{"import_state='importing' AND (import_lease_expires_at IS NULL OR import_lease_expires_at<=$1)"};
            let rows=tx.query(&format!("UPDATE workspace_repository_candidates SET import_state='queued',import_command_id=NULL,import_lease_expires_at=NULL,import_available_at=$1,updated_at=$1 WHERE {condition} RETURNING job_id"), &[&at]).await?;
            let mut seen=std::collections::HashSet::new();
            for row in &rows {
                let parent=row.get::<String>(0)?;
                if seen.insert(parent.clone()) {tx.query("UPDATE workspace_repository_discovery_jobs SET state_revision=state_revision+1,updated_at=$2 WHERE id=$1", &[&parent,&at]).await?;}
            }
            Ok(rows.len())
        })).await
    }
    pub async fn requeue_worker_imports(&self, worker: &str) -> Result<usize> {
        let worker = worker.to_owned();
        let at = crate::auth::now();
        self.database.transaction(|tx|Box::pin(async move {
            let rows=tx.query("UPDATE workspace_repository_candidates SET import_state='queued',import_error_code=NULL,import_error_retryable=NULL,import_available_at=$2,updated_at=$2 WHERE worker_id=$1 AND import_state='blocked' AND import_error_retryable=true RETURNING job_id", &[&worker,&at]).await?;
            let mut seen=std::collections::HashSet::new();
            for row in &rows {
                let parent=row.get::<String>(0)?;
                if seen.insert(parent.clone()) {tx.query("UPDATE workspace_repository_discovery_jobs SET state_revision=state_revision+1,updated_at=$2 WHERE id=$1", &[&parent,&at]).await?;}
            }
            Ok(rows.len())
        })).await
    }
}
