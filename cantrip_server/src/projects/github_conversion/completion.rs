use super::*;
impl ConversionRepository {
    pub async fn complete(&self, id: &str, command: &str, result: &Value) -> Result<Value> {
        let (id, command, result) = (id.to_owned(), command.to_owned(), result.clone());
        let at = crate::auth::now();
        let row=self.database.transaction(|tx|Box::pin(async move{
            let rows=tx.query("SELECT to_jsonb(j)::text FROM project_github_conversion_jobs j WHERE id=$1 LIMIT 1 FOR UPDATE", &[&id]).await?;
            let job=rows.first().map(raw).transpose()?.unwrap_or(Value::Null);
            anyhow::ensure!(!job.is_null() && job["state"]=="running" && job["command_id"]==command && job["attempt"]==result["attempt"] && job["id"]==result["jobId"],ConversionError::Stale("The GitHub conversion completion is no longer current."));
            anyhow::ensure!(job["repository_id"]==result["repository"]["repositoryId"] && job["repository_full_name"].as_js_string().map(|s|s.lowercase())==result["repository"]["nameWithOwner"].as_js_string().map(|s|s.lowercase()) && job["repository_url"]==result["repository"]["url"],ConversionError::Conflict("The worker returned a different GitHub repository identity."));
            let project=text(&job["project_id"])?;let owner=text(&job["owner_id"])?;let source=text(&job["project_source_id"])?;let worker=text(&job["worker_id"])?;let blind=text(&job["repository_blind_index"])?;
            let projects=tx.query("SELECT to_jsonb(p)::text FROM projects p WHERE id=$1 AND owner_id=$2 LIMIT 1 FOR UPDATE", &[&project,&owner]).await?;
            let sources=tx.query("SELECT to_jsonb(s)::text FROM project_sources s WHERE project_id=$1 AND id=$2 AND worker_id=$3 AND removed_at IS NULL LIMIT 1 FOR UPDATE", &[&project,&source,&worker]).await?;
            let collisions=tx.query("SELECT id FROM projects WHERE owner_id=$1 AND github_repository_blind_index=$2 LIMIT 1", &[&owner,&blind]).await?;
            let project_row=projects.first().map(raw).transpose()?.unwrap_or(Value::Null);
            let source_row=sources.first().map(raw).transpose()?.unwrap_or(Value::Null);
            anyhow::ensure!(!project_row.is_null() && project_row["origin_kind"]=="managed-folder" && eligible(&project_row,&source_row),ConversionError::Conflict("The project conversion source changed before conversion completed."));
            anyhow::ensure!(collisions.first().map(|r|r.get::<String>(0)).transpose()?.is_none_or(|id|id==project),ConversionError::Conflict("The GitHub repository became bound to another Cantrip project."));
            let roots=tx.query("SELECT to_jsonb(t)::text FROM project_worktrees t WHERE project_source_id=$1 AND is_primary=true AND is_default=true AND lifecycle_state='ready' LIMIT 1 FOR UPDATE", &[&source]).await?;
            let root=roots.first().map(raw).transpose()?.unwrap_or(Value::Null);
            let expected_root=if project_row["folder_management"]=="managed" {"folder-root"}else{"git-worktree"};
            anyhow::ensure!(!root.is_null() && root["root_kind"]==expected_root && source_row["absolute_path"]==result["path"] && root["absolute_path"]==result["path"],ConversionError::Conflict("The Primary project path changed before conversion completed."));
            let fingerprint=text(&result["repositoryFingerprint"])?;let display=text(&result["displayPath"])?;
            tx.query("UPDATE project_sources SET source_kind='git',repository_fingerprint=$2,display_path=$3,updated_at=$4 WHERE id=$1", &[&source,&fingerprint,&display,&at]).await?;
            let tree=text(&root["id"])?;let branch=optional(&result["branch"])?;let head=optional(&result["head"])?;
            tx.query("UPDATE project_worktrees SET root_kind='git-worktree',display_path=$2,branch=$3,head=$4,detached=false,lifecycle_state='ready',last_scanned_at=$5,updated_at=$5 WHERE id=$1", &[&tree,&display,&branch,&head,&at]).await?;
            let repo_id=text(&result["repository"]["repositoryId"])?;let name=text(&result["repository"]["nameWithOwner"])?;let url=text(&result["repository"]["url"])?;let policy=text(&result["worktreePolicy"])?;
            tx.query("UPDATE projects SET origin_kind='github',folder_management=NULL,github_repository_blind_index=$2,github_repository_id=$3,github_repository_full_name=$4,github_repository_url=$5,worktree_policy=$6,setup_status='ready',setup_error=NULL,updated_at=$7 WHERE id=$1", &[&project,&blind,&repo_id,&name,&url,&policy,&at]).await?;
            let rows=tx.query("UPDATE project_github_conversion_jobs SET state='succeeded',state_revision=state_revision+1,command_id=NULL,lease_expires_at=NULL,last_error_code=NULL,error_retryable=NULL,completed_at=$3,updated_at=$3 WHERE id=$1 AND command_id=$2 RETURNING to_jsonb(project_github_conversion_jobs)::text", &[&id,&command,&at]).await?;
            raw(rows.first().context("Completing conversion job")?)
        })).await?;
        summary(&row)
    }
}
