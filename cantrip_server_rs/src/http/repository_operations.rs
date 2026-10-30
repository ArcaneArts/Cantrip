//! Worker-scoped encrypted repository operations. The server routes opaque
//! requests and responses; repository contents and paths stay at the endpoints.
use super::{
    body,
    middleware::{self, Context},
    on_response,
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService, projects::targets::TargetRepository, wire::Value,
    workers::command_bus::CommandFailure,
};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    response::Response,
    routing::post,
};
use std::{sync::Arc, time::Duration};

async fn execute(
    service: Arc<AuthService>,
    owner: &str,
    worker: &str,
    request: Request,
) -> Result<Response> {
    let body = match body::parse_js(request, 24 * 1_024 * 1_024).await {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    let input = match parse("repositoryWorkerOperationWireRequestSchema", body.as_ref())? {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    if TargetRepository::new(service.repository.database.clone())
        .worker(owner, &Value::String(worker.into()))
        .await?
        .is_none()
    {
        return Ok(error(404, "Worker not found."));
    }
    if !service.workers.bridge.is_connected(worker) {
        return Ok(error(503, "Worker is offline."));
    }
    if input["agent"] == true {
        return Ok(error(
            400,
            "Repository agent operations require a project worktree.",
        ));
    }
    let write = input["access"] != "read";
    let mut fields: Vec<(crate::wire::JsString, Value)> = vec![
        ("type".into(), Value::String("repository.operation".into())),
        (
            "serverId".into(),
            Value::String(service.server_id.clone().into()),
        ),
        ("projectId".into(), input["scopeId"].clone()),
        ("worktreeId".into(), Value::String(worker.into())),
        ("cwd".into(), Value::String(".".into())),
        ("sourcePath".into(), Value::String(".".into())),
        ("repository".into(), Value::Null),
        ("agentRuntimes".into(), Value::Array(Vec::new())),
        ("mcpServers".into(), Value::Array(Vec::new())),
        ("routingPurpose".into(), Value::String("repository".into())),
    ];
    fields.extend(
        input
            .as_object()
            .unwrap()
            .iter()
            .filter(|(key, _)| key.as_str() != Some("scopeId"))
            .map(|(key, value)| (key.clone(), value.clone())),
    );
    let result = async {
        let result = service
            .workers
            .commands
            .request(
                worker,
                Value::object(fields),
                Some(Duration::from_secs(30 * 60)),
                None,
            )
            .await?;
        let result = crate::settings::parse_response(
            "repositoryOperationWireResponseSchema",
            result.as_ref(),
        )?;
        output(200, "repositoryOperationWireResponseSchema", &result)
    }
    .await;
    match result {
        Ok(response) if write => {
            let live = service.live.clone();
            let owner = owner.to_owned();
            let worker = worker.to_owned();
            Ok(on_response::completed(response, move || {
                live.invalidate(&owner, "worker", &worker)
            }))
        }
        Ok(response) => Ok(response),
        Err(failure) => Ok(error(
            failure
                .downcast_ref::<CommandFailure>()
                .map_or(502, |failure| failure.status(502)),
            crate::settings::operation_error_message(&failure),
        )),
    }
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(worker): Path<String>,
    request: Request,
) -> Response {
    let owner = &ctx.principal.user.as_ref().unwrap().id;
    match execute(service.clone(), owner, &worker, request).await {
        Ok(response) => response,
        Err(error) => middleware::failure(&service, &ctx.id, &error),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new().route("/api/workers/{workerId}/repository-operation", post(handle))
}
