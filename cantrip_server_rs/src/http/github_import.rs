//! Protected GitHub import; repository identity remains an opaque routing handle.
use super::{
    body, json_response,
    middleware::{self, Context},
    on_response,
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    projects::{replicas::github_import::ImportWorkspaceError, targets::TargetRepository},
    wire::{Value, coercion, value::json},
    workers::command_bus::CommandFailure,
};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{Request, State},
    http::StatusCode,
    response::Response,
    routing::post,
};
use std::sync::Arc;
const DUPLICATE: &str = "This GitHub repository already has a Cantrip project.";
async fn create(service: Arc<AuthService>, owner: String, input: Value) -> Result<Response> {
    let repository = &service.project_replicas.repository;
    let blind = input["repositoryBlindIndex"].as_str().unwrap();
    if repository.has_github_project(&owner, blind).await? {
        return Ok(error(409, DUPLICATE));
    }
    let Some(worker) = TargetRepository::new(service.repository.database.clone())
        .worker(&owner, &input["workerId"])
        .await?
    else {
        return Ok(error(404, "Worker not found."));
    };
    let placement = input
        .get("placement")
        .cloned()
        .unwrap_or_else(|| json!({"mode":"managed"}));
    let caps = &worker["projectReplicas"];
    let supports = if placement["mode"] == "managed" {
        true
    } else {
        anyhow::ensure!(
            !caps.is_null(),
            "Cannot read project replica capabilities from null"
        );
        let truth = |key| coercion::truthy(caps.get(key));
        if placement["mode"] == "managed-link" {
            truth("managedLinkPlacement") && truth("recursiveParentCreation")
        } else {
            truth("directPlacement") && truth("attachExisting") && truth("recursiveParentCreation")
        }
    };
    if !supports {
        return Ok(json_response(
            StatusCode::CONFLICT,
            json!({"code":"placement-unsupported","error":"The selected worker does not support this repository placement mode."}),
        ));
    }
    let result: Result<Response> = async {
        let project = repository.create_github_project(&owner, &input).await?;
        let id = project["id"].as_str().unwrap();
        let request = json!({"workerId":input["workerId"],"repository":input["nameWithOwner"],"placement":placement,"expectedRevision":Value::Null,"idempotencyKey":format!("project-import:{id}:{}",input["workerId"].as_str().unwrap())});
        let job = repository.create_provision(&owner, id, &request).await?;
        service.project_replicas.publish(&owner, &job);
        service.project_replicas.queue();
        output(202, "projectWireSummarySchema", &project)
    }.await;
    match result {
        Ok(response) => Ok(response),
        Err(e) if e.downcast_ref::<ImportWorkspaceError>().is_some() => {
            Ok(error(400, e.to_string()))
        }
        Err(e) => {
            if repository.has_github_project(&owner, blind).await? {
                return Ok(error(409, DUPLICATE));
            }
            Ok(error(
                e.downcast_ref::<CommandFailure>()
                    .map_or(502, |e| e.status(502)),
                crate::settings::operation_error_message(&e),
            ))
        }
    }
}
async fn execute(service: Arc<AuthService>, owner: String, request: Request) -> Result<Response> {
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let input = match parse("encryptedGithubProjectCreateSchema", body.as_ref())? {
        Ok(input) => input,
        Err(response) => return Ok(response),
    };
    service
        .project_replicas
        .owned(create(service.clone(), owner, input))
        .await
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    request: Request,
) -> Response {
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    match execute(service.clone(), owner.clone(), request).await {
        Ok(response) if response.status().as_u16() < 400 => {
            let live = service.live.clone();
            on_response::completed(response, move || {
                live.invalidate_resource(&owner, "project")
            })
        }
        Ok(response) => response,
        Err(e) => middleware::failure(&service, &ctx.id, &e),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new().route("/api/projects/from-github", post(handle))
}
