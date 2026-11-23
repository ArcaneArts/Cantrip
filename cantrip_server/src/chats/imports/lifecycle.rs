use super::*;
use indexmap::IndexMap;
impl Repository {
    pub async fn recover(&self, force: bool, at: DateTime<Utc>) -> Result<usize> {
        let mut count = 0;
        for (canonical, state, percent) in [(false, "queued", 0), (true, "awaiting-hydration", 75)]
        {
            let progress = progress(state, percent, at).stringify();
            let predicate = if canonical { "IS NOT NULL" } else { "IS NULL" };
            count+=self.database.query(&format!("UPDATE chat_import_jobs SET state=$1,state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,available_at=$2,progress=$3::text::jsonb,last_error_code=NULL,error_retryable=NULL,updated_at=$2 WHERE state IN {RUNNING} AND ($4 OR lease_expires_at IS NULL OR lease_expires_at<=$2) AND chat_id {predicate} RETURNING id"),&[&state,&at,&progress,&force]).await?.len();
        }
        Ok(count)
    }
    pub async fn claim_next(&self) -> Result<Option<Value>> {
        let at = crate::auth::now();
        self.database.transaction(|tx|Box::pin(async move {
            let rows=tx.query("SELECT to_jsonb(j)::text FROM chat_import_jobs j WHERE state IN ('queued','awaiting-hydration') AND available_at<=$1 ORDER BY available_at ASC,created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED",&[&at]).await?;
            let Some(candidate)=rows.first().map(raw).transpose()? else {return Ok(None);};
            let id=text(&candidate["id"])?;let state=text(&candidate["state"])?;let revision=candidate["state_revision"].stringify();
            let canonical=crate::wire::coercion::truthy(candidate.get("chat_id"));
            let next=if canonical {"hydrating"} else {"reading"};let p=progress(next,if canonical {80} else {10},at).stringify();
            let command=uuid::Uuid::new_v4().to_string();let expires=at+chrono::Duration::minutes(2);
            let rows=tx.query("UPDATE chat_import_jobs SET state=$4,state_revision=state_revision+1,attempt=attempt+1,command_id=$5,lease_expires_at=$6,started_at=coalesce(started_at,$7),progress=$8::text::jsonb,last_error_code=NULL,error_retryable=NULL,updated_at=$7 WHERE id=$1 AND state=$2 AND state_revision=$3::text::integer RETURNING to_jsonb(chat_import_jobs)::text",&[&id,&state,&revision,&next,&command,&expires,&at,&p]).await?;
            rows.first().map(|r| {
                let row=raw(r)?;Ok(json!({"ownerId":row["owner_id"],"commandId":command,"job":mapping::job(&row)?}))
            }).transpose()
        })).await
    }
    pub async fn renew(&self, id: &str, command: &str, attempt: f64) -> Result<bool> {
        let at = crate::auth::now();
        let expires = at + chrono::Duration::minutes(2);
        let attempt = Value::Number(attempt).stringify();
        Ok(self.database.query(&format!("UPDATE chat_import_jobs SET lease_expires_at=$4,updated_at=$5 WHERE id=$1 AND command_id=$2 AND attempt=$3::text::integer AND state IN {RUNNING} RETURNING id"),&[&id,&command,&attempt,&expires,&at]).await?.len()==1)
    }
    pub async fn mark_importing(&self, id: &str, command: &str, attempt: f64) -> Result<Value> {
        let at = crate::auth::now();
        let p = progress("importing", 60, at).stringify();
        let attempt = Value::Number(attempt).stringify();
        mapping::job(&first(&self.database.query("UPDATE chat_import_jobs SET state='importing',state_revision=state_revision+1,progress=$4::text::jsonb,updated_at=$5 WHERE id=$1 AND command_id=$2 AND attempt=$3::text::integer AND state='reading' RETURNING to_jsonb(chat_import_jobs)::text",&[&id,&command,&attempt,&p,&at]).await?)?)
    }
    pub async fn settle(
        &self,
        id: &str,
        command: &str,
        state: &str,
        error: &Value,
    ) -> Result<Value> {
        anyhow::ensure!(
            state == "blocked" || state == "failed",
            "Invalid import settlement"
        );
        let at = crate::auth::now();
        let p = progress(state, if state == "failed" { 100 } else { 0 }, at).stringify();
        let completed = (state == "failed").then_some(at);
        let code = text(&error["code"])?;
        let retryable = error["retryable"]
            .as_bool()
            .context("Import error retryable")?;
        mapping::job(&first(&self.database.query(&format!("UPDATE chat_import_jobs SET state=$3,state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,progress=$4::text::jsonb,last_error_code=$5,error_retryable=$6,completed_at=$7,updated_at=$8 WHERE id=$1 AND command_id=$2 AND state IN {RUNNING} RETURNING to_jsonb(chat_import_jobs)::text"),&[&id,&command,&state,&p,&code,&retryable,&completed,&at]).await?)?)
    }
    pub async fn retry(&self, owner: &str, id: &str, revision: f64) -> Result<Option<Value>> {
        let (owner, id, revision) = (
            owner.to_owned(),
            id.to_owned(),
            Value::Number(revision).stringify(),
        );
        let at = crate::auth::now();
        self.database.transaction(|tx|Box::pin(async move {
            let rows=tx.query("SELECT to_jsonb(j)::text FROM chat_import_jobs j WHERE id=$1 AND owner_id=$2 AND state_revision=$3::text::integer AND state IN ('blocked','failed') LIMIT 1 FOR UPDATE",&[&id,&owner,&revision]).await?;
            let Some(row)=rows.first().map(raw).transpose()? else {return Ok(None);};
            let canonical=crate::wire::coercion::truthy(row.get("chat_id"));let next=if canonical {"awaiting-hydration"} else {"queued"};let p=progress(next,if canonical {75} else {0},at).stringify();
            tx.query("UPDATE chat_import_jobs SET state=$3,state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,available_at=$4,completed_at=NULL,progress=$5::text::jsonb,last_error_code=NULL,error_retryable=NULL,updated_at=$4 WHERE id=$1 AND state_revision=$2::text::integer RETURNING to_jsonb(chat_import_jobs)::text",&[&id,&revision,&next,&at,&p]).await?.first().map(|r|mapping::job(&raw(r)?)).transpose()
        })).await
    }
    pub async fn requeue_worker(&self, worker: &str) -> Result<usize> {
        let at = crate::auth::now();
        let mut count = 0;
        for (canonical, next, percent) in [(false, "queued", 0), (true, "awaiting-hydration", 75)] {
            let condition = if canonical {
                "target_placement->>'workerId'=$1 AND chat_id IS NOT NULL"
            } else {
                "source_worker_id=$1 AND chat_id IS NULL"
            };
            let p = progress(next, percent, at).stringify();
            count+=self.database.query(&format!("UPDATE chat_import_jobs SET state=$2,state_revision=state_revision+1,available_at=$3,progress=$4::text::jsonb,last_error_code=NULL,error_retryable=NULL,updated_at=$3 WHERE {condition} AND state='blocked' AND error_retryable=true RETURNING id"),&[&worker,&next,&at,&p]).await?.len();
        }
        Ok(count)
    }
    pub async fn read_context(&self, id: &str, command: &str) -> Result<Option<Value>> {
        let rows=self.database.query("SELECT to_jsonb(j)::text FROM chat_import_jobs j WHERE id=$1 AND command_id=$2 AND state='reading' LIMIT 1",&[&id,&command]).await?;
        let Some(job) = rows.first().map(raw).transpose()? else {
            return Ok(None);
        };
        let project = text(&job["project_id"])?;
        let worker = text(&job["source_worker_id"])?;
        let rows=self.database.query("SELECT jsonb_build_object('source',to_jsonb(s),'worktree',to_jsonb(w))::text FROM project_sources s LEFT JOIN project_worktrees w ON w.project_source_id=s.id WHERE s.project_id=$1 AND s.worker_id=$2 AND s.removed_at IS NULL",&[&project,&worker]).await?;
        let mut sources = IndexMap::<String, Value>::new();
        for r in rows {
            let row = raw(&r)?;
            let source = &row["source"];
            let id = text(&source["id"])?;
            let target=sources.entry(id).or_insert_with(||json!({"projectReplicaId":source["id"],"path":source["absolute_path"],"repositoryFingerprint":source["repository_fingerprint"],"worktrees":Vec::<Value>::new()}));
            let tree = &row["worktree"];
            if !tree.is_null() {
                if tree["absolute_path"].is_null() {
                    anyhow::bail!("This checkout requires a CantripOS execution target.");
                }
                let item = json!({"worktreeId":tree["id"],"path":tree["absolute_path"],"isPrimary":tree["is_primary"]});
                let Value::Array(trees) = &mut target["worktrees"] else {
                    anyhow::bail!("Import source worktrees");
                };
                trees.push(item);
            }
        }
        Ok((!sources.is_empty())
            .then(|| json!({"targets":Value::Array(sources.into_values().collect())})))
    }
}
