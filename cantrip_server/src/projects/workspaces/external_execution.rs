//! Effective execution policy for the project's current workspace membership.
use super::*;
use cantrip_protocol::external_mcp::execution::ExecutionPolicy;

fn policy(row: &Row) -> Result<ExecutionPolicy> {
    Ok(serde_json::from_value(serde_json::Value::String(
        row.get::<String>(0)?,
    ))?)
}

impl WorkspaceRepository {
    pub(crate) async fn external_execution(
        &self,
        owner: &str,
        workspace: &str,
    ) -> Result<Option<ExecutionPolicy>> {
        let rows = self
            .database
            .query(
                "SELECT external_mcp_execution FROM project_workspaces WHERE owner_id=$1 AND id=$2",
                &[&owner, &workspace],
            )
            .await?;
        rows.first().map(policy).transpose()
    }

    pub(crate) async fn set_external_execution(
        &self,
        owner: &str,
        workspace: &str,
        desired: ExecutionPolicy,
    ) -> Result<Option<ExecutionPolicy>> {
        let wire = serde_json::to_value(desired)?;
        let desired = wire.as_str().context("Workspace execution policy")?;
        let rows = self.database.query(
            "UPDATE project_workspaces SET external_mcp_execution=$3,revision=revision+CASE WHEN external_mcp_execution<>$3 THEN 1 ELSE 0 END,updated_at=CASE WHEN external_mcp_execution<>$3 THEN $4 ELSE updated_at END WHERE owner_id=$1 AND id=$2 RETURNING external_mcp_execution",
            &[&owner, &workspace, &desired, &crate::auth::now()],
        ).await?;
        rows.first().map(policy).transpose()
    }

    pub(crate) async fn effective_external_execution(
        &self,
        owner: &str,
        project: &str,
    ) -> Result<ExecutionPolicy> {
        let rows = self.database.query(
            "SELECT w.external_mcp_execution FROM project_workspace_memberships m JOIN project_workspaces w ON w.id=m.workspace_id AND w.owner_id=$1 JOIN projects p ON p.id=m.project_id AND p.owner_id=$1 WHERE m.project_id=$2",
            &[&owner, &project],
        ).await?;
        Ok(rows.first().map(policy).transpose()?.unwrap_or_default())
    }
}
