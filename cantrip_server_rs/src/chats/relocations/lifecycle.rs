use super::*;
impl Repository {
    pub async fn recover(&self, force: bool, at: DateTime<Utc>) -> Result<usize> {
        self.database.query(&format!("UPDATE chats c SET status='idle',updated_at=$1 WHERE c.status='failed' AND EXISTS(SELECT 1 FROM chat_relocation_jobs j WHERE j.chat_id=c.id AND j.state IN {ACTIVE})"),&[&at]).await?;
        let p = progress("recovering", json!(0), at).stringify();
        Ok(self.database.query(&format!("UPDATE chat_relocation_jobs SET state='queued',state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,cancellation_unsafe_at=NULL,available_at=$1,progress=$2::text::jsonb,updated_at=$1 WHERE state IN {RUNNING} AND ($3 OR lease_expires_at IS NULL OR lease_expires_at<=$1) RETURNING id"),&[&at,&p,&force]).await?.len())
    }
    pub async fn renew(&self, id: &str, command: &str, attempt: f64) -> Result<bool> {
        let at = crate::auth::now();
        let expires = at + chrono::Duration::minutes(2);
        let attempt = Value::Number(attempt).stringify();
        Ok(self.database.query(&format!("UPDATE chat_relocation_jobs SET lease_expires_at=$4,updated_at=$5 WHERE id=$1 AND command_id=$2 AND attempt=$3::text::integer AND state IN {RUNNING} RETURNING id"),&[&id,&command,&attempt,&expires,&at]).await?.len()==1)
    }
    pub async fn requeue_worker(&self, worker: &str) -> Result<usize> {
        let at = crate::auth::now();
        let p = progress("queued", json!(0), at).stringify();
        Ok(self.database.query("UPDATE chat_relocation_jobs SET state='queued',state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,available_at=$2,progress=$3::text::jsonb,last_error_code=NULL,error_retryable=NULL,updated_at=$2 WHERE state='blocked' AND error_retryable=true AND (source_placement->>'workerId'=$1 OR target_placement->>'workerId'=$1) RETURNING id",&[&worker,&at,&p]).await?.len())
    }
    pub async fn claim_next(&self) -> Result<Option<Value>> {
        let at = crate::auth::now();
        let candidates=self.database.query("SELECT jsonb_build_object('job',to_jsonb(j),'chatStatus',c.status)::text FROM chat_relocation_jobs j INNER JOIN chats c ON c.id=j.chat_id WHERE j.state IN ('queued','waiting-for-idle') AND j.available_at<=$1 ORDER BY j.available_at ASC,j.created_at ASC LIMIT 20",&[&at]).await?;
        for candidate in candidates {
            let c = raw(&candidate)?;
            let j = &c["job"];
            let id = text(&j["id"])?;
            let revision = j["state_revision"].stringify();
            if j["state"] == "waiting-for-idle" {
                if c["chatStatus"] == "running" || c["chatStatus"] == "waiting-for-approval" {
                    continue;
                }
                if snapshots::refresh(&self.database, id.clone())
                    .await
                    .is_err()
                {
                    let p = progress("failed", json!(100), at).stringify();
                    self.database.query("UPDATE chat_relocation_jobs SET state='failed',state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,progress=$4::text::jsonb,last_error_code='stale-attempt',error_retryable=false,completed_at=$3,updated_at=$3 WHERE id=$1 AND state_revision=$2::text::integer AND state='waiting-for-idle'",&[&id,&revision,&at,&p]).await?;
                    continue;
                }
            }
            let command = uuid::Uuid::new_v4().to_string();
            let expires = at + chrono::Duration::minutes(2);
            let p = progress("validating", json!(5), at).stringify();
            let started = optional(&j["started_at"])?
                .map(|s| s.parse::<DateTime<Utc>>())
                .transpose()?
                .unwrap_or(at);
            let rows=self.database.query("UPDATE chat_relocation_jobs SET state='validating',state_revision=state_revision+1,attempt=attempt+1,command_id=$3,started_at=$4,lease_expires_at=$5,progress=$6::text::jsonb,last_error_code=NULL,error_retryable=NULL,updated_at=$7 WHERE id=$1 AND state_revision=$2::text::integer AND state IN ('queued','waiting-for-idle') RETURNING to_jsonb(chat_relocation_jobs)::text",&[&id,&revision,&command,&started,&expires,&p,&at]).await?;
            let Some(row) = rows.first().map(raw).transpose()? else {
                continue;
            };
            let owner = text(&row["owner_id"])?;
            let snapshot = self
                .snapshot(&owner, &id)
                .await?
                .ok_or_else(|| Error::NotFound("Relocation context snapshot not found.".into()))?;
            return Ok(Some(
                json!({"commandId":command,"job":mapping::job(&row)?,"ownerId":owner,"snapshot":snapshot}),
            ));
        }
        Ok(None)
    }
    pub async fn advance(
        &self,
        id: &str,
        command: &str,
        attempt: f64,
        transition: Advance<'_>,
    ) -> Result<Value> {
        let Advance {
            from,
            to,
            progress: next,
            options,
        } = transition;
        let at = crate::auth::now();
        let expires = at + chrono::Duration::minutes(2);
        let attempt = Value::Number(attempt).stringify();
        let mut p = next.clone();
        p["updatedAt"] = json!(crate::auth::iso(at));
        let p = p.stringify();
        let unsafe_cancel = crate::wire::coercion::truthy(options.get("cancellationUnsafe"));
        let thread = options
            .get("targetRuntimeThreadId")
            .filter(|v| crate::wire::coercion::truthy(Some(v)))
            .map(text)
            .transpose()?;
        let model = options
            .get("targetModelRouteId")
            .filter(|v| crate::wire::coercion::truthy(Some(v)))
            .map(text)
            .transpose()?;
        let has_account = options.get("targetProviderAccountId").is_some();
        let account = optional(&options["targetProviderAccountId"])?;
        let rows=self.database.query("UPDATE chat_relocation_jobs SET state=$5,state_revision=state_revision+1,lease_expires_at=$13,progress=$12::text::jsonb,cancellation_unsafe_at=CASE WHEN $7 THEN $6 ELSE cancellation_unsafe_at END,target_runtime_thread_id=coalesce($8,target_runtime_thread_id),target_model_route_id=coalesce($9,target_model_route_id),target_provider_account_id=CASE WHEN $10 THEN $11 ELSE target_provider_account_id END,updated_at=$6 WHERE id=$1 AND command_id=$2 AND attempt=$3::text::integer AND state=$4 RETURNING to_jsonb(chat_relocation_jobs)::text",&[&id,&command,&attempt,&from,&to,&at,&unsafe_cancel,&thread,&model,&has_account,&account,&p,&expires]).await?;
        mapping::job(&first(&rows)?)
    }
    pub async fn fail(
        &self,
        id: &str,
        command: &str,
        attempt: f64,
        error: &Value,
    ) -> Result<Value> {
        let at = crate::auth::now();
        let attempt = Value::Number(attempt).stringify();
        let current=self.database.query(&format!("SELECT to_jsonb(j)::text FROM chat_relocation_jobs j WHERE id=$1 AND command_id=$2 AND attempt=$3::text::integer AND state IN {RUNNING} LIMIT 1"),&[&id,&command,&attempt]).await?;
        let current = mapping::job(&first(&current)?)?;
        let retryable = error["retryable"]
            .as_bool()
            .context("Relocation error retryable")?;
        let state = if retryable { "blocked" } else { "failed" };
        let p = progress(
            state,
            if retryable {
                current["progress"]["percent"].clone()
            } else {
                json!(100)
            },
            at,
        )
        .stringify();
        let completed = (!retryable).then_some(at);
        let code = text(&error["code"])?;
        let rows=self.database.query(&format!("UPDATE chat_relocation_jobs SET state=$4,state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,progress=$5::text::jsonb,last_error_code=$6,error_retryable=$7,completed_at=$8,updated_at=$9 WHERE id=$1 AND command_id=$2 AND attempt=$3::text::integer AND state IN {RUNNING} RETURNING to_jsonb(chat_relocation_jobs)::text"),&[&id,&command,&attempt,&state,&p,&code,&retryable,&completed,&at]).await?;
        mapping::job(&first(&rows)?)
    }
    pub async fn cancel(&self, owner: &str, id: &str, revision: f64) -> Result<Value> {
        self.control(owner, id, revision, false).await
    }
    pub async fn retry(&self, owner: &str, id: &str, revision: f64) -> Result<Value> {
        self.control(owner, id, revision, true).await
    }
    async fn control(&self, owner: &str, id: &str, revision: f64, retry: bool) -> Result<Value> {
        let at = crate::auth::now();
        let revision = Value::Number(revision).stringify();
        let p = progress(
            if retry { "queued" } else { "cancelled" },
            json!(if retry { 0 } else { 100 }),
            at,
        )
        .stringify();
        let sql = if retry {
            "UPDATE chat_relocation_jobs SET state='queued',state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,cancellation_unsafe_at=NULL,available_at=$4,progress=$5::text::jsonb,last_error_code=NULL,error_retryable=NULL,completed_at=NULL,updated_at=$4 WHERE id=$1 AND owner_id=$2 AND state_revision=$3::text::integer AND state IN ('blocked','failed') RETURNING to_jsonb(chat_relocation_jobs)::text"
        } else {
            "UPDATE chat_relocation_jobs SET state='cancelled',state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,progress=$5::text::jsonb,completed_at=$4,updated_at=$4 WHERE id=$1 AND owner_id=$2 AND state_revision=$3::text::integer AND state IN ('queued','waiting-for-idle','validating','preparing-replica','transferring-attachments','hydrating-runtime','blocked') AND cancellation_unsafe_at IS NULL RETURNING to_jsonb(chat_relocation_jobs)::text"
        };
        let rows = self
            .database
            .query(sql, &[&id, &owner, &revision, &at, &p])
            .await?;
        if let Some(row) = rows.first() {
            return mapping::job(&raw(row)?);
        }
        if self.get(owner, id).await?.is_none() {
            return Err(Error::NotFound(String::new()).into());
        }
        Err(conflict(if retry {
            "The relocation changed or is not retryable."
        } else {
            "The relocation changed or can no longer be cancelled safely."
        }))
    }
}
