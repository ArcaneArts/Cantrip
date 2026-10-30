//! Stop and reconcile active instances before deleting their persisted surfaces.
use super::{Repository, text};
use crate::{
    auth::service::AuthService,
    projects::targets::TargetRepository,
    wire::{Value, value::json},
};
use anyhow::{Result, ensure};
use std::time::Duration;

#[derive(Debug)]
pub struct TargetError {
    pub status: u16,
    pub worker_unavailable: bool,
    message: &'static str,
}
impl std::fmt::Display for TargetError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}
impl std::error::Error for TargetError {}
fn target_error(status: u16, message: &'static str) -> anyhow::Error {
    TargetError {
        status,
        message,
        worker_unavailable: false,
    }
    .into()
}
fn conflict(message: &'static str) -> anyhow::Error {
    super::lifecycle::ApiError {
        status: 409,
        code: "conflict",
        message: message.into(),
    }
    .into()
}
fn active(runtime: &Value) -> bool {
    matches!(
        runtime["state"].as_str(),
        Some("starting" | "running" | "restarting" | "stopping")
    )
}
fn invalidate(
    service: &AuthService,
    owner: &str,
    project: &str,
    resource: &str,
    entity: &str,
) -> Result<()> {
    service.live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"project","projectId":project}),"resource":resource,"action":"invalidated","entityId":entity,"revision":Value::Null,"payload":Value::Null}))?;
    Ok(())
}
pub async fn retire(
    service: &AuthService,
    owner: &str,
    project: &str,
    configuration: Option<&str>,
    worktree: Option<&str>,
) -> Result<()> {
    let repository = Repository::new(service.repository.database.clone());
    let targets = TargetRepository::new(service.repository.database.clone());
    let terminals = crate::terminals::Repository::new(service.repository.database.clone());
    loop {
        let runtimes = repository
            .list(owner, project, configuration, worktree, 256)
            .await?;
        if runtimes.is_empty() {
            return Ok(());
        }
        for current in &runtimes {
            if !active(current) {
                continue;
            }
            if !service
                .workers
                .bridge
                .is_connected(text(current, "workerId")?)
            {
                return Err(TargetError {
                    status:503,
                    worker_unavailable:true,
                    message:"Every active Run configuration worker must be online before deletion.",
                }.into());
            }
            let context = targets
                .worktree_context(owner, project, text(current, "worktreeId")?)
                .await?
                .filter(|context| context["worktree"]["lifecycleState"] == "ready")
                .ok_or_else(|| {
                    target_error(404, "The Run configuration target worktree is not ready.")
                })?;
            let worker = text(&context, "workerId")?;
            if !service.workers.bridge.is_connected(worker) {
                return Err(target_error(
                    503,
                    "The Run configuration target worker is offline.",
                ));
            }
            let admitted=repository.request_operation(owner,&json!({"operationId":uuid::Uuid::new_v4().to_string(),"projectId":project,"configurationId":current["configurationId"],"worktreeId":context["worktree"]["id"],"workerId":worker,"operation":"stop","definitionRevision":Value::Null,"codexEnvironmentRevision":Value::Null})).await?;
            let stopping = &admitted["runtime"];
            ensure!(
                stopping["terminalId"]
                    .as_str()
                    .is_some_and(|id| !id.is_empty()),
                conflict("An active Run configuration instance lost its terminal binding.")
            );
            let identity = json!({"runtimeId":stopping["id"],"projectId":stopping["projectId"],"configurationId":stopping["configurationId"],"worktreeId":stopping["worktreeId"],"workerId":stopping["workerId"],"definitionRevision":stopping["definitionRevision"],"codexEnvironmentRevision":stopping["codexEnvironmentRevision"],"generation":stopping["generation"],"operationId":stopping["requestedOperationId"],"terminalId":stopping["terminalId"]});
            let result = service
                .workers
                .commands
                .request(
                    worker,
                    json!({"type":"project.run-configuration-runtime.stop","identity":identity}),
                    Some(Duration::from_secs(30)),
                    None,
                )
                .await?;
            let result = crate::settings::parse_response(
                "runConfigurationRuntimeWorkerOperationResultSchema",
                result.as_ref(),
            )?;
            ensure!(
                matches!(result["outcome"].as_str(), Some("accepted" | "replayed"))
                    && !result["observation"].is_null(),
                conflict("The worker could not stop a Run configuration instance before deletion.")
            );
            let applied = repository
                .observe(owner, worker, &result["observation"])
                .await?;
            // Notifications can commit the matching stop before its reply.
            // Repository identity/generation/operation checks precede unchanged.
            let applied=applied.filter(|v|matches!(v["reason"].as_str(),Some("applied"|"unchanged")))
                .ok_or_else(|| conflict("The stopped Run configuration instance could not be reconciled before deletion."))?;
            let runtime = &applied["runtime"];
            ensure!(
                !active(runtime),
                conflict("The Run configuration instance remained active after its stop request.")
            );
            service
                .worker_maintenance
                .record_status(owner, text(runtime, "terminalId")?, "exited")
                .await?;
            invalidate(service, owner, project, "run", text(runtime, "id")?)?;
        }
        for runtime in &runtimes {
            let Some(terminal) = runtime["terminalId"].as_str().filter(|id| !id.is_empty()) else {
                continue;
            };
            ensure!(
                terminals.delete(owner, terminal).await?.is_some(),
                conflict("A Run configuration terminal changed before deletion.")
            );
            invalidate(service, owner, project, "terminal", terminal)?;
        }
        let ids = runtimes
            .iter()
            .map(|r| text(r, "id").map(str::to_owned))
            .collect::<Result<Vec<_>>>()?;
        ensure!(
            repository.delete(owner, project, &ids).await? == runtimes.len(),
            conflict("A Run configuration instance became active during deletion.")
        );
    }
}
