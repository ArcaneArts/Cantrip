//! Project preference, catalog ordering and explicit owned removal endpoints.
use super::{
    body, json_response,
    middleware::{self, Context},
    on_response,
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    projects::{
        removal,
        repository::{PreferredWorkerConflict, ProjectRepository},
    },
    wire::{Value, value::json},
    workers::command_bus::CommandFailure,
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    body::Body,
    extract::{MatchedPath, Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::{delete, patch},
};
use std::{collections::HashMap, sync::Arc};

fn rejection(value: &removal::Rejection) -> Response {
    let mut body = json!({"error":value.message});
    if let Some(code) = value.code {
        body["code"] = json!(code);
    }
    json_response(StatusCode::from_u16(value.status).unwrap(), body)
}
fn worker_failure(failure: &anyhow::Error) -> Response {
    if let Some(policy) = failure.downcast_ref::<removal::Rejection>() {
        return rejection(policy);
    }
    let status = if failure
        .downcast_ref::<crate::run_configurations::retirement::TargetError>()
        .is_some_and(|e| e.worker_unavailable)
    {
        503
    } else {
        failure
            .downcast_ref::<CommandFailure>()
            .map_or(502, |e| e.status(502))
    };
    error(status, crate::settings::operation_error_message(failure))
}
async fn execute(
    service: Arc<AuthService>,
    owner: String,
    project: Option<String>,
    route: String,
    method: Method,
    request: Request,
) -> Result<Response> {
    let binary_limit = (service.config.upload_limit_bytes * 3).div_ceil(2) + 1024 * 1024;
    let body =
        match body::parse_js_buffer(request, service.config.api_body_limit_bytes, binary_limit)
            .await
        {
            Ok(value) => value,
            Err(response) => return Ok(response),
        };
    let removing = method == Method::DELETE;
    let capability = if route.ends_with("/preferred-worker") {
        Some("relocation")
    } else if route.ends_with("/worktree-policy") {
        Some("worktrees")
    } else {
        None
    };
    // Source's project pre-handler runs after its body parser and before the
    // route's schema validation, including for malformed preference inputs.
    if let (Some(capability), Some(project)) = (capability, project.as_deref())
        && let Some(value) = ProjectRepository::new(service.repository.database.clone())?
            .get(&owner, project)
            .await?
        && value["capabilities"][capability] != true
    {
        return Ok(json_response(
            StatusCode::CONFLICT,
            json!({"code":"project-capability-unavailable","capability":capability,"error":format!("This {} project does not support the {capability} capability.",value["originKind"].as_str().unwrap_or("undefined"))}),
        ));
    }
    let default = Value::Object(Default::default());
    let raw = if removing {
        Some(body.as_ref().filter(|v| !v.is_null()).unwrap_or(&default))
    } else {
        body.as_ref()
    };
    let schema = if removing {
        "projectRemoveSchema"
    } else if route == "/api/projects/order" {
        "orderedIdsSchema"
    } else if route.ends_with("/preferred-worker") {
        "projectPreferredWorkerUpdateSchema"
    } else {
        "projectWorktreePolicyUpdateSchema"
    };
    let input = match parse(schema, raw)? {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    if removing {
        let project = project.context("Project removal identity")?;
        let Some(context) = removal::prepare(&service, &owner, &project).await? else {
            return Ok(error(404, "Project not found."));
        };
        return Ok(
            match removal::execute(
                service,
                owner,
                project,
                context,
                input["deleteLocalFiles"] == true,
            )
            .await
            {
                Ok(true) => Response::builder()
                    .status(StatusCode::NO_CONTENT)
                    .body(Body::empty())
                    .unwrap(),
                Ok(false) => error(404, "Project not found."),
                Err(failure) => worker_failure(&failure),
            },
        );
    }
    let repository = ProjectRepository::new(service.repository.database.clone())?;
    if route == "/api/projects/order" {
        let ids = input["ids"]
            .as_array()
            .context("Ordered project identities")?
            .iter()
            .map(|v| v.as_js_string().cloned().context("Project identity"))
            .collect::<Result<Vec<_>>>()?;
        return Ok(if repository.reorder(&owner, ids).await? {
            Response::builder()
                .status(StatusCode::NO_CONTENT)
                .body(Body::empty())
                .unwrap()
        } else {
            error(400, "Project order did not match.")
        });
    }
    let project = project.context("Project preference identity")?;
    let preferred = route.ends_with("/preferred-worker");
    let result = if preferred {
        let worker = if input["workerId"].is_null() {
            None
        } else {
            Some(
                input["workerId"]
                    .as_js_string()
                    .context("Preferred worker")?
                    .clone(),
            )
        };
        repository
            .update_preferred_worker(&owner, &project, worker)
            .await?
    } else {
        repository
            .update_worktree_policy(
                &owner,
                &project,
                input["policy"].as_str().context("Worktree policy")?,
            )
            .await?
    };
    match result {
        Some(value) => output(200, "projectWireSummarySchema", &value),
        None => Ok(error(
            404,
            if preferred {
                "Project or worker not found."
            } else {
                "Project not found."
            },
        )),
    }
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    params: Option<Path<HashMap<String, String>>>,
    matched: MatchedPath,
    request: Request,
) -> Response {
    let owner = context.principal.user.as_ref().unwrap().id.clone();
    let project = params
        .and_then(|Path(mut values)| values.remove("projectId"))
        .or_else(|| {
            (request.method() == Method::DELETE && static_project_id(matched.as_str()).is_some())
                .then(|| static_project_id(matched.as_str()).unwrap().to_owned())
        });
    let entity = project.clone();
    let event_owner = owner.clone();
    let route = matched.as_str().to_owned();
    let method = request.method().clone();
    let owned = service.clone();
    match service
        .project_operations
        .own(async move { execute(owned, owner, project, route, method, request).await })
        .await
    {
        Ok(response) if response.status().as_u16() < 400 => {
            let live = service.live.clone();
            on_response::completed(response, move || {
                let scope = entity.as_ref().map_or_else(
                    || json!({"kind":"current-user"}),
                    |id| json!({"kind":"project","projectId":id}),
                );
                let _=live.publish_event(json!({"ownerId":event_owner,"scope":scope,"resource":"project","action":"invalidated","entityId":entity,"revision":Value::Null,"payload":Value::Null}));
            })
        }
        Ok(response) => response,
        Err(failure) => {
            if let Some(policy) = failure.downcast_ref::<removal::Rejection>() {
                return rejection(policy);
            }
            if let Some(conflict) = failure.downcast_ref::<PreferredWorkerConflict>() {
                return json_response(
                    StatusCode::CONFLICT,
                    json!({"code":"target-mismatch","error":conflict.0}),
                );
            }
            middleware::failure(&service, &context.id, &failure)
        }
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/projects/{projectId}", delete(handle))
        // Fastify resolves routes by method before choosing static/dynamic
        // paths. Axum otherwise hides a project whose actual ID is "order".
        .route("/api/projects/order", patch(handle).delete(handle))
        .route("/api/projects/from-folder", delete(handle))
        .route("/api/projects/from-github", delete(handle))
        .route("/api/projects/{projectId}/preferred-worker", patch(handle))
        .route("/api/projects/{projectId}/worktree-policy", patch(handle))
}

pub(super) fn unregistered_method(method: &Method, route: &str) -> bool {
    match route {
        "/api/projects/:projectId" => method != Method::DELETE,
        "/api/projects/:projectId/preferred-worker"
        | "/api/projects/:projectId/worktree-policy" => method != Method::PATCH,
        "/api/projects/order" => method != Method::PATCH && method != Method::DELETE,
        "/api/projects/from-folder" | "/api/projects/from-github" => {
            method != Method::POST && method != Method::DELETE
        }
        _ => false,
    }
}

pub(super) fn static_project_id(route: &str) -> Option<&str> {
    match route {
        "/api/projects/order" => Some("order"),
        "/api/projects/from-folder" => Some("from-folder"),
        "/api/projects/from-github" => Some("from-github"),
        _ => None,
    }
}
