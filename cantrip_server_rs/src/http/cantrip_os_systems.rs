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
    let instance = params.get("instanceId").context("OS attachment")?;
    let value = if route.ends_with("/system") {
        coordinator.system_status(&owner, instance).await?
    } else if let Some(operation) = params.get("operationId") {
        if request.method() == Method::GET {
            coordinator.system_get(&owner, instance, operation).await?
        } else if route.ends_with("/observe") {
            coordinator
                .system_observe(&owner, instance, operation)
                .await?
        } else {
            let raw = match body::parse_js(request, 24 * 1024 * 1024).await {
                Ok(value) => value,
                Err(response) => return Ok(response),
            };
            let input = match parse("cantripOsSystemControlSchema", raw.as_ref())? {
                Ok(value) => serde_json::from_str(&value.stringify())?,
                Err(response) => return Ok(response),
            };
            let mode = if route.ends_with("/continue") {
                "continue"
            } else if route.ends_with("/abandon") {
                "abandon"
            } else {
                "recover"
            };
            coordinator
                .system_control(&owner, instance, operation, mode, &input)
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
            "cantripOsSystemListQuerySchema"
        } else {
            "cantripOsSystemCreateSchema"
        };
        let input = match parse(schema, raw.as_ref())? {
            Ok(value) => serde_json::from_str(&value.stringify())?,
            Err(response) => return Ok(response),
        };
        if list {
            coordinator.system_list(&owner, instance, &input).await?
        } else {
            coordinator.system_create(&owner, instance, &input).await?
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
            eprintln!("CantripOS system request failed: {failure}");
            error(
                409,
                "CantripOS system request failed. Observe its original admission before retrying.",
            )
        }
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/cantrip-os/{instanceId}/system", get(handle))
        .route(
            "/api/cantrip-os/{instanceId}/system-operations",
            get(handle).post(handle),
        )
        .route(
            "/api/cantrip-os/{instanceId}/system-operations/{operationId}",
            get(handle),
        )
        .route(
            "/api/cantrip-os/{instanceId}/system-operations/{operationId}/observe",
            post(handle),
        )
        .route(
            "/api/cantrip-os/{instanceId}/system-operations/{operationId}/continue",
            post(handle),
        )
        .route(
            "/api/cantrip-os/{instanceId}/system-operations/{operationId}/abandon",
            post(handle),
        )
        .route(
            "/api/cantrip-os/{instanceId}/system-operations/{operationId}/recover",
            post(handle),
        )
}
