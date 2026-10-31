use super::*;

impl Repository {
    pub async fn claim_next(&self) -> Result<Option<Value>> {
        let at = crate::auth::now();
        self.database.transaction(|tx|Box::pin(async move {
            let matching=matches_root("j");
            let sql=format!("SELECT to_jsonb(j)::text FROM standalone_chat_root_jobs j WHERE j.state='queued' AND j.available_at<=$1 AND ((j.kind='provision' AND {matching}) OR (j.kind='delete' AND NOT EXISTS(SELECT 1 FROM standalone_chat_root_jobs unsettled_provision WHERE unsettled_provision.root_id=j.root_id AND unsettled_provision.kind='provision' AND unsettled_provision.state IN ('queued','running')))) ORDER BY j.available_at ASC,j.created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED");
            let rows=tx.query(&sql,&[&at]).await?;
            let Some(row)=rows.first() else{return Ok(None)};
            let candidate=raw(row)?;let id=text(&candidate["id"])?;let revision=candidate["state_revision"].stringify();
            let command=uuid::Uuid::new_v4().to_string();let expires=at+chrono::Duration::minutes(2);
            let rows=tx.query("UPDATE standalone_chat_root_jobs SET state='running',state_revision=state_revision+1,attempt=attempt+1,command_id=$2,lease_expires_at=$3,started_at=coalesce(started_at,$4),completed_at=NULL,last_error_code=NULL,error_retryable=NULL,updated_at=$4 WHERE id=$1 AND state='queued' AND state_revision=$5::text::integer RETURNING to_jsonb(standalone_chat_root_jobs)::text",
                &[&id,&command,&expires,&at,&revision]).await?;
            rows.first().map(|row|{let row=raw(row)?;Ok(json!({"ownerId":row["owner_id"],"commandId":command,"job":summary(&row)?}))}).transpose()
        })).await
    }
    pub async fn renew(&self, id: &str, command: &str, attempt: f64) -> Result<bool> {
        let at = crate::auth::now();
        let expiry = at + chrono::Duration::minutes(2);
        let attempt = crate::wire::coercion::string(&Value::Number(attempt))
            .map_err(|_| anyhow::anyhow!("Invalid scratch job attempt"))?
            .lossy()
            .into_owned();
        Ok(self.database.query("UPDATE standalone_chat_root_jobs SET lease_expires_at=$4,updated_at=$5 WHERE id=$1 AND state='running' AND command_id=$2 AND attempt=$3::text::integer RETURNING id",&[&id,&command,&attempt,&expiry,&at]).await?.len()==1)
    }
    pub async fn settle(
        &self,
        id: &str,
        command: &str,
        failed: bool,
        error: &Value,
    ) -> Result<Value> {
        let at = crate::auth::now();
        let state = if failed { "failed" } else { "blocked" };
        let completed = failed.then_some(at);
        let code = text(&error["code"])?;
        let retryable = error["retryable"]
            .as_bool()
            .context("Scratch job retryable flag")?;
        let rows=self.database.query("UPDATE standalone_chat_root_jobs SET state=$3,state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,completed_at=$4,last_error_code=$5,error_retryable=$6,updated_at=$7 WHERE id=$1 AND state='running' AND command_id=$2 RETURNING to_jsonb(standalone_chat_root_jobs)::text",
            &[&id,&command,&state,&completed,&code,&retryable,&at]).await?;
        let row = raw(rows.first().ok_or(RootJobError::Stale(
            "The standalone Chat scratch attempt is no longer current.",
        ))?)?;
        if row["kind"] == "provision" {
            // This update is deliberately outside the job update's commit.
            let root = text(&row["root_id"])?;
            let state = if failed { "failed" } else { "offline" };
            self.database
                .query(
                    "UPDATE standalone_chat_roots SET status=$2,updated_at=$3 WHERE id=$1",
                    &[&root, &state, &at],
                )
                .await?;
        }
        summary(&row)
    }
}
