use super::{
    account, body, json_response,
    middleware::Context,
    settings::{error, parse},
};
use crate::{auth::service::AuthService, cantrip_os::coordinator::Coordinator};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{MatchedPath, Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::{get, post},
};
use std::{collections::HashMap, sync::Arc};

async fn execute(
    service: Arc<AuthService>,
    owner: String,
    params: HashMap<String, String>,
    route: String,
    request: Request,
) -> Result<Response> {
    let coordinator = Coordinator::new(service);
    let instance = params.get("instanceId").context("Desktop instance")?;
    let workspace = params.get("workspaceId").context("Desktop workspace")?;
    let value = if route.ends_with("/desktop") {
        coordinator
            .desktop_status(&owner, instance, workspace)
            .await?
    } else if let Some(operation) = params.get("operationId") {
        if request.method() == Method::GET {
            coordinator
                .desktop_get(&owner, instance, workspace, operation)
                .await?
        } else {
            coordinator
                .desktop_observe(&owner, instance, workspace, operation)
                .await?
        }
    } else {
        let list = request.method() == Method::GET;
        let raw = if list {
            Some(account::query(request.uri()))
        } else {
            match body::parse_js(request, 24 * 1024 * 1024).await {
                Ok(value) => value,
                Err(response) => return Ok(response),
            }
        };
        let schema = if list {
            "cantripOsDesktopListQuerySchema"
        } else {
            "cantripOsDesktopCreateSchema"
        };
        let input = match parse(schema, raw.as_ref())? {
            Ok(value) => serde_json::from_str(&value.stringify())?,
            Err(response) => return Ok(response),
        };
        if list {
            coordinator
                .desktop_list(&owner, instance, workspace, &input)
                .await?
        } else {
            coordinator
                .desktop_create(&owner, instance, workspace, &input)
                .await?
        }
    };
    Ok(json_response(StatusCode::OK, value))
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    route: MatchedPath,
    request: Request,
) -> Response {
    let owner = context.principal.user.as_ref().unwrap().id.clone();
    let owned = service.clone();
    match service
        .project_operations
        .own(async move { execute(owned, owner, params, route.as_str().into(), request).await })
        .await
    {
        Ok(response) => response,
        Err(failure) => {
            eprintln!("CantripOS desktop request failed: {failure}");
            error(
                409,
                "CantripOS desktop request failed. Observe its original admission before retrying.",
            )
        }
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/cantrip-os/{instanceId}/workspaces/{workspaceId}/desktop", get(handle))
        .route(
            "/api/cantrip-os/{instanceId}/workspaces/{workspaceId}/desktop-operations",
            get(handle).post(handle),
        )
        .route(
            "/api/cantrip-os/{instanceId}/workspaces/{workspaceId}/desktop-operations/{operationId}",
            get(handle),
        )
        .route(
            "/api/cantrip-os/{instanceId}/workspaces/{workspaceId}/desktop-operations/{operationId}/observe",
            post(handle),
        )
}
