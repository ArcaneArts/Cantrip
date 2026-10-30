use super::*;

impl FolderRepository {
    pub async fn get(&self, owner: &str, project: &str) -> Result<Option<Value>> {
        self.database.query("SELECT to_jsonb(j)::text FROM project_folder_setup_jobs j WHERE owner_id=$1 AND project_id=$2 LIMIT 1",&[&owner,&project]).await?.first().map(|r|summary(&raw(r)?)).transpose()
    }
    pub async fn claim_next(&self) -> Result<Option<Value>> {
        let at = crate::auth::now();
        self.database.transaction(|tx|Box::pin(async move {
            let rows=tx.query("SELECT to_jsonb(j)::text FROM project_folder_setup_jobs j INNER JOIN projects p ON p.id=j.project_id WHERE j.state='queued' AND j.available_at<=$1 ORDER BY j.available_at ASC,j.created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED",&[&at]).await?;
            let Some(row)=rows.first() else{return Ok(None)};
            let candidate=raw(row)?;let id=text(&candidate["id"])?;let command=uuid::Uuid::new_v4().to_string();let version=candidate["state_revision"].stringify();let expires=at+chrono::Duration::minutes(2);
            let rows=tx.query("UPDATE project_folder_setup_jobs SET state='running',state_revision=state_revision+1,attempt=attempt+1,command_id=$2,lease_expires_at=$3,started_at=coalesce(started_at,$4),completed_at=NULL,last_error_code=NULL,error_retryable=NULL,updated_at=$4 WHERE id=$1 AND state='queued' AND state_revision=$5::text::integer RETURNING to_jsonb(project_folder_setup_jobs)::text",&[&id,&command,&expires,&at,&version]).await?;
            let Some(row)=rows.first() else{return Ok(None)};let row=raw(row)?;
            Ok(Some(Value::object([("ownerId",copy(&row,"owner_id")),("commandId",Value::String(command.into())),("existingPath",copy(&row,"requested_path")),("job",summary(&row)?)])))
        })).await
    }
    pub async fn renew(&self, id: &str, command: &str, attempt: f64) -> Result<bool> {
        let at = crate::auth::now();
        let expires = at + chrono::Duration::minutes(2);
        let attempt = Value::Number(attempt).stringify();
        Ok(!self.database.query("UPDATE project_folder_setup_jobs SET lease_expires_at=$4,updated_at=$5 WHERE id=$1 AND state='running' AND command_id=$2 AND attempt=$3::text::integer RETURNING id",&[&id,&command,&attempt,&expires,&at]).await?.is_empty())
    }
    pub async fn settle(
        &self,
        id: &str,
        command: &str,
        state: &str,
        error: &Value,
    ) -> Result<Value> {
        let (id, command, state, error) = (
            id.to_owned(),
            command.to_owned(),
            state.to_owned(),
            error.clone(),
        );
        let at = crate::auth::now();
        let row=self.database.transaction(|tx|Box::pin(async move {
            let code=text(&error["code"])?;let retryable=error["retryable"].as_bool().context("Folder retryable flag")?;let completed=if state=="failed"{Some(at)}else{None};
            let rows=tx.query("UPDATE project_folder_setup_jobs SET state=$3,state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,completed_at=$4,last_error_code=$5,error_retryable=$6,updated_at=$7 WHERE id=$1 AND state='running' AND command_id=$2 RETURNING to_jsonb(project_folder_setup_jobs)::text",&[&id,&command,&state,&completed,&code,&retryable,&at]).await?;
            let row=raw(rows.first().ok_or(FolderError::Stale("The folder setup attempt is no longer current."))?)?;let project=text(&row["project_id"])?;let status=if state=="failed"{"failed"}else{"preparing"};
            tx.query("UPDATE projects SET setup_status=$2,setup_error=$3,updated_at=$4 WHERE id=$1",&[&project,&status,&code,&at]).await?;Ok(row)
        })).await?;
        summary(&row)
    }
    pub async fn retry(
        &self,
        owner: &str,
        project: &str,
        revision: &Value,
    ) -> Result<Option<Value>> {
        let (owner, project, revision) =
            (owner.to_owned(), project.to_owned(), revision.stringify());
        let at = crate::auth::now();
        let row=self.database.transaction(|tx|Box::pin(async move {
            let rows=tx.query("UPDATE project_folder_setup_jobs SET state='queued',state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,available_at=$4,completed_at=NULL,last_error_code=NULL,error_retryable=NULL,updated_at=$4 WHERE owner_id=$1 AND project_id=$2 AND state_revision=$3::text::integer AND state IN ('blocked','failed') RETURNING to_jsonb(project_folder_setup_jobs)::text",&[&owner,&project,&revision,&at]).await?;
            let Some(row)=rows.first() else{return Ok(None)};let row=raw(row)?;bootstrap::update_project(tx,&project,at).await?;Ok(Some(row))
        })).await?;
        row.map(|r| summary(&r)).transpose()
    }
    pub async fn recover(&self, force: bool, at: chrono::DateTime<chrono::Utc>) -> Result<usize> {
        let filter = if force {
            "state='running'"
        } else {
            "state='running' AND (lease_expires_at IS NULL OR lease_expires_at<=$1)"
        };
        Ok(self.database.query(&format!("UPDATE project_folder_setup_jobs SET state='queued',state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,available_at=$1,last_error_code=NULL,error_retryable=NULL,updated_at=$1 WHERE {filter} RETURNING id"),&[&at]).await?.len())
    }
    pub async fn requeue_worker(&self, worker: &str) -> Result<usize> {
        let worker = worker.to_owned();
        let at = crate::auth::now();
        self.database.transaction(|tx|Box::pin(async move {
            let rows=tx.query("UPDATE project_folder_setup_jobs SET state='queued',state_revision=state_revision+1,available_at=$2,last_error_code=NULL,error_retryable=NULL,updated_at=$2 WHERE worker_id=$1 AND state='blocked' AND error_retryable=true RETURNING project_id",&[&worker,&at]).await?;
            let projects=rows.iter().map(|r|r.get::<String>(0)).collect::<Result<std::collections::HashSet<_>>>()?;
            for project in projects {bootstrap::update_project(tx,&project,at).await?;}Ok(rows.len())
        })).await
    }
    pub async fn complete(&self, id: &str, command: &str, result: &Value) -> Result<Value> {
        let (id, command, result) = (id.to_owned(), command.to_owned(), result.clone());
        let at = crate::auth::now();
        let row=self.database.transaction(|tx|Box::pin(async move {
            let rows=tx.query("SELECT to_jsonb(j)::text FROM project_folder_setup_jobs j WHERE id=$1 LIMIT 1 FOR UPDATE",&[&id]).await?;
            let job=rows.first().map(raw).transpose()?.unwrap_or(Value::Null);
            anyhow::ensure!(!job.is_null() && job["state"]=="running" && job["command_id"]==command && job["attempt"]==result["attempt"] && job["id"]==result["jobId"],FolderError::Stale("The folder setup completion is no longer current."));
            let project=text(&job["project_id"])?;let owner=text(&job["owner_id"])?;let worker=text(&job["worker_id"])?;
            let projects=tx.query("SELECT origin_kind FROM projects WHERE id=$1 AND owner_id=$2 LIMIT 1",&[&project,&owner]).await?;
            anyhow::ensure!(projects.first().is_some_and(|r|r.get::<String>(0).is_ok_and(|v|v=="managed-folder")),FolderError::Conflict("The folder project no longer exists or changed origin."));
            let source=uuid::Uuid::new_v4().to_string();let tree=uuid::Uuid::new_v4().to_string();let path=text(&result["path"])?;let display=text(&result["displayPath"])?;let fingerprint=optional(&result["repositoryFingerprint"])?;let source_kind=if crate::wire::coercion::truthy(result.get("repositoryFingerprint")){"git"}else{"folder"};
            tx.query("INSERT INTO project_sources(id,project_id,worker_id,source_kind,absolute_path,display_path,repository_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7)",&[&source,&project,&worker,&source_kind,&path,&display,&fingerprint]).await?;
            let root=if source_kind=="git"{"git-worktree"}else{"folder-root"};let origin=if crate::wire::coercion::truthy(job.get("requested_path")){"external"}else{"cantrip"};
            tx.query("INSERT INTO project_worktrees(id,project_source_id,worker_id,root_kind,name,absolute_path,display_path,is_primary,is_default,origin,lifecycle_state) VALUES($1,$2,$3,$4,'Primary',$5,$6,true,true,$7,'ready')",&[&tree,&source,&worker,&root,&path,&display,&origin]).await?;
            let git=result.get("repositoryFingerprint")!=Some(&Value::Null);let github=result.get("github")!=Some(&Value::Null);let repository=optional(&result["github"]["repositoryId"])?;let name=optional(&result["github"]["nameWithOwner"])?;let url=optional(&result["github"]["url"])?;
            tx.query("UPDATE projects SET setup_status='ready',setup_error=NULL,git_capability=$2,github_capability=$3,github_repository_blind_index=$4,github_repository_id=$4,github_repository_full_name=$5,github_repository_url=$6,updated_at=$7 WHERE id=$1",&[&project,&git,&github,&repository,&name,&url,&at]).await?;
            let rows=tx.query("UPDATE project_folder_setup_jobs SET state='succeeded',state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,last_error_code=NULL,error_retryable=NULL,completed_at=$3,updated_at=$3 WHERE id=$1 AND command_id=$2 RETURNING to_jsonb(project_folder_setup_jobs)::text",&[&id,&command,&at]).await?;
            raw(rows.first().context("Completing folder setup")?)
        })).await?;
        summary(&row)
    }
}
