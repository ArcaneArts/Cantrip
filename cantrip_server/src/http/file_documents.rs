//! Immutable document catalog and opaque, checkout-bound worker operations.
use super::{
    body,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    file_documents::{BindingConflict, Repository},
    wire::{Value, value::json},
    workers::command_bus::CommandFailure,
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::Method,
    response::Response,
    routing::{get, post},
};
use std::{collections::HashMap, sync::Arc};

async fn operation(
    service: Arc<AuthService>,
    owner: String,
    id: String,
    input: Value,
) -> Result<Response> {
    let Some(context) = Repository::new(service.repository.database.clone())
        .execution_context(&owner, &id)
        .await?
    else {
        return Ok(error(404, "File document checkout is unavailable."));
    };
    let result = async {
        let command = json!({"type":"file-document.operation","documentId":context["id"],
            "serverId":service.server_id,"projectId":context["projectId"],"workerId":context["workerId"],
            "worktreeId":context["worktreeId"],"root":context["root"],"stateProtection":context["stateProtection"],
            "operationId":input["operationId"],"sequence":input["sequence"],"protectedRequest":input["protectedRequest"]});
        let result = service.workers.commands.request(context["workerId"].as_str().context("Document worker")?,command,None,None).await?;
        let result = crate::settings::parse_response("surfaceStreamWireResponseSchema",result.as_ref())?;
        output(200,"surfaceStreamWireResponseSchema",&result)
    }.await;
    Ok(match result {
        Ok(response) => response,
        Err(cause) => error(
            cause
                .downcast_ref::<CommandFailure>()
                .map_or(502, |failure| failure.status(502)),
            crate::settings::operation_error_message(&cause),
        ),
    })
}
async fn create(
    service: Arc<AuthService>,
    owner: String,
    project: String,
    input: Value,
) -> Result<Response> {
    match Repository::new(service.repository.database.clone())
        .create(&owner, &project, &input)
        .await
    {
        Ok(Some(value)) => output(200, "fileDocumentWireSummarySchema", &value),
        Ok(None) => Ok(error(404, "Project or available worktree not found.")),
        Err(cause) if cause.is::<BindingConflict>() => Ok(error(409, cause.to_string())),
        Err(cause) => Err(cause),
    }
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    let mutation = request.method() == Method::POST;
    let is_operation = request.uri().path().ends_with("/operation");
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    let event_owner = owner.clone();
    let event_project = params.get("projectId").cloned();
    let result: Result<Response> = async {
        if !mutation {
            let repository = Repository::new(service.repository.database.clone());
            return if let Some(project) = params.get("projectId") {
                output(
                    200,
                    "fileDocumentWireListSchema",
                    &Value::Array(repository.list(&owner, project).await?),
                )
            } else {
                match repository
                    .get(&owner, params.get("documentId").context("Document route")?)
                    .await?
                {
                    Some(value) => output(200, "fileDocumentWireSummarySchema", &value),
                    None => Ok(error(404, "File document not found.")),
                }
            };
        }
        let raw = match body::parse_js(
            request,
            if is_operation {
                4 * 1024 * 1024
            } else {
                service.config.api_body_limit_bytes
            },
        )
        .await
        {
            Ok(value) => value,
            Err(response) => return Ok(response),
        };
        let input = match parse(
            if is_operation {
                "surfaceStreamWireRequestSchema"
            } else {
                "fileDocumentCreateSchema"
            },
            raw.as_ref(),
        )? {
            Ok(value) => value,
            Err(response) => return Ok(response),
        };
        if is_operation {
            service
                .worker_maintenance
                .owned(operation(
                    service.clone(),
                    owner,
                    params
                        .get("documentId")
                        .context("Document operation route")?
                        .clone(),
                    input,
                ))
                .await
        } else {
            service
                .worker_maintenance
                .owned(create(
                    service.clone(),
                    owner,
                    params
                        .get("projectId")
                        .context("Document project route")?
                        .clone(),
                    input,
                ))
                .await
        }
    }
    .await;
    let response = result.unwrap_or_else(|cause| middleware::failure(&service, &ctx.id, &cause));
    if mutation && !is_operation && response.status().as_u16() < 400 {
        let live = service.live.clone();
        super::on_response::completed(response, move || {
            let _ = live.publish_event(json!({"ownerId":event_owner,"scope":json!({"kind":"project","projectId":event_project}),"resource":"file-document","action":"invalidated","entityId":event_project,"revision":Value::Null,"payload":Value::Null}));
        })
    } else {
        response
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(
            "/api/projects/{projectId}/file-documents",
            get(handle).post(handle),
        )
        .route("/api/file-documents/{documentId}", get(handle))
        .route("/api/file-documents/{documentId}/operation", post(handle))
}
