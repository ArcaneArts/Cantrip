//! Explorer, Code-tab and project-view endpoints retain their distinct contracts.
mod runtime;
use super::{
    body,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    project_surfaces::{Kind, Repository},
    projects::placement::Unavailable,
    wire::{Value, value::json},
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{MatchedPath, Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::{get, patch, post},
};
use std::{collections::HashMap, sync::Arc};

fn summary(kind: Kind) -> &'static str {
    match kind {
        Kind::Explorer => "explorerWireSummarySchema",
        Kind::Code => "codeTabWireSummarySchema",
        Kind::View => "projectViewWireSummarySchema",
    }
}
fn missing(kind: Kind) -> &'static str {
    match kind {
        Kind::Explorer => "Explorer not found.",
        Kind::Code => "Code tab not found.",
        Kind::View => "Project view not found.",
    }
}
fn schema(kind: Kind, create: bool, action: &str) -> &'static str {
    match (kind, create, action) {
        (Kind::Explorer, true, _) => "encryptedExplorerCreateSchema",
        (Kind::Code, true, _) => "encryptedCodeTabCreateSchema",
        (Kind::View, true, _) => "encryptedProjectViewCreateSchema",
        (Kind::Explorer, _, "pin") => "encryptedExplorerPinSchema",
        (Kind::Explorer, _, "view-state") => "encryptedExplorerViewStateUpdateSchema",
        (Kind::Explorer, _, "operation") => "explorerOperationWireRequestSchema",
        (Kind::Explorer, _, "worktree") => "encryptedExplorerWorktreeUpdateSchema",
        (_, _, "worktree") => "worktreeSelectionSchema",
        (Kind::Explorer, _, _) => "encryptedExplorerUpdateSchema",
        (Kind::Code, _, _) => "encryptedCodeTabUpdateSchema",
        (Kind::View, _, _) => "encryptedProjectViewUpdateSchema",
    }
}
async fn mutate(
    service: Arc<AuthService>,
    owner: String,
    params: HashMap<String, String>,
    kind: Kind,
    method: Method,
    action: String,
    input: Value,
) -> Result<Response> {
    let repo = Repository::new(service.repository.database.clone());
    if let Some(project) = params.get("projectId") {
        if kind == Kind::View {
            let capability = match input["kind"].as_str() {
                Some("history" | "graph") => Some("git"),
                Some("issues" | "prs" | "actions") => Some("github"),
                _ => None,
            };
            if let Some(capability) = capability
                && let Some(response) =
                    runtime::capability(&service, &owner, project, capability).await?
            {
                return Ok(response);
            }
        }
        let connected = |worker: &str| service.workers.bridge.is_connected(worker);
        return match repo
            .create(kind, &owner, project, &input, Some(&connected))
            .await
        {
            Ok(Some(value)) => output(201, summary(kind), &value),
            Ok(None) => Ok(error(
                404,
                if kind == Kind::Code {
                    "Project source or worktree not found."
                } else {
                    "Project source not found."
                },
            )),
            Err(cause) if kind != Kind::View && cause.is::<Unavailable>() => {
                let unavailable = cause.downcast_ref::<Unavailable>().unwrap();
                Ok(super::json_response(
                    if unavailable.code == "project-not-found" {
                        StatusCode::NOT_FOUND
                    } else {
                        StatusCode::CONFLICT
                    },
                    json!({"code":unavailable.code,"error":unavailable.message}),
                ))
            }
            Err(cause) => Err(cause),
        };
    }
    let id = params
        .get("resourceId")
        .context("Project surface identity")?;
    if method == Method::DELETE {
        return runtime::delete(service, &owner, kind, id).await;
    }
    if action == "operation" {
        return runtime::operation(service, &owner, id, &input).await;
    }
    if action == "worktree" {
        return runtime::worktree(service, &owner, kind, id, &input).await;
    }
    let value = if action == "pin" {
        match repo.pin_explorer(&owner, id, &input).await {
            Err(cause) if cause.is::<crate::pane_layouts::LegacyInvariant>() => {
                return Ok(error(400, cause.to_string()));
            }
            value => value?,
        }
    } else if action == "view-state" {
        repo.update_explorer_state(&owner, id, &input).await?
    } else {
        repo.update(kind, &owner, id, &input).await?
    };
    match value {
        Some(value) => output(200, summary(kind), &value),
        None => Ok(error(404, missing(kind))),
    }
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    matched: MatchedPath,
    request: Request,
) -> Response {
    let path = matched.as_str();
    let kind = if path.contains("/explorers") {
        Kind::Explorer
    } else if path.contains("/code-tabs") {
        Kind::Code
    } else {
        Kind::View
    };
    let action = path.rsplit('/').next().unwrap_or("").to_owned();
    let method = request.method().clone();
    let mutation = ![Method::GET, Method::HEAD].contains(&method);
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    let result: Result<Response> = async {
        if !mutation {
            let values = Repository::new(service.repository.database.clone())
                .list(
                    kind,
                    &owner,
                    params.get("projectId").context("Surface project route")?,
                )
                .await?;
            return output(
                200,
                match kind {
                    Kind::Explorer => "explorerWireListSchema",
                    Kind::Code => "codeTabWireListSchema",
                    Kind::View => "projectViewWireListSchema",
                },
                &Value::Array(values),
            );
        }
        let raw = match body::parse_js(
            request,
            if action == "operation" {
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
        let input = if method == Method::DELETE {
            Value::Null
        } else {
            match parse(
                schema(kind, params.contains_key("projectId"), &action),
                raw.as_ref(),
            )? {
                Ok(value) => value,
                Err(response) => return Ok(response),
            }
        };
        service
            .worker_maintenance
            .owned(mutate(
                service.clone(),
                owner.clone(),
                params.clone(),
                kind,
                method,
                action,
                input,
            ))
            .await
    }
    .await;
    let response = result.unwrap_or_else(|cause| {
        if cause.is::<crate::pane_layouts::LegacyInvariant>() {
            super::json_response(
                StatusCode::BAD_REQUEST,
                json!({"statusCode":400,"error":"Bad Request","message":cause.to_string()}),
            )
        } else {
            middleware::failure(&service, &ctx.id, &cause)
        }
    });
    if mutation && response.status().as_u16() < 400 {
        let resource = match kind {
            Kind::Explorer => "explorer",
            Kind::Code => "code-tab",
            Kind::View => "project-view",
        };
        let scope = params.get("projectId").map_or(
            json!({"kind":"current-user"}),
            |id| json!({"kind":"project","projectId":id}),
        );
        let entity = params
            .get("resourceId")
            .or_else(|| params.get("projectId"))
            .cloned();
        let live = service.live.clone();
        super::on_response::completed(response, move || {
            for resource in [resource, "project-tab-layout"] {
                let _=live.publish_event(json!({"ownerId":owner,"scope":scope,"resource":resource,"action":"invalidated","entityId":entity,"revision":Value::Null,"payload":Value::Null}));
            }
        })
    } else {
        response
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(
            "/api/projects/{projectId}/explorers",
            get(handle).post(handle),
        )
        .route("/api/explorers/{resourceId}", patch(handle).delete(handle))
        .route("/api/explorers/{resourceId}/pin", post(handle))
        .route("/api/explorers/{resourceId}/view-state", patch(handle))
        .route("/api/explorers/{resourceId}/worktree", patch(handle))
        .route("/api/explorers/{resourceId}/operation", post(handle))
        .route(
            "/api/projects/{projectId}/code-tabs",
            get(handle).post(handle),
        )
        .route("/api/code-tabs/{resourceId}", patch(handle).delete(handle))
        .route("/api/code-tabs/{resourceId}/worktree", patch(handle))
        .route("/api/projects/{projectId}/views", get(handle).post(handle))
        .route(
            "/api/project-views/{resourceId}",
            patch(handle).delete(handle),
        )
        .route("/api/project-views/{resourceId}/worktree", patch(handle))
}
