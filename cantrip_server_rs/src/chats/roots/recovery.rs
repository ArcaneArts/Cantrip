use super::*;

impl Repository {
    pub async fn recover(&self, force: bool, at: DateTime<Utc>) -> Result<usize> {
        self.database.transaction(|tx|Box::pin(async move {
            let filter=if force { "state='running'" } else { "state='running' AND (lease_expires_at IS NULL OR lease_expires_at<=$1)" };
            let rows=tx.query(&format!("UPDATE standalone_chat_root_jobs SET state='queued',state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,available_at=$1,last_error_code=NULL,error_retryable=NULL,updated_at=$1 WHERE {filter} RETURNING id"),&[&at]).await?;
            let matching=matches_root("j");
            tx.query(&format!("UPDATE standalone_chat_root_jobs j SET state='failed',state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,last_error_code='root-conflict',error_retryable=false,completed_at=$1,updated_at=$1 WHERE j.kind='provision' AND j.state='queued' AND NOT({matching})"),&[&at]).await?;
            Ok(rows.len())
        })).await
    }
    pub async fn requeue_worker(&self, worker: &str) -> Result<usize> {
        let at = crate::auth::now();
        Ok(self.database.query("UPDATE standalone_chat_root_jobs SET state='queued',state_revision=state_revision+1,available_at=$2,last_error_code=NULL,error_retryable=NULL,updated_at=$2 WHERE worker_id=$1 AND state='blocked' AND error_retryable=true RETURNING id",&[&worker,&at]).await?.len())
    }
    pub async fn reconciliation_targets(&self, worker: &str) -> Result<Vec<Value>> {
        let rows = self
            .database
            .query(
                "SELECT to_jsonb(r)::text FROM standalone_chat_roots r WHERE worker_id=$1",
                &[&worker],
            )
            .await?;
        rows.iter().map(|row|{
            let row=raw(row)?;
            Ok(json!({"rootId":row["id"],"chatId":row["chat_id"],"archivedAt":date(&row["archived_at"])?,"archiveExpiresAt":date(&row["archive_expires_at"])?}))
        }).collect()
    }
    pub async fn mark_missing(&self, worker: &str, roots: &[String]) -> Result<usize> {
        if roots.is_empty() {
            return Ok(0);
        }
        Ok(self.database.query("UPDATE standalone_chat_roots SET status='failed',updated_at=$3 WHERE worker_id=$1 AND id=ANY($2::text[]) RETURNING id",&[&worker,&roots,&crate::auth::now()]).await?.len())
    }
}
