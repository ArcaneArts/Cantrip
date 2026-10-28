use super::{
    body, json_response,
    middleware::{self, Context},
    on_response,
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    projects::{folders::FolderError, repository::ProjectRepository, targets::TargetRepository},
    wire::{Value, coercion},
};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::{get, post},
};
use std::{collections::HashMap, sync::Arc};

async fn mutate(
    service: Arc<AuthService>,
    owner: String,
    project: Option<String>,
    input: Value,
) -> Result<Response> {
    if let Some(id) = project {
        let Some(project) = ProjectRepository::new(service.repository.database.clone())?
            .get(&owner, &id)
            .await?
        else {
            return Ok(error(404, "Project not found."));
        };
        if project["originKind"] != "managed-folder" {
            return Ok(json_response(
                StatusCode::CONFLICT,
                Value::object([
                    (
                        "code",
                        Value::String("managed-folder-capability-unavailable".into()),
                    ),
                    (
                        "error",
                        Value::String(
                            "Folder setup retry is available only for folder projects.".into(),
                        ),
                    ),
                ]),
            ));
        }
        let Some(job) = service
            .folder_setup
            .repository
            .retry(&owner, &id, &input["stateRevision"])
            .await?
        else {
            return Ok(error(409, "Folder setup changed or is not retryable."));
        };
        service.folder_setup.publish(&owner, &job);
        service.folder_setup.queue();
        return output(200, "projectFolderSetupJobSummarySchema", &job);
    }
    let Some(worker) = TargetRepository::new(service.repository.database.clone())
        .worker(&owner, &input["workerId"])
        .await?
    else {
        return Ok(error(404, "Worker not found."));
    };
    anyhow::ensure!(
        !worker["managedFolders"].is_null(),
        "Cannot read managed folder capabilities from null"
    );
    let denied = if !coercion::truthy(worker["managedFolders"].get("create")) {
        Some("This worker does not support managed folder creation.")
    } else if coercion::truthy(input.get("existingPath"))
        && !coercion::truthy(worker["managedFolders"].get("attachExisting"))
    {
        Some("This worker does not support attaching existing folders.")
    } else {
        None
    };
    if let Some(message) = denied {
        return Ok(json_response(
            StatusCode::CONFLICT,
            Value::object([
                (
                    "code",
                    Value::String("managed-folder-capability-unavailable".into()),
                ),
                ("error", Value::String(message.into())),
            ]),
        ));
    }
    match service.folder_setup.repository.create(&owner, &input).await {
        Ok(created) => {
            service.folder_setup.publish(&owner, &created["job"]);
            service.folder_setup.queue();
            output(202, "projectWireSummarySchema", &created["project"])
        }
        Err(e)
            if matches!(
                e.downcast_ref::<FolderError>(),
                Some(FolderError::Workspace(_))
            ) =>
        {
            Ok(error(400, e.to_string()))
        }
        Err(e) => Err(e),
    }
}
async fn execute(
    service: Arc<AuthService>,
    ctx: &Context,
    params: HashMap<String, String>,
    request: Request,
) -> Result<Response> {
    let owner = ctx
        .principal
        .user
        .as_ref()
        .expect("Authenticated folder owner")
        .id
        .clone();
    if matches!(*request.method(), Method::GET | Method::HEAD) {
        let id = &params["projectId"];
        let Some(project) = ProjectRepository::new(service.repository.database.clone())?
            .get(&owner, id)
            .await?
        else {
            return Ok(error(404, "Project not found."));
        };
        if project["originKind"] != "managed-folder" {
            return Ok(json_response(
                StatusCode::CONFLICT,
                Value::object([
                    (
                        "code",
                        Value::String("managed-folder-capability-unavailable".into()),
                    ),
                    (
                        "error",
                        Value::String("Folder setup is available only for folder projects.".into()),
                    ),
                ]),
            ));
        }
        return match service.folder_setup.repository.get(&owner, id).await? {
            Some(job) => output(200, "projectFolderSetupJobSummarySchema", &job),
            None => Ok(error(404, "Folder setup job not found.")),
        };
    }
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(v) => v,
        Err(r) => return Ok(r),
    };
    let schema = if params.contains_key("projectId") {
        "projectFolderSetupRetrySchema"
    } else {
        "encryptedManagedFolderProjectCreateSchema"
    };
    let input = match parse(schema, body.as_ref())? {
        Ok(v) => v,
        Err(r) => return Ok(r),
    };
    let operation = mutate(
        service.clone(),
        owner,
        params.get("projectId").cloned(),
        input,
    );
    service.folder_setup.owned(operation).await
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    let mutation = request.method() == Method::POST;
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    let project = params.get("projectId").cloned();
    match execute(service.clone(), &ctx, params, request).await {
        Ok(response) if mutation && response.status().as_u16() < 400 => {
            let live = service.live.clone();
            on_response::completed(response, move || {
                if let Some(project) = project {
                    let _ = live.publish_event(Value::object([
                        ("ownerId", Value::String(owner.into())),
                        (
                            "scope",
                            Value::object([
                                ("kind", Value::String("project".into())),
                                ("projectId", Value::String(project.clone().into())),
                            ]),
                        ),
                        ("resource", Value::String("project".into())),
                        ("action", Value::String("invalidated".into())),
                        ("entityId", Value::String(project.into())),
                        ("revision", Value::Null),
                        ("payload", Value::Null),
                    ]));
                } else {
                    live.invalidate_resource(&owner, "project");
                }
            })
        }
        Ok(response) => response,
        Err(e) => middleware::failure(&service, &ctx.id, &e),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/projects/from-folder", post(handle))
        .route("/api/projects/{projectId}/folder-setup", get(handle))
        .route("/api/projects/{projectId}/folder-setup/retry", post(handle))
}
