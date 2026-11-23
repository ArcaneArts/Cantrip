use super::*;
use std::collections::HashMap;
impl WorkspaceRepository {
    pub async fn list(&self, owner: &str) -> Result<Value> {
        super::super::folders::FolderRepository::new(self.database.clone())
            .ensure_default_workspace(owner)
            .await?;
        let parameters: crate::database::Parameters<'_> = &[&owner];
        let (workspaces, profiles, memberships) = tokio::try_join!(
            self.database.query("SELECT to_jsonb(w)::text FROM project_workspaces w WHERE owner_id=$1 ORDER BY position ASC,created_at ASC", parameters),
            self.database.query("SELECT to_jsonb(s)::text FROM project_workspace_storage_profiles s INNER JOIN project_workspaces w ON w.id=s.workspace_id WHERE w.owner_id=$1", parameters),
            self.database.query("SELECT m.workspace_id,m.project_id FROM project_workspace_memberships m INNER JOIN project_workspaces w ON w.id=m.workspace_id WHERE w.owner_id=$1", parameters)
        )?;
        let mut projects = HashMap::<String, Vec<Value>>::new();
        for row in memberships {
            projects
                .entry(row.get(0)?)
                .or_default()
                .push(json!(row.get::<String>(1)?));
        }
        let mut storage = HashMap::new();
        for row in profiles {
            let profile = raw(&row)?;
            storage.insert(text(&profile["workspace_id"])?, profile);
        }
        let mut summaries = Vec::new();
        for row in workspaces {
            let row = raw(&row)?;
            let id = text(&row["id"])?;
            let profile = storage
                .get(&id)
                .ok_or_else(|| invariant(format!("Workspace {id} has no storage profile.")))?;
            summaries.push(summary(
                &row,
                profile,
                projects.remove(&id).unwrap_or_default(),
            )?);
        }
        Ok(json!({"workspaces":summaries}))
    }
}
