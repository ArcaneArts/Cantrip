use super::*;
async fn plan(executor: Executor<'_, '_>, owner: &str, id: &str) -> Result<Option<Value>> {
    let rows=executor.query("SELECT w.is_default,s.kind FROM project_workspaces w INNER JOIN project_workspace_storage_profiles s ON s.workspace_id=w.id WHERE w.id=$1 AND w.owner_id=$2 LIMIT 1", &[&id,&owner]).await?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    anyhow::ensure!(
        !row.get::<bool>(0)? && row.get::<String>(1)? != "system",
        invariant("The Default workspace cannot be deleted.")
    );
    let rows = executor
        .query(
            "SELECT project_id FROM project_workspace_memberships WHERE workspace_id=$1",
            &[&id],
        )
        .await?;
    Ok(Some(
        json!({"projectIds":rows.iter().map(|r|r.get::<String>(0).map(|s|json!(s))).collect::<Result<Vec<_>>>()?}),
    ))
}
impl WorkspaceRepository {
    pub async fn deletion_plan(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        plan(Executor::Database(&self.database), owner, id).await
    }
    pub async fn delete(&self, owner: &str, id: &str) -> Result<bool> {
        let (owner, id) = (owner.to_owned(), id.to_owned());
        self.database.transaction(|tx|Box::pin(async move {
            let Some(plan)=plan(Executor::Transaction(tx),&owner,&id).await? else{return Ok(false)};
            let ids=plan["projectIds"].as_array().context("Workspace deletion projects")?;
            if !ids.is_empty() {
                tx.query("DELETE FROM projects WHERE owner_id=$1 AND id IN (SELECT jsonb_array_elements_text($2::jsonb))", &[&owner,&postgres_types::Json(&plan["projectIds"])]).await?;
                for project in ids {
                    let project=text(project)?;let at=crate::auth::now();
                    tx.query("UPDATE user_settings SET mobile_project_tab_configurations=mobile_project_tab_configurations-$2::text,updated_at=$3 WHERE user_id=$1", &[&owner,&project,&at]).await?;
                }
            }
            Ok(tx.query("DELETE FROM project_workspaces WHERE id=$1 AND owner_id=$2 RETURNING id", &[&id,&owner]).await?.len()==1)
        })).await
    }
}
