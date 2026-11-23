use super::*;

impl FolderRepository {
    pub async fn create(&self, owner: &str, input: &Value) -> Result<Value> {
        let default = self.ensure_default_workspace(owner).await?;
        let workspace = input.get("workspaceId").unwrap_or(&default["id"]);
        let workspace = text(workspace)?;
        anyhow::ensure!(
            !self
                .database
                .query(
                    "SELECT id FROM project_workspaces WHERE owner_id=$1 AND id=$2",
                    &[&owner, &workspace]
                )
                .await?
                .is_empty(),
            FolderError::Workspace("Folder project creation referenced an unknown workspace.")
        );
        let owner = owner.to_owned();
        let id = text(&input["id"])?;
        let worker = text(&input["workerId"])?;
        let label = input["nameProtection"].stringify();
        let existing = optional(input.get("existingPath").unwrap_or(&Value::Null))?;
        let job = uuid::Uuid::new_v4().to_string();
        let returned_id = id.clone();
        let returned_owner = owner.clone();
        let row=self.database.transaction(|tx|Box::pin(async move {
            anyhow::ensure!(!tx.query("SELECT id FROM workers WHERE id=$1 AND owner_id=$2 AND unlinked_at IS NULL LIMIT 1",&[&worker,&owner]).await?.is_empty(),FolderError::Workspace("Worker not found."));
            let positions=tx.query("SELECT position FROM projects WHERE owner_id=$1 ORDER BY position DESC LIMIT 1",&[&owner]).await?;
            let position=positions.first().map(|r|r.get::<i32>(0)).transpose()?.map_or(0_i64,|p|p as i64+1).to_string();
            let management=if existing.as_ref().is_some_and(|s|!s.is_empty()){"external"}else{"managed"};
            let rows=tx.query("INSERT INTO projects(id,owner_id,protected_label,position,origin_kind,folder_management,setup_status,setup_error,worktree_policy,git_capability,github_capability,preferred_worker_id,github_repository_blind_index,github_repository_id,github_repository_full_name,github_repository_url) VALUES($1,$2,$3::text::jsonb,$4::text::integer,'managed-folder',$5,'preparing',NULL,'direct',false,false,$6,NULL,NULL,NULL,NULL) RETURNING to_jsonb(projects)::text,created_at,updated_at",&[&id,&owner,&label,&position,&management,&worker]).await?;
            let row=rows.into_iter().next().context("creating a folder project")?;
            tx.query("INSERT INTO project_workspace_memberships(workspace_id,project_id) VALUES($1,$2)",&[&workspace,&id]).await?;
            tx.query("INSERT INTO project_folder_setup_jobs(id,owner_id,project_id,worker_id,requested_path,state) VALUES($1,$2,$3,$4,$5,'queued')",&[&job,&owner,&id,&worker,&existing]).await?;
            Ok(row)
        })).await?;
        let job = self
            .get(&returned_owner, &returned_id)
            .await?
            .context("Folder setup job was not created.")?;
        let project =
            super::super::repository::project(&raw(&row)?, Vec::new(), row.get(1)?, row.get(2)?)?;
        Ok(Value::object([("job", job), ("project", project)]))
    }
}
