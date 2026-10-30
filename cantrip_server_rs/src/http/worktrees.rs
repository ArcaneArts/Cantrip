//! Owned worktree catalog and serialized worker mutations.
use super::{
    body,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    projects::{targets::TargetRepository, worktrees::MutationError},
    wire::Value,
    workers::command_bus::CommandFailure,
};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{MatchedPath, Path, Request, State},
    http::Method,
    response::Response,
    routing::{delete, get, post},
};
use std::{collections::HashMap, sync::Arc};

fn failure(error_value: anyhow::Error, fallback: u16) -> Result<Response> {
    if let Some(target) =
        error_value.downcast_ref::<crate::run_configurations::retirement::TargetError>()
    {
        return Ok(error(
            if target.worker_unavailable {
                503
            } else {
                fallback
            },
            target.to_string(),
        ));
    }
    if let Some(mutation) = error_value.downcast_ref::<MutationError>() {
        return output(
            if mutation.failure["mutation"]["outcome"] == "notStarted" {
                404
            } else {
                fallback
            },
            "worktreeCreateMutationFailureSchema",
            &mutation.failure,
        );
    }
    Ok(error(
        error_value
            .downcast_ref::<CommandFailure>()
            .map_or(fallback, |error| error.status(fallback)),
        crate::settings::operation_error_message(&error_value),
    ))
}
async fn execute(
    service: Arc<AuthService>,
    owner: String,
    params: HashMap<String, String>,
    route: &str,
    request: Request,
) -> Result<Response> {
    let project = &params["projectId"];
    if request.method() == Method::GET {
        let repository = TargetRepository::new(service.repository.database.clone());
        let rows = repository.worktrees(&owner, project).await?;
        if rows.is_empty()
            && repository
                .observation_source(&owner, project, &|_| false)
                .await?
                .is_none()
        {
            return Ok(error(404, "Project source not found."));
        }
        return output(200, "projectWorktreeListSchema", &Value::Array(rows));
    }
    let removing = request.method() == Method::DELETE;
    let body = match body::parse_js(request, 1_048_576).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let project_context =
        crate::projects::repository::ProjectRepository::new(service.repository.database.clone())?
            .get(&owner, project)
            .await?;
    if let Some(project_context) = project_context
        && project_context["capabilities"]["worktrees"] != true
    {
        return Ok(super::json_response(
            axum::http::StatusCode::CONFLICT,
            serde_json::json!({"code":"project-capability-unavailable","capability":"worktrees","error":format!("This {} project does not support the worktrees capability.",project_context["originKind"].as_str().unwrap_or("undefined"))}),
        ));
    }
    let action = if removing {
        "remove"
    } else {
        route.rsplit('/').next().unwrap()
    };
    let schema = match action {
        "worktrees" => Some("projectWorktreeCreateSchema"),
        "lock" => Some("projectWorktreeLockSchema"),
        "prune" => Some("projectWorktreePruneSchema"),
        "remove" => Some("projectWorktreeRemoveSchema"),
        _ => None,
    };
    let empty = Value::Object(Default::default());
    let parsed = if let Some(schema) = schema {
        let value = if action == "worktrees" {
            body.as_ref()
        } else {
            Some(body.as_ref().filter(|v| !v.is_null()).unwrap_or(&empty))
        };
        match parse(schema, value)? {
            Ok(value) => value,
            Err(response) => return Ok(response),
        }
    } else {
        empty
    };
    let response_owner = owner.clone();
    let response_project = project.clone();
    let response_entity = params.get("worktreeId").unwrap_or(project).clone();
    let result: Result<Response> = async {
        match action {
            "remove" => {
                let retirement_service = service.clone();
                let retirement_owner = owner.clone();
                let retirement_project = project.clone();
                let retirement_worktree = params["worktreeId"].clone();
                let retire = Box::pin(async move {
                    crate::run_configurations::retirement::retire(
                        &retirement_service,
                        &retirement_owner,
                        &retirement_project,
                        None,
                        Some(&retirement_worktree),
                    )
                    .await
                });
                match service
                    .worktrees
                    .remove(
                        owner,
                        project.clone(),
                        params["worktreeId"].clone(),
                        parsed,
                        retire,
                    )
                    .await?
                {
                    Some(row) => output(200, "projectWorktreeSummarySchema", &row),
                    None => Ok(error(404, "Worktree not found.")),
                }
            }
            "worktrees" => {
                let mut input = parsed;
                input["origin"] = Value::String("user".into());
                match service
                    .worktrees
                    .create(owner, project.clone(), input)
                    .await?
                {
                    Some(row) => output(201, "projectWorktreeSummarySchema", &row),
                    None => Ok(error(404, "Project source not found.")),
                }
            }
            "lock" | "unlock" => match service
                .worktrees
                .lock(
                    owner,
                    project.clone(),
                    params["worktreeId"].clone(),
                    (action == "lock").then(|| parsed["reason"].clone()),
                )
                .await?
            {
                Some(row) => output(200, "projectWorktreeSummarySchema", &row),
                None => Ok(error(404, "Worktree not found.")),
            },
            _ => {
                let rows = if action == "reconcile" {
                    service.worktrees.reconcile(owner, project.clone()).await?
                } else {
                    service
                        .worktrees
                        .prune(owner, project.clone(), parsed["allowExternal"].clone())
                        .await?
                };
                match rows {
                    Some(rows) => output(200, "projectWorktreeListSchema", &Value::Array(rows)),
                    None => Ok(error(404, "Project source not found.")),
                }
            }
        }
    }
    .await;
    match result {
        Ok(response) if response.status().is_success() => {
            let live = service.live.clone();
            Ok(super::on_response::completed(response, move || {
                use crate::wire::value::json;
                if let Err(error)=live.publish_event(json!({"ownerId":response_owner,"scope":json!({"kind":"project","projectId":response_project}),"resource":"worktree","action":"invalidated","entityId":response_entity,"revision":Value::Null,"payload":Value::Null})) {
                    use crate::operations::logging::{self,LogCall};
                    (logging::server_logger())(LogCall::event("error","Could not publish application live invalidation",json!({"err":json!({"message":error.to_string()}),"resource":"worktree"})));
                }
            }))
        }
        Ok(response) => Ok(response),
        Err(error) => failure(error, if action == "reconcile" { 502 } else { 409 }),
    }
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    route: MatchedPath,
    request: Request,
) -> Response {
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    let owned = service.clone();
    match service
        .project_operations
        .own(async move { execute(owned, owner, params, route.as_str(), request).await })
        .await
    {
        Ok(response) => response,
        Err(error) => middleware::failure(&service, &ctx.id, &error),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(
            "/api/projects/{projectId}/worktrees/{worktreeId}",
            delete(handle),
        )
        .route(
            "/api/projects/{projectId}/worktrees",
            get(handle).post(handle),
        )
        .route(
            "/api/projects/{projectId}/worktrees/reconcile",
            post(handle),
        )
        .route("/api/projects/{projectId}/worktrees/prune", post(handle))
        .route(
            "/api/projects/{projectId}/worktrees/{worktreeId}/lock",
            post(handle),
        )
        .route(
            "/api/projects/{projectId}/worktrees/{worktreeId}/unlock",
            post(handle),
        )
}
