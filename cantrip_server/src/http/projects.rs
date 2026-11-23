use super::{
    body, json_response,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    projects::{
        placement::{PlacementRepository, Unavailable},
        repository::ProjectRepository,
        targets::TargetRepository,
    },
    wire::Value,
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::{get, post},
};
use std::{collections::HashMap, sync::Arc};

async fn execute(
    service: &AuthService,
    ctx: &Context,
    params: &HashMap<String, String>,
    request: Request,
) -> Result<Response> {
    let owner = &ctx
        .principal
        .user
        .as_ref()
        .context("Authenticated project owner")?
        .id;
    if request.method() == Method::GET || request.method() == Method::HEAD {
        if let Some(id) = params.get("projectId") {
            let connected = |worker: &str| service.workers.bridge.is_connected(worker);
            return match TargetRepository::new(service.repository.database.clone())
                .catalog(owner, id, Some(&connected))
                .await?
            {
                Some(value) => output(200, "executionTargetWireCatalogSchema", &value),
                None => Ok(error(404, "Project not found.")),
            };
        }
        let projects = ProjectRepository::new(service.repository.database.clone())?
            .list(owner)
            .await?;
        return output(200, "projectWireListSchema", &Value::Array(projects));
    }
    let explicit = request.uri().path().ends_with("/execution-targets/resolve");
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(v) => v,
        Err(response) => return Ok(response),
    };
    let input = match parse(
        if explicit {
            "executionTargetResolveRequestSchema"
        } else {
            "executionPlacementResolveRequestSchema"
        },
        body.as_ref(),
    )? {
        Ok(v) => v,
        Err(response) => return Ok(response),
    };
    let connected = |worker: &str| service.workers.bridge.is_connected(worker);
    let result = if explicit {
        TargetRepository::new(service.repository.database.clone())
            .resolve(
                owner,
                &params["projectId"],
                &input["target"],
                Some(&connected),
                input["allowUnavailable"].as_bool().unwrap(),
            )
            .await
    } else {
        PlacementRepository::new(service.repository.database.clone())?
            .resolve(
                owner,
                &params["projectId"],
                input["surfaceKind"].as_str().context("Placement surface")?,
                input.get("target"),
                Some(&connected),
                false,
            )
            .await
    };
    match result {
        Ok(value) => output(
            200,
            if explicit {
                "executionTargetResolutionSchema"
            } else {
                "executionPlacementResolutionSchema"
            },
            &value,
        ),
        Err(cause) => {
            if let Some(error) = cause.downcast_ref::<Unavailable>() {
                Ok(json_response(
                    if error.code == "project-not-found" {
                        StatusCode::NOT_FOUND
                    } else {
                        StatusCode::CONFLICT
                    },
                    Value::object([
                        ("code", Value::String(error.code.into())),
                        ("error", Value::String(error.message.clone().into())),
                    ]),
                ))
            } else {
                Err(cause)
            }
        }
    }
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    match execute(&service, &ctx, &params, request).await {
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &ctx.id, &cause),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/projects", get(handle))
        .route("/api/projects/{projectId}/execution-targets", get(handle))
        .route(
            "/api/projects/{projectId}/execution-targets/resolve",
            post(handle),
        )
        .route("/api/projects/{projectId}/placement/resolve", post(handle))
}
