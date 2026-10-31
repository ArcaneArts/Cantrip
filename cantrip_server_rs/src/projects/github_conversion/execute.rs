use super::{service::ConversionService, *};
use std::time::Duration;
impl ConversionService {
    pub(super) async fn perform(self: &Arc<Self>, claimed: &Value) -> Result<()> {
        let job = &claimed["job"];
        let owner = text(&claimed["ownerId"])?;
        let project = text(&job["projectId"])?;
        let id = text(&job["id"])?;
        let command = text(&claimed["commandId"])?;
        let worker_id = text(&job["workerId"])?;
        let Some(worker) =
            crate::projects::targets::TargetRepository::new(self.repository.database.clone())
                .worker(&owner, &job["workerId"])
                .await?
                .filter(|_| self.bridge.is_connected(&worker_id))
        else {
            let blocked = self
                .repository
                .block(
                    &id,
                    &command,
                    &json!({"code":"worker-offline","retryable":true}),
                )
                .await?;
            self.publish(&owner, &blocked);
            return Ok(());
        };
        let storage =
            crate::projects::folders::FolderRepository::new(self.repository.database.clone())
                .workspace_storage(&owner, &project)
                .await?
                .context("Project workspace storage is unavailable.")?;
        let source =
            crate::projects::repository::ProjectRepository::new(self.repository.database.clone())?
                .replicas(&owner, &project)
                .await?
                .unwrap_or_default()
                .into_iter()
                .find(|s| s["id"] == claimed["projectSourceId"]);
        let Some(source) =
            source.filter(|s| s["ready"] == true && s["workerId"] == job["workerId"])
        else {
            let failed = self
                .repository
                .fail(
                    &id,
                    &command,
                    &json!({"code":"project-not-ready","retryable":false}),
                )
                .await?;
            self.publish(&owner, &failed);
            return Ok(());
        };
        let external = source["sourceKind"] == "git" && source["ownershipKind"] == "user";
        let caps = &worker["managedFolders"];
        let truth = |key| crate::wire::coercion::truthy(caps.get(key));
        if !truth("convertToGithub")
            || (external && !truth("convertExternalGitToGithub"))
            || (!external && storage["kind"] == "managed" && !truth("workspaceScopedRoots"))
        {
            let failed = self
                .repository
                .fail(
                    &id,
                    &command,
                    &json!({"code":"capability-missing","retryable":false}),
                )
                .await?;
            self.publish(&owner, &failed);
            return Ok(());
        }
        let mut request = json!({"type":"project.folder-conversion.execute","jobId":job["id"],"attempt":job["attempt"],"projectId":job["projectId"],"repository":job["repository"],"workspaceStorage":storage,"confirmationToken":claimed["confirmationToken"],"initialCommit":claimed["initialCommit"]});
        if external {
            request["sourcePath"] = source["path"].clone();
            request["sourceDisplayPath"] = source["displayPath"].clone();
        }
        let response = self
            .commands
            .request(
                &worker_id,
                request,
                Some(Duration::from_secs(2 * 60 * 60)),
                None,
            )
            .await?;
        let result = crate::settings::parse_response(
            "projectGithubConversionExecutionResultSchema",
            response.as_ref(),
        )?;
        let settled = if result["status"] == "blocked" {
            if result["error"]["retryable"] == true {
                self.repository
                    .block(&id, &command, &result["error"])
                    .await?
            } else {
                self.repository
                    .fail(&id, &command, &result["error"])
                    .await?
            }
        } else {
            self.repository.complete(&id, &command, &result).await?
        };
        self.publish(&owner, &settled);
        Ok(())
    }
}
