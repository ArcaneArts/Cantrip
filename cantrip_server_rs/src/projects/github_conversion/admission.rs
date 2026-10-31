use super::*;
impl ConversionRepository {
    pub async fn create(
        &self,
        owner: &str,
        project: &str,
        worker: &str,
        source: &str,
        input: &Value,
    ) -> Result<Value> {
        let (owner, project, worker, source, input) = (
            owner.to_owned(),
            project.to_owned(),
            worker.to_owned(),
            source.to_owned(),
            input.clone(),
        );
        let at = crate::auth::now();
        let row=self.database.transaction(|tx|Box::pin(async move {
            let rows=tx.query("SELECT to_jsonb(p)::text FROM projects p WHERE id=$1 AND owner_id=$2 LIMIT 1 FOR UPDATE", &[&project,&owner]).await?;
            let project_row=raw(rows.first().ok_or(ConversionError::NotFound)?)?;
            anyhow::ensure!(project_row["origin_kind"]=="managed-folder" && project_row["setup_status"]=="ready", ConversionError::Conflict("Only a ready folder or local Git project can be converted."));
            let active=tx.query("SELECT id FROM project_github_conversion_jobs WHERE project_id=$1 AND state IN ('queued','running','blocked') LIMIT 1", &[&project]).await?;
            let blind=text(&input["repositoryBlindIndex"])?;
            let collisions=tx.query("SELECT id FROM projects WHERE owner_id=$1 AND github_repository_blind_index=$2 LIMIT 1", &[&owner,&blind]).await?;
            let sources=tx.query("SELECT to_jsonb(s)::text FROM project_sources s INNER JOIN project_worktrees t ON t.project_source_id=s.id AND t.is_primary=true AND t.is_default=true AND t.lifecycle_state='ready' WHERE s.project_id=$1 AND s.id=$2 AND s.worker_id=$3 AND s.removed_at IS NULL LIMIT 1", &[&project,&source,&worker]).await?;
            anyhow::ensure!(active.is_empty(), ConversionError::Conflict("A GitHub conversion is already active for this project."));
            anyhow::ensure!(collisions.is_empty(), ConversionError::Conflict("This GitHub repository is already bound to another Cantrip project."));
            let source_row=sources.first().map(raw).transpose()?.unwrap_or(Value::Null);
            anyhow::ensure!(eligible(&project_row,&source_row),ConversionError::Conflict("The project no longer has an eligible conversion source."));
            let id=uuid::Uuid::new_v4().to_string();
            let repository=&input["repository"];
            let repository_id=text(&repository["repositoryId"])?;
            let name=text(&repository["nameWithOwner"])?;
            let url=text(&repository["url"])?;
            let confirmation=text(&input["confirmationToken"])?;
            let message=optional(&input["initialCommit"]["message"])?;
            let rows=tx.query("INSERT INTO project_github_conversion_jobs(id,owner_id,project_id,project_source_id,worker_id,repository_blind_index,repository_id,repository_full_name,repository_url,confirmation_token,initial_commit_message,state,state_revision,attempt,available_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued',1,0,$12,$12,$12) RETURNING to_jsonb(project_github_conversion_jobs)::text", &[&id,&owner,&project,&source,&worker,&blind,&repository_id,&name,&url,&confirmation,&message,&at]).await?;
            raw(rows.first().context("Inserting conversion job")?)
        })).await?;
        summary(&row)
    }
}
