//! Remove server records and stop runtimes while preserving every worker path.
use super::*;
use crate::auth::service::AuthService;
impl WorkspaceRepository {
    pub async fn project_removal_context(
        &self,
        owner: &str,
        project: &str,
    ) -> Result<Option<Value>> {
        let rows = self
            .database
            .query(
                "SELECT to_jsonb(p)::text FROM projects p WHERE id=$1 AND owner_id=$2 LIMIT 1",
                &[&project, &owner],
            )
            .await?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let row = raw(row)?;
        let storage = super::super::folders::FolderRepository::new(self.database.clone())
            .workspace_storage(owner, project)
            .await?
            .ok_or_else(|| invariant("Project workspace storage is unavailable."))?;
        let converted = if row["origin_kind"] == "github" {
            super::super::github_conversion::ConversionRepository::new(self.database.clone())
                .converted_source(owner, project)
                .await?
                .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        let sources=self.database.query("SELECT id,worker_id,absolute_path,ownership_kind FROM project_sources WHERE project_id=$1 AND removed_at IS NULL ORDER BY created_at ASC,id ASC", &[&project]).await?;
        let terminals = self
            .database
            .query(
                "SELECT id,active_worker_id FROM terminals WHERE project_id=$1",
                &[&project],
            )
            .await?;
        let surfaces = self
            .database
            .query(
                "SELECT id,worker_id FROM remote_surfaces WHERE project_id=$1",
                &[&project],
            )
            .await?;
        let replicas=sources.iter().map(|r|Ok(json!({"id":r.get::<String>(0)?,"workerId":r.get::<String>(1)?,"cwd":r.get::<String>(2)?,"ownershipKind":r.get::<String>(3)?}))).collect::<Result<Vec<_>>>()?;
        let resources = |rows: Vec<Row>| {
            rows.iter()
                .map(|r| Ok(json!({"id":r.get::<String>(0)?,"workerId":r.get::<String>(1)?})))
                .collect::<Result<Vec<_>>>()
        };
        Ok(Some(
            json!({"convertedManagedFolderSource":converted,"folderManagement":row["folder_management"],"originKind":row["origin_kind"],"preferredWorkerId":row["preferred_worker_id"],"replicas":replicas,"remoteSurfaces":resources(surfaces)?,"setupStatus":row["setup_status"],"workspaceStorage":storage,"terminals":resources(terminals)?}),
        ))
    }
    pub async fn delete_project(&self, owner: &str, project: &str) -> Result<bool> {
        if self
            .database
            .query(
                "DELETE FROM projects WHERE id=$1 AND owner_id=$2 RETURNING id",
                &[&project, &owner],
            )
            .await?
            .len()
            != 1
        {
            return Ok(false);
        };
        self.database.query("UPDATE user_settings SET mobile_project_tab_configurations=mobile_project_tab_configurations-$2::text,updated_at=$3 WHERE user_id=$1", &[&owner,&project,&crate::auth::now()]).await?;
        Ok(true)
    }
}
async fn attempt<T>(
    project: &str,
    stage: &str,
    operation: impl std::future::Future<Output = Result<T>>,
) {
    if operation.await.is_err() {
        eprintln!(
            "{}",
            serde_json::json!({"level":"warn","event":"workspace.project.runtime-cleanup-failed","subsystem":"workspace","projectId":project,"stage":stage})
        );
    }
}
pub async fn preserving_files(
    service: Arc<AuthService>,
    owner: String,
    project: String,
    context: Value,
) -> Result<bool> {
    attempt(
        &project,
        "project-share",
        service
            .project_shares
            .revoke_managed_resource(&owner, &project),
    )
    .await;
    let coordinator = service.project_operations.clone();
    coordinator
        .serialize(&owner.clone(), &project.clone(), false, move || {
            Box::pin(async move {
                let terminals = context["terminals"]
                    .as_array()
                    .context("Project removal terminals")?;
                futures::future::join_all(terminals.iter().map(|t| async {
                    service
                        .worker_links
                        .revoke_resource(
                            &owner,
                            "terminal",
                            t["id"].as_str().unwrap(),
                            "resource-deleted",
                        )
                        .await;
                }))
                .await;
                attempt(
                    &project,
                    "run-configurations",
                    crate::run_configurations::retirement::retire(
                        &service, &owner, &project, None, None,
                    ),
                )
                .await;
                let mut commands = Vec::new();
                for (key, kind, identity, stage) in [
                    ("terminals", "terminal.close", "terminalId", "terminal"),
                    (
                        "remoteSurfaces",
                        "surface.close",
                        "surfaceId",
                        "remote-surface",
                    ),
                ] {
                    for resource in context[key]
                        .as_array()
                        .context("Project removal resources")?
                    {
                        let worker = text(&resource["workerId"])?;
                        if service.workers.bridge.is_connected(&worker) {
                            let command = Value::object([
                                ("type", json!(kind)),
                                (identity, resource["id"].clone()),
                            ]);
                            let service = service.clone();
                            let project = project.clone();
                            commands.push(async move {
                                attempt(&project, stage, async {
                                    Ok(service
                                        .workers
                                        .commands
                                        .request(&worker, command, None, None)
                                        .await?)
                                })
                                .await;
                            });
                        }
                    }
                }
                futures::future::join_all(commands).await;
                WorkspaceRepository::new(service.repository.database.clone())
                    .delete_project(&owner, &project)
                    .await
            })
        })
        .await
}
