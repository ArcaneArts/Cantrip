use super::*;
impl DiscoveryRepository {
    pub async fn claim_scan(&self) -> Result<Option<Value>> {
        let at = crate::auth::now();
        self.database.transaction(|tx|Box::pin(async move {
            let rows=tx.query("SELECT jsonb_build_object('job',to_jsonb(j),'rootPathHandle',s.protected_root_path_handle)::text FROM workspace_repository_discovery_jobs j INNER JOIN project_workspace_storage_profiles s ON s.workspace_id=j.workspace_id AND s.worker_id=j.worker_id AND s.kind='attached' WHERE j.state='queued' AND j.available_at<=$1 ORDER BY j.available_at ASC,j.created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED", &[&at]).await?;
            let Some(row)=rows.first() else {return Ok(None)};let selected=raw(row)?;
            if !crate::wire::coercion::truthy(selected.get("rootPathHandle")) {return Ok(None)};
            let id=text(&selected["job"]["id"])?;let revision=selected["job"]["state_revision"].stringify();let command=uuid::Uuid::new_v4().to_string();let expires=at+chrono::Duration::minutes(2);
            let rows=tx.query("UPDATE workspace_repository_discovery_jobs SET state='running',state_revision=state_revision+1,attempt=attempt+1,command_id=$2,lease_expires_at=$3,started_at=$4,completed_at=NULL,last_error_code=NULL,error_retryable=NULL,updated_at=$4 WHERE id=$1 AND state='queued' AND state_revision=$5::text::integer RETURNING to_jsonb(workspace_repository_discovery_jobs)::text", &[&id,&command,&expires,&at,&revision]).await?;
            let Some(row)=rows.first() else {return Ok(None)};let row=raw(row)?;
            Ok(Some(json!({"commandId":command,"job":job(&row)?,"ownerId":row["owner_id"],"rootPathHandle":selected["rootPathHandle"]})))
        })).await
    }
    pub async fn renew_scan(&self, id: &str, command: &str, attempt: f64) -> Result<bool> {
        let at = crate::auth::now();
        let expires = at + chrono::Duration::minutes(2);
        let attempt = json!(attempt).stringify();
        Ok(self.database.query("UPDATE workspace_repository_discovery_jobs SET lease_expires_at=$4,updated_at=$5 WHERE id=$1 AND state='running' AND command_id=$2 AND attempt=$3::text::integer RETURNING id", &[&id,&command,&attempt,&expires,&at]).await?.len()==1)
    }
    pub async fn block_scan(&self, id: &str, command: &str, error: &Value) -> Result<Value> {
        self.settle_scan(id, command, "blocked", error).await
    }
    pub async fn fail_scan(&self, id: &str, command: &str, error: &Value) -> Result<Value> {
        self.settle_scan(id, command, "failed", error).await
    }
    async fn settle_scan(
        &self,
        id: &str,
        command: &str,
        state: &str,
        error: &Value,
    ) -> Result<Value> {
        let at = crate::auth::now();
        let completed = (state == "failed").then_some(at);
        let code = text(&error["code"])?;
        let retryable = error["retryable"]
            .as_bool()
            .context("Discovery retryable flag")?;
        let rows=self.database.query("UPDATE workspace_repository_discovery_jobs SET state=$3,state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,completed_at=$4,last_error_code=$5,error_retryable=$6,updated_at=$7 WHERE id=$1 AND state='running' AND command_id=$2 RETURNING to_jsonb(workspace_repository_discovery_jobs)::text", &[&id,&command,&state,&completed,&code,&retryable,&at]).await?;
        job(&raw(rows.first().ok_or(DiscoveryError::Stale(
            "The repository discovery attempt is no longer current.",
        ))?)?)
    }
    pub async fn recover_scans(
        &self,
        force: bool,
        at: chrono::DateTime<chrono::Utc>,
    ) -> Result<usize> {
        let condition = if force {
            "state='running'"
        } else {
            "state='running' AND (lease_expires_at IS NULL OR lease_expires_at<=$1)"
        };
        Ok(self.database.query(&format!("UPDATE workspace_repository_discovery_jobs SET state='queued',state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,available_at=$1,last_error_code=NULL,error_retryable=NULL,updated_at=$1 WHERE {condition} RETURNING id"), &[&at]).await?.len())
    }
    pub async fn requeue_worker_scans(&self, worker: &str) -> Result<usize> {
        let at = crate::auth::now();
        Ok(self.database.query("UPDATE workspace_repository_discovery_jobs SET state='queued',state_revision=state_revision+1,available_at=$2,last_error_code=NULL,error_retryable=NULL,updated_at=$2 WHERE worker_id=$1 AND state='blocked' AND error_retryable=true RETURNING id", &[&worker,&at]).await?.len())
    }
}
