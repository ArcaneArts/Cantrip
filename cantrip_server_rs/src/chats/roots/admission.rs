use super::*;

impl Repository {
    async fn enqueue(&self, input: &Identity, kind: &str) -> Result<Value> {
        let rows=self.database.query(
            "INSERT INTO standalone_chat_root_jobs(id,owner_id,root_id,chat_id,worker_id,kind,state) VALUES($1,$2,$3,$4,$5,$6,'queued') ON CONFLICT(root_id,kind) DO NOTHING RETURNING to_jsonb(standalone_chat_root_jobs)::text",
            &[&input.id,&input.owner_id,&input.root_id,&input.chat_id,&input.worker_id,&kind],
        ).await?;
        let row = if let Some(row) = rows.first() {
            Some(raw(row)?)
        } else {
            self.database.query("SELECT to_jsonb(j)::text FROM standalone_chat_root_jobs j WHERE root_id=$1 AND kind=$2 LIMIT 1",&[&input.root_id,&kind]).await?.first().map(raw).transpose()?
        };
        let row = row
            .filter(|r| same_identity(r, input, kind))
            .ok_or(RootJobError::Conflict(
                "The standalone Chat scratch job conflicts with an existing identity.",
            ))?;
        summary(&row)
    }
    pub async fn enqueue_provision(&self, input: &Identity) -> Result<Value> {
        self.enqueue(input, "provision").await
    }
    pub async fn enqueue_delete(&self, input: &Identity) -> Result<Value> {
        let job = self.enqueue(input, "delete").await?;
        let at = crate::auth::now();
        // These are separate commits in the reference repository. Preserve
        // those boundaries, including an already committed job on later error.
        self.database.query("UPDATE standalone_chat_roots SET status='deleting',deletion_job_id=$5,updated_at=$6 WHERE id=$1 AND chat_id=$2 AND owner_id=$3 AND worker_id=$4",
            &[&input.root_id,&input.chat_id,&input.owner_id,&input.worker_id,&input.id,&at]).await?;
        let at = crate::auth::now();
        self.database.query("UPDATE standalone_chat_root_jobs SET state='failed',state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,last_error_code='root-conflict',error_retryable=false,completed_at=$2,updated_at=$3 WHERE root_id=$1 AND kind='provision' AND state IN ('queued','blocked')",
            &[&input.root_id,&at,&crate::auth::now()]).await?;
        Ok(job)
    }
    pub async fn tombstone_and_purge(
        &self,
        input: &Identity,
        expired_by: Option<DateTime<Utc>>,
    ) -> Result<Value> {
        let input = input.clone();
        self.database.transaction(|tx|Box::pin(async move {
            let expiry=if expired_by.is_some() { " AND r.archive_expires_at IS NOT NULL AND r.archive_expires_at<=$5" } else { "" };
            let statement=format!("SELECT r.id FROM standalone_chat_roots r INNER JOIN chats c ON c.id=r.chat_id AND c.owner_id=r.owner_id WHERE r.id=$1 AND r.chat_id=$2 AND r.owner_id=$3 AND r.worker_id=$4 AND c.context_kind='standalone' AND c.archived_at IS NOT NULL{expiry} LIMIT 1 FOR UPDATE");
            let mut parameters:Vec<&(dyn postgres_types::ToSql+Sync)>=vec![&input.root_id,&input.chat_id,&input.owner_id,&input.worker_id];
            if let Some(at)=expired_by.as_ref() { parameters.push(at); }
            let rows=tx.query(&statement,&parameters).await?;
            anyhow::ensure!(!rows.is_empty(),RootJobError::Conflict("The standalone Chat scratch root no longer exists."));
            let rows=tx.query("INSERT INTO standalone_chat_root_jobs(id,owner_id,root_id,chat_id,worker_id,kind,state) VALUES($1,$2,$3,$4,$5,'delete','queued') ON CONFLICT(root_id,kind) DO NOTHING RETURNING to_jsonb(standalone_chat_root_jobs)::text",
                &[&input.id,&input.owner_id,&input.root_id,&input.chat_id,&input.worker_id]).await?;
            let existing=if let Some(row)=rows.first(){Some(raw(row)?)}else{
                tx.query("SELECT to_jsonb(j)::text FROM standalone_chat_root_jobs j WHERE root_id=$1 AND kind='delete' LIMIT 1",&[&input.root_id]).await?.first().map(raw).transpose()?
            };
            let row=existing.filter(|r|same_identity(r,&input,"delete")).ok_or(RootJobError::Conflict("The standalone Chat cleanup tombstone conflicts with an existing job."))?;
            tx.query("UPDATE standalone_chat_roots SET status='deleting',deletion_job_id=$2,updated_at=$3 WHERE id=$1",&[&input.root_id,&input.id,&crate::auth::now()]).await?;
            let completed=crate::auth::now();let updated=crate::auth::now();
            tx.query("UPDATE standalone_chat_root_jobs SET state='failed',state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,last_error_code='root-conflict',error_retryable=false,completed_at=$2,updated_at=$3 WHERE root_id=$1 AND kind='provision' AND state IN ('queued','blocked')",&[&input.root_id,&completed,&updated]).await?;
            tx.query("DELETE FROM chats WHERE id=$1 AND owner_id=$2 AND context_kind='standalone'",&[&input.chat_id,&input.owner_id]).await?;
            summary(&row)
        })).await
    }
    pub async fn purge_expired(&self, owner: &str, at: DateTime<Utc>) -> Result<Vec<Value>> {
        let rows=self.database.query(
            "SELECT r.chat_id,r.owner_id,r.id,r.worker_id FROM standalone_chat_roots r INNER JOIN chats c ON c.id=r.chat_id AND c.owner_id=r.owner_id WHERE r.owner_id=$1 AND c.context_kind='standalone' AND c.archived_at IS NOT NULL AND r.archive_expires_at IS NOT NULL AND r.archive_expires_at<=$2",
            &[&owner,&at],
        ).await?;
        let mut jobs = Vec::new();
        for row in rows {
            let input = Identity {
                id: uuid::Uuid::new_v4().to_string(),
                chat_id: row.get(0)?,
                owner_id: row.get(1)?,
                root_id: row.get(2)?,
                worker_id: row.get(3)?,
            };
            match self.tombstone_and_purge(&input, Some(at)).await {
                Ok(job) => jobs.push(job),
                Err(error)
                    if matches!(
                        error.downcast_ref::<RootJobError>(),
                        Some(RootJobError::Conflict(_))
                    ) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(jobs)
    }
    pub async fn purge_all_expired(&self, at: DateTime<Utc>) -> Result<Vec<Value>> {
        let owners=self.database.query("SELECT DISTINCT r.owner_id FROM standalone_chat_roots r INNER JOIN chats c ON c.id=r.chat_id AND c.owner_id=r.owner_id WHERE c.context_kind='standalone' AND c.archived_at IS NOT NULL AND r.archive_expires_at IS NOT NULL AND r.archive_expires_at<=$1",&[&at]).await?;
        let mut changes = Vec::new();
        for owner in owners {
            let owner: String = owner.get(0)?;
            for job in self.purge_expired(&owner, at).await? {
                changes.push(json!({"ownerId":owner,"job":job}));
            }
        }
        Ok(changes)
    }
}
