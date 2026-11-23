//! Existing worker maintenance operations, with endpoint-owned effects.
use super::{
    body, json_response,
    middleware::{self, Context},
    settings::{error, parse},
};
use crate::{
    auth::service::AuthService,
    projects::{repository::ProjectRepository, targets::TargetRepository},
    wire::{Value, value::json},
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{MatchedPath, Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::{get, post},
};
use std::{collections::HashMap, sync::Arc, time::Duration};

async fn execute(
    service: Arc<AuthService>,
    owner: String,
    params: HashMap<String, String>,
    route: String,
    request: Request,
) -> Result<Response> {
    let web_action = route.ends_with("/web-runtimes/actions");
    let binary_limit = (service.config.upload_limit_bytes * 3).div_ceil(2) + 1024 * 1024;
    let input = if web_action {
        let input =
            match body::parse_js_buffer(request, service.config.api_body_limit_bytes, binary_limit)
                .await
            {
                Ok(input) => input,
                Err(response) => return Ok(response),
            };
        match parse("managedWebRuntimeActionRequestSchema", input.as_ref())? {
            Ok(input) => Some(input),
            Err(response) => return Ok(response),
        }
    } else {
        if let Err(response) =
            body::parse_ignored(request, service.config.api_body_limit_bytes, binary_limit).await
        {
            return Ok(response);
        }
        None
    };
    let (worker, command, schema, status, timeout) = if let Some(worker) = params.get("workerId") {
        if service
            .workers
            .repository
            .get_worker(&owner, worker)
            .await?
            .is_none()
        {
            return Ok(error(404, "Worker not found."));
        }
        if route.ends_with("/version") {
            if !service.workers.commands.is_connected(worker) {
                return Ok(error(503, "Worker is offline."));
            }
            (
                worker.clone(),
                json!({"type":"worker.version"}),
                "cantripVersionSchema",
                StatusCode::OK,
                None,
            )
        } else if web_action {
            let mut command = input.context("Validated managed runtime action")?;
            command["type"] = json!("web-runtime.action");
            (
                worker.clone(),
                command,
                "managedWebRuntimeActionResultSchema",
                StatusCode::OK,
                Some(Duration::from_secs(12 * 60)),
            )
        } else {
            (
                worker.clone(),
                json!({"type":"codegraph.update.check"}),
                "codeGraphActionAcknowledgementSchema",
                StatusCode::ACCEPTED,
                Some(Duration::from_secs(5)),
            )
        }
    } else {
        let project = &params["projectId"];
        let worktree = &params["worktreeId"];
        // Source's project pre-handler checks this before resolving a worktree.
        // In particular, a managed-folder project cannot dispatch CodeGraph.
        if let Some(context) = ProjectRepository::new(service.repository.database.clone())?
            .get(&owner, project)
            .await?
            && context["capabilities"]["worktrees"] != true
        {
            return Ok(json_response(
                StatusCode::CONFLICT,
                json!({"code":"project-capability-unavailable","capability":"worktrees","error":format!("This {} project does not support the worktrees capability.",context["originKind"].as_str().unwrap_or("undefined"))}),
            ));
        }
        let Some(context) = TargetRepository::new(service.repository.database.clone())
            .worktree_context(&owner, project, worktree)
            .await?
        else {
            return Ok(error(404, "Worktree not found."));
        };
        let action = if route.ends_with("/sync") {
            "sync"
        } else if route.ends_with("/rebuild") {
            "rebuild"
        } else {
            "status"
        };
        (
            context["workerId"]
                .as_str()
                .context("CodeGraph context worker")?
                .to_owned(),
            json!({"type":format!("codegraph.{action}"),"projectId":project,"worktreeId":worktree,"rootKind":context["worktree"]["rootKind"],"sourcePath":context["sourcePath"],"worktreePath":context["worktree"]["path"]}),
            if action == "status" {
                "codeGraphProjectStatusSchema"
            } else {
                "codeGraphActionAcknowledgementSchema"
            },
            if action == "status" {
                StatusCode::OK
            } else {
                StatusCode::ACCEPTED
            },
            Some(Duration::from_secs(5)),
        )
    };
    // Source catches only dispatch/response failures. Authorization and database
    // context reads above retain the application's ordinary failure handling.
    let result: Result<Response> = async {
        let reply = service
            .workers
            .commands
            .request(&worker, command, timeout, None)
            .await?;
        let reply = crate::settings::parse_response(schema, reply.as_ref())?;
        Ok(json_response(status, reply))
    }
    .await;
    Ok(match result {
        Ok(response) => response,
        Err(cause) => super::worker_links::request_failure(&cause),
    })
}

async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    route: MatchedPath,
    request: Request,
) -> Response {
    let owner = ctx
        .principal
        .user
        .as_ref()
        .expect("Admitted worker operation")
        .id
        .clone();
    let mutation = request.method() == Method::POST;
    let publication = params.clone();
    let result = service
        .project_operations
        .own(execute(
            service.clone(),
            owner.clone(),
            params,
            route.as_str().to_owned(),
            request,
        ))
        .await;
    match result {
        Ok(response) if mutation && response.status().as_u16() < 400 => {
            let live = service.live.clone();
            super::on_response::completed(response, move || {
                if let Some(worker) = publication.get("workerId") {
                    live.invalidate(&owner, "worker", worker);
                } else if let Err(cause) = live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"project","projectId":publication["projectId"]}),"resource":"worktree","action":"invalidated","entityId":publication["worktreeId"],"revision":Value::Null,"payload":Value::Null})) {
                    use crate::operations::logging::{self, LogCall};
                    (logging::server_logger())(LogCall::event("error", "Could not publish application live invalidation", json!({"err":json!({"message":cause.to_string()}),"resource":"worktree"})));
                }
            })
        }
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &ctx.id, &cause),
    }
}

pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/workers/{workerId}/version", get(handle))
        .route(
            "/api/workers/{workerId}/codegraph/update-check",
            post(handle),
        )
        .route("/api/workers/{workerId}/web-runtimes/actions", post(handle))
        .route(
            "/api/projects/{projectId}/worktrees/{worktreeId}/codegraph",
            get(handle),
        )
        .route(
            "/api/projects/{projectId}/worktrees/{worktreeId}/codegraph/sync",
            post(handle),
        )
        .route(
            "/api/projects/{projectId}/worktrees/{worktreeId}/codegraph/rebuild",
            post(handle),
        )
}
