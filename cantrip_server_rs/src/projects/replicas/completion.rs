use super::*;
use crate::database::Transaction;
fn optional(value: &Value) -> Result<Option<String>> {
    if value.is_null() {
        Ok(None)
    } else {
        text(value).map(Some)
    }
}
async fn locked(tx: &Transaction<'_>, id: &str) -> Result<Value> {
    Ok(tx
        .query(
            "SELECT to_jsonb(j)::text FROM project_replica_jobs j WHERE id=$1 LIMIT 1 FOR UPDATE",
            &[&id],
        )
        .await?
        .first()
        .map(raw)
        .transpose()?
        .unwrap_or(Value::Null))
}
fn current(job: &Value, command: &str, result: &Value) -> bool {
    !job.is_null()
        && job["state"] == "running"
        && job["command_id"] == command
        && job["attempt"] == result["attempt"]
}
async fn succeeded(
    tx: &Transaction<'_>,
    job: &Value,
    command: &str,
    at: chrono::DateTime<chrono::Utc>,
    revision: Option<&str>,
    message: &'static str,
) -> Result<Value> {
    let id = text(&job["id"])?;
    let progress = progress("succeeded", 100, at);
    let rows=tx.query("UPDATE project_replica_jobs SET state='succeeded',state_revision=state_revision+1,resolved_revision=CASE WHEN $5::text IS NULL THEN resolved_revision ELSE $5 END,command_id=NULL,lease_expires_at=NULL,cancellation_unsafe_at=NULL,progress=$3::text::jsonb,completed_at=$4,last_error_code=NULL,error_retryable=NULL,updated_at=$4 WHERE id=$1 AND command_id=$2 RETURNING to_jsonb(project_replica_jobs)::text",&[&id,&command,&progress,&at,&revision]).await?;
    raw(rows.first().ok_or(ReplicaError::Stale(message))?)
}
impl ReplicaRepository {
    pub async fn complete_provision(
        &self,
        id: &str,
        command: &str,
        result: &Value,
    ) -> Result<Value> {
        let (id, command, result) = (id.to_owned(), command.to_owned(), result.clone());
        let at = crate::auth::now();
        let row=self.database.transaction(|tx|Box::pin(async move {
            let job=locked(tx,&id).await?;
            anyhow::ensure!(current(&job,&command,&result),ReplicaError::Stale("The replica job attempt is no longer current."));
            anyhow::ensure!(job["id"]==result["jobId"],ReplicaError::Stale("The worker completed a different replica job."));
            let placement=result.get("placement").filter(|v|!v.is_null()).cloned().unwrap_or_else(||if job["placement_mode"]=="managed"{json!({"mode":"managed","materialization":if crate::wire::coercion::truthy(result.get("reused")){"reused"}else{"cloned"},"ownership":"cantrip","canonicalPath":copy(&result,"path"),"requestedPath":Value::Null,"linkPath":Value::Null})}else{Value::Null});
            let mode=placement["mode"].as_str().unwrap_or_default();
            let valid=!placement.is_null()&&placement["mode"]==job["placement_mode"]&&result["reused"]==Value::Bool(placement["materialization"]!="cloned")&&match mode {
                "managed"=>placement["ownership"]=="cantrip"&&placement["requestedPath"].is_null()&&placement["linkPath"].is_null(),
                "managed-link"=>placement["ownership"]=="cantrip"&&!placement["requestedPath"].is_null()&&!placement["linkPath"].is_null(),
                "direct"=>!placement["requestedPath"].is_null()&&placement["linkPath"].is_null()&&((placement["ownership"]=="user")== (placement["materialization"]=="attached")),
                _=>true,
            };
            anyhow::ensure!(valid,ReplicaError::Conflict("The worker returned placement facts that do not match the provision request."));
            let project=text(&job["project_id"])?;let worker=text(&job["worker_id"])?;
            let rows=tx.query("SELECT to_jsonb(s)::text FROM project_sources s WHERE project_id=$1 AND worker_id=$2 AND removed_at IS NULL LIMIT 1",&[&project,&worker]).await?;
            let source=rows.first().map(raw).transpose()?;
            if let Some(source)=source.as_ref(){
                anyhow::ensure!(source["absolute_path"]==result["path"]&&source["repository_fingerprint"]==result["repositoryFingerprint"]&&source["placement_mode"]==placement["mode"]&&source["ownership_kind"]==placement["ownership"]&&source["requested_path"]==placement["requestedPath"]&&source["link_path"]==placement["linkPath"],ReplicaError::Conflict("The worker already has a different replica record for this project."));
            }
            let path=text(&result["path"])?;let display=text(&result["displayPath"])?;let fingerprint=optional(&result["repositoryFingerprint"])?;let ownership=text(&placement["ownership"])?;let requested=optional(&placement["requestedPath"])?;let link=optional(&placement["linkPath"])?;
            let source=if let Some(source)=source {source}else{
                let source_id=uuid::Uuid::new_v4().to_string();let rows=tx.query("INSERT INTO project_sources(id,project_id,worker_id,absolute_path,display_path,placement_mode,ownership_kind,requested_path,link_path,repository_fingerprint,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING to_jsonb(project_sources)::text",&[&source_id,&project,&worker,&path,&display,&mode,&ownership,&requested,&link,&fingerprint,&at]).await?;raw(rows.first().context("Inserting replica source")?)?
            };
            let source_id=text(&source["id"])?;let revision=text(&result["resolvedRevision"])?;
            if tx.query("SELECT id FROM project_worktrees WHERE project_source_id=$1 AND is_primary=true LIMIT 1",&[&source_id]).await?.is_empty(){
                let tree=uuid::Uuid::new_v4().to_string();let branch=optional(&result["branch"])?;let detached=result["branch"].is_null();
                tx.query("INSERT INTO project_worktrees(id,project_source_id,worker_id,name,absolute_path,display_path,is_primary,is_default,origin,lifecycle_state,branch,head,detached,last_scanned_at,created_at,updated_at) VALUES($1,$2,$3,'Primary',$4,$5,true,true,'cantrip','ready',$6,$7,$8,$9,$9,$9)",&[&tree,&source_id,&worker,&path,&display,&branch,&revision,&detached,&at]).await?;
            }
            let policy=optional(&result["worktreePolicy"])?;
            tx.query("UPDATE projects SET setup_status='ready',setup_error=NULL,worktree_policy=coalesce($2,worktree_policy),updated_at=$3 WHERE id=$1",&[&project,&policy,&at]).await?;
            let materialization=text(&placement["materialization"])?;
            tx.query("UPDATE project_replica_jobs SET project_replica_id=$2,resolved_materialization=$3,resolved_ownership=$4 WHERE id=$1 AND command_id=$5",&[&id,&source_id,&materialization,&ownership,&command]).await?;
            succeeded(tx,&job,&command,at,Some(&revision),"The replica job attempt is no longer current.").await
        })).await?;
        summary(&row)
    }
    pub async fn complete_synchronize(
        &self,
        id: &str,
        command: &str,
        result: &Value,
    ) -> Result<Value> {
        let (id, command, result) = (id.to_owned(), command.to_owned(), result.clone());
        let at = crate::auth::now();
        let row=self.database.transaction(|tx|Box::pin(async move {
            let job=locked(tx,&id).await?;
            anyhow::ensure!(current(&job,&command,&result)&&job["kind"]=="synchronize"&&job["id"]==result["jobId"]&&crate::wire::coercion::truthy(job.get("project_replica_id"))&&job["expected_revision"]==result["resolvedRevision"],ReplicaError::Stale("The replica synchronization result does not match the active attempt."));
            let source=text(&job["project_replica_id"])?;let path=text(&result["path"])?;
            let rows=tx.query("SELECT absolute_path FROM project_sources WHERE id=$1 AND removed_at IS NULL LIMIT 1",&[&source]).await?;
            let stored=rows.first().ok_or(ReplicaError::Conflict("The synchronized project replica no longer exists."))?.get::<String>(0)?;
            if stored!=path{tx.query("UPDATE project_sources SET absolute_path=$2,updated_at=$3 WHERE id=$1",&[&source,&path,&at]).await?;}
            let branch=optional(&result["branch"])?;let detached=result["branch"].is_null();let revision=text(&result["resolvedRevision"])?;
            tx.query("UPDATE project_worktrees SET absolute_path=$2,branch=$3,detached=$4,head=$5,lifecycle_state='ready',last_scanned_at=$6,updated_at=$6 WHERE project_source_id=$1 AND is_primary=true",&[&source,&path,&branch,&detached,&revision,&at]).await?;
            succeeded(tx,&job,&command,at,Some(&revision),"The replica synchronization attempt is no longer current.").await
        })).await?;
        summary(&row)
    }
    pub async fn complete_remove(&self, id: &str, command: &str, result: &Value) -> Result<Value> {
        let (id, command, result) = (id.to_owned(), command.to_owned(), result.clone());
        let at = crate::auth::now();
        let row=self.database.transaction(|tx|Box::pin(async move {
            let job=locked(tx,&id).await?;
            anyhow::ensure!(current(&job,&command,&result)&&job["kind"]=="remove"&&job["id"]==result["jobId"]&&crate::wire::coercion::truthy(job.get("project_replica_id"))&&job["delete_local_files"]==result["localFilesDeleted"],ReplicaError::Stale("The replica removal result does not match the active attempt."));
            let source=text(&job["project_replica_id"])?;
            let rows=tx.query("SELECT absolute_path FROM project_sources WHERE id=$1 AND removed_at IS NULL LIMIT 1",&[&source]).await?;
            anyhow::ensure!(rows.first().is_some_and(|row|row.get::<String>(0).is_ok_and(|path|result["path"]==path)),ReplicaError::Conflict("The worker removed a different replica path."));
            tx.query("UPDATE project_sources SET removed_at=$2,updated_at=$2 WHERE id=$1",&[&source,&at]).await?;
            if crate::wire::coercion::truthy(result.get("localFilesDeleted")){tx.query("UPDATE project_github_conversion_jobs SET local_files_deleted_at=$2,updated_at=$2 WHERE project_source_id=$1 AND state='succeeded'",&[&source,&at]).await?;}
            tx.query("UPDATE project_worktrees SET lifecycle_state='missing',updated_at=$2 WHERE project_source_id=$1",&[&source,&at]).await?;
            let project=text(&job["project_id"])?;let rows=tx.query("SELECT preferred_worker_id FROM projects WHERE id=$1 LIMIT 1",&[&project]).await?;
            if rows.first().is_some_and(|row|row.get::<Option<String>>(0).is_ok_and(|worker|worker.is_some_and(|worker|job["worker_id"]==worker))){
                let replacement=tx.query("SELECT s.worker_id FROM project_sources s INNER JOIN project_worktrees w ON w.project_source_id=s.id AND w.is_primary=true AND w.lifecycle_state='ready' WHERE s.project_id=$1 AND s.removed_at IS NULL ORDER BY s.created_at ASC LIMIT 1",&[&project]).await?.first().map(|r|r.get::<String>(0)).transpose()?;
                tx.query("UPDATE projects SET preferred_worker_id=$2,updated_at=$3 WHERE id=$1",&[&project,&replacement,&at]).await?;
            }
            succeeded(tx,&job,&command,at,None,"The replica removal attempt is no longer current.").await
        })).await?;
        summary(&row)
    }
}
