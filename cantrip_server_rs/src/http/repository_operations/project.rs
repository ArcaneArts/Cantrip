use super::*;
use crate::{
    operations::logging::{self, LogCall},
    projects::repository_operation::{self as operation, Rejection},
    settings::{repository::SettingsRepository, telemetry::repository_agent::RepositoryAgentUsage},
    wire::value::json,
};
use anyhow::Context as _;

async fn execute(
    service: Arc<AuthService>,
    owner: String,
    project: String,
    worktree: String,
    request: Request,
) -> Result<Response> {
    let body = match body::parse_js(request, 24 * 1_024 * 1_024).await {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    let input = match parse("repositoryOperationWireRequestSchema", body.as_ref())? {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    let binding = match operation::context(
        service.repository.database.clone(),
        &service.workers.bridge,
        &owner,
        &project,
        &worktree,
        &input,
    )
    .await
    {
        Ok(binding) => binding,
        Err(failure) => {
            return match failure.downcast_ref::<Rejection>() {
                Some(rejected) => Ok(error(rejected.status, rejected.message)),
                None => Err(failure),
            };
        }
    };
    let result: Result<Response> = async {
        let prepared = operation::prepare(service.repository.database.clone(), &service.model_routing,
            &service.server_id, &owner, binding, &input).await?;
        let worker = prepared.worker.clone();
        let commands = service.workers.commands.clone();
        let result = service.project_operations.serialize(&owner, &project, input["access"] == "write", move || {
            Box::pin(async move {
                commands.request(&prepared.worker, prepared.command,
                    Some(Duration::from_secs(30 * 60)), None).await
                    .map_err(Into::into)
            })
        }).await?;
        // Source notifies on successful dispatch before parsing the response.
        let result = crate::settings::parse_response("repositoryOperationWireResponseSchema", result.as_ref())?;
        if !result["agentExecution"].is_null() {
            let execution = &result["agentExecution"];
            let Some(runtime) = prepared.agent_runtimes.iter().find(|runtime| runtime["routeId"] == execution["routeId"]) else {
                return Ok(error(502, "Worker returned an unknown repository agent route."));
            };
            let version: serde_json::Value = serde_json::from_slice(include_bytes!(concat!(env!("OUT_DIR"), "/version.json")))?;
            let operation_id = input["operationId"].as_str().context("Repository operation identity")?;
            let persisted = SettingsRepository::new(service.repository.database.clone()).record_repository_agent_usage(RepositoryAgentUsage {
                owner: &owner, project: &project, worker: &worker, operation: operation_id, runtime, execution,
                server_version: version["version"].as_str().context("Embedded server version")?,
            }).await;
            match persisted {
                Ok(()) => operation::publish(&service.live, &owner, &project, "project-token-usage"),
                Err(failure) => (logging::server_logger())(LogCall::event("warn", "Unable to persist token usage analytics",
                    json!({"err":json!({"message":failure.to_string()}),"sourceKey":format!("git-agent:{operation_id}:{}",runtime["routeId"].as_str().unwrap_or_default())}))),
            }
        }
        output(200, "repositoryOperationWireResponseSchema", &result)
    }.await;
    match result {
        Ok(response) if response.status().as_u16() < 400 && input["access"] == "write" => {
            let live = service.live.clone();
            Ok(on_response::completed(response, move || {
                let _ = live.publish_event(json!({"ownerId":owner,
                    "scope":json!({"kind":"project","projectId":project}),
                    "resource":"worktree","action":"invalidated","entityId":worktree,
                    "revision":Value::Null,"payload":Value::Null}));
            }))
        }
        Ok(response) => Ok(response),
        Err(failure) => {
            if let Some(rejected) = failure.downcast_ref::<Rejection>() {
                return Ok(error(rejected.status, rejected.message));
            }
            Ok(error(
                failure
                    .downcast_ref::<CommandFailure>()
                    .map_or(502, |failure| failure.status(502)),
                crate::settings::operation_error_message(&failure),
            ))
        }
    }
}

pub(super) async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path((project, worktree)): Path<(String, String)>,
    request: Request,
) -> Response {
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    let owned = service.clone();
    match service
        .project_operations
        .own(async move { execute(owned, owner, project, worktree, request).await })
        .await
    {
        Ok(response) => response,
        Err(failure) => middleware::failure(&service, &ctx.id, &failure),
    }
}
