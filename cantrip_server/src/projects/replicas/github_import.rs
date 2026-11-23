use super::*;
#[derive(Debug)]
pub struct ImportWorkspaceError;
impl std::fmt::Display for ImportWorkspaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Project import referenced an unknown workspace.")
    }
}
impl std::error::Error for ImportWorkspaceError {}
impl ReplicaRepository {
    pub async fn has_github_project(&self, owner: &str, blind_index: &str) -> Result<bool> {
        let parameters: &[&(dyn tokio_postgres::types::ToSql + Sync)] = &[&owner, &blind_index];
        let (projects, conversions) = tokio::try_join!(
            self.database.query("SELECT id FROM projects WHERE owner_id=$1 AND github_repository_blind_index=$2 LIMIT 1", parameters),
            self.database.query("SELECT id FROM project_github_conversion_jobs WHERE owner_id=$1 AND repository_blind_index=$2 AND state IN ('queued','running','blocked') LIMIT 1", parameters),
        )?;
        Ok(!projects.is_empty() || !conversions.is_empty())
    }
    pub async fn create_github_project(&self, owner: &str, input: &Value) -> Result<Value> {
        let default = crate::projects::folders::FolderRepository::new(self.database.clone())
            .ensure_default_workspace(owner)
            .await?;
        let workspace = text(
            input
                .get("workspaceId")
                .filter(|v| !v.is_null())
                .unwrap_or(&default["id"]),
        )?;
        anyhow::ensure!(
            !self
                .database
                .query(
                    "SELECT id FROM project_workspaces WHERE owner_id=$1 AND id=$2",
                    &[&owner, &workspace]
                )
                .await?
                .is_empty(),
            ImportWorkspaceError
        );
        let owner = owner.to_owned();
        let id = text(&input["id"])?;
        let worker = text(&input["workerId"])?;
        let label = input["nameProtection"].stringify();
        let blind = text(&input["repositoryBlindIndex"])?;
        let repository_id = text(&input["repositoryId"])?;
        let name = text(&input["nameWithOwner"])?;
        let url = text(&input["url"])?;
        let row = self.database.transaction(|tx| Box::pin(async move {
            let positions = tx.query("SELECT position FROM projects WHERE owner_id=$1 ORDER BY position DESC LIMIT 1", &[&owner]).await?;
            let position = positions.first().map(|r|r.get::<i32>(0)).transpose()?.map_or(0_i64, |p|p as i64+1).to_string();
            let rows = tx.query("INSERT INTO projects(id,owner_id,protected_label,position,origin_kind,setup_status,setup_error,preferred_worker_id,github_repository_blind_index,github_repository_id,github_repository_full_name,github_repository_url) VALUES($1,$2,$3::text::jsonb,$4::text::integer,'github','cloning',NULL,$5,$6,$7,$8,$9) RETURNING to_jsonb(projects)::text,created_at,updated_at", &[&id,&owner,&label,&position,&worker,&blind,&repository_id,&name,&url]).await?;
            let row = rows.into_iter().next().context("creating a GitHub project")?;
            tx.query("INSERT INTO project_workspace_memberships(workspace_id,project_id) VALUES($1,$2)", &[&workspace,&id]).await?;
            Ok(row)
        })).await?;
        crate::projects::repository::project(&raw(&row)?, Vec::new(), row.get(1)?, row.get(2)?)
    }
}
