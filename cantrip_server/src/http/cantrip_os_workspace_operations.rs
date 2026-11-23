use super::{account, json_response, middleware::Context, settings::parse};
use crate::{auth::service::AuthService, cantrip_os::coordinator::Coordinator};
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
    service: Arc<AuthService>,
    owner: String,
    params: HashMap<String, String>,
    request: Request,
) -> Result<Response> {
    let read = request.method() == Method::GET || request.method() == Method::HEAD;
    let coordinator = Coordinator::new(service);
    let instance = params.get("instanceId").context("Workspace instance")?;
    let value = if let Some(operation) = params.get("operationId") {
        if read {
            coordinator
                .workspace_operation_get(&owner, instance, operation)
                .await?
        } else {
            coordinator
                .workspace_operation_observe(&owner, instance, operation)
                .await?
        }
    } else {
        let raw = account::query(request.uri());
        let input = match parse("cantripOsWorkspaceOperationListQuerySchema", Some(&raw))? {
            Ok(value) => serde_json::from_str(&value.stringify())?,
            Err(response) => return Ok(response),
        };
        coordinator
            .workspace_operation_list(&owner, instance, &input)
            .await?
    };
    Ok(json_response(StatusCode::OK, value))
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    let owner = context.principal.user.as_ref().unwrap().id.clone();
    let owned = service.clone();
    match service
        .project_operations
        .own(async move { execute(owned, owner, params, request).await })
        .await
    {
        Ok(response) => response,
        Err(failure) => {
            eprintln!("CantripOS workspace request failed: {failure}");
            super::cantrip_os::failure(
                &failure,
                "CantripOS workspace request failed. Observe its original admission before retrying.",
            )
        }
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(
            "/api/cantrip-os/{instanceId}/workspace-operations",
            get(handle),
        )
        .route(
            "/api/cantrip-os/{instanceId}/workspace-operations/{operationId}",
            get(handle),
        )
        .route(
            "/api/cantrip-os/{instanceId}/workspace-operations/{operationId}/observe",
            post(handle),
        )
}
