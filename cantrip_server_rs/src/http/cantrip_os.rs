use super::{
    body, json_response,
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
    let repository = &coordinator.repository;
    let param = |key: &str| {
        params
            .get(key)
            .map(String::as_str)
            .context("CantripOS route identity")
    };
    let value = if request.method() == Method::GET {
        if route == "/api/cantrip-os" {
            serde_json::json!(repository.list(&owner).await?)
        } else if route.ends_with("/run-sources") {
            serde_json::json!(repository.run_sources(&owner, param("projectId")?).await?)
        } else if route.ends_with("/workspaces") {
            let id = param("instanceId")?;
            repository.attachment(&owner, id).await?;
            serde_json::json!(repository.workspaces(&owner, id).await?)
        } else {
            serde_json::json!(repository.bindings(&owner, param("projectId")?).await?)
        }
    } else {
        let schema = if route.ends_with("/run-definitions") {
            Some("cantripOsRunDefinitionApiSchema")
        } else if route.ends_with("/inspect") {
            Some("cantripOsInspectSchema")
        } else if route.ends_with("/recovery") {
            Some("cantripOsRecoveryRequestSchema")
        } else if route.ends_with("/attach") {
            Some("cantripOsAttachSchema")
        } else if route.ends_with("/workspaces") {
            Some("cantripOsWorkspaceCreateSchema")
        } else if route.ends_with("/bindings") {
            Some("cantripOsBindingCreateSchema")
        } else if route.ends_with("/provision") {
            Some("cantripOsProvisionSchema")
        } else {
            None
        };
        let body = match body::parse_js(request, 24 * 1024 * 1024).await {
            Ok(body) => body,
            Err(response) => return Ok(response),
        };
        let input = if let Some(schema) = schema {
            match parse(schema, body.as_ref())? {
                Ok(value) => serde_json::from_str(&value.stringify())?,
                Err(response) => return Ok(response),
            }
        } else {
            serde_json::Value::Null
        };
        if route.ends_with("/run-definitions") {
            coordinator
                .run_definition(&owner, param("projectId")?, param("bindingId")?, &input)
                .await?
        } else if route.ends_with("/inspect") {
            coordinator.inspect(&owner, &input).await?
        } else if route.ends_with("/attach") {
            coordinator.attach(&owner, &input).await?
        } else if route.ends_with("/refresh") {
            coordinator.refresh(&owner, param("instanceId")?).await?
        } else if route.ends_with("/recovery") {
            coordinator
                .recover_instance(&owner, param("instanceId")?, &input)
                .await?
        } else if route.ends_with("/workspaces") {
            coordinator
                .create_workspace(&owner, param("instanceId")?, &input)
                .await?
        } else if route.ends_with("/bindings") {
            repository
                .create_binding(&owner, param("projectId")?, &input)
                .await?
        } else if route.ends_with("/provision") {
            coordinator
                .provision(&owner, param("projectId")?, param("bindingId")?, &input)
                .await?
        } else if route.ends_with("/recover") {
            coordinator
                .recover(&owner, param("projectId")?, param("bindingId")?)
                .await?
        } else {
            coordinator
                .verify(&owner, param("projectId")?, param("bindingId")?)
                .await?
        }
    };
    Ok(json_response(StatusCode::OK, value))
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    params: Option<Path<HashMap<String, String>>>,
    route: MatchedPath,
    request: Request,
) -> Response {
    let owner = context.principal.user.as_ref().unwrap().id.clone();
    let owned = service.clone();
    let params = params.map(|Path(params)| params).unwrap_or_default();
    let result = service
        .project_operations
        .own(async move { execute(owned, owner, params, route.as_str().into(), request).await })
        .await;
    match result {
        Ok(response) => response,
        Err(failure) => {
            // Keep transport/private operation diagnostics out of the client.
            eprintln!("CantripOS request failed: {failure}");
            error(
                409,
                "CantripOS request failed. Inspect worker diagnostics before retrying a mutation.",
            )
        }
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .merge(super::cantrip_os_backups::routes())
        .merge(super::cantrip_os_power::routes())
        .merge(super::cantrip_os_desktop::routes())
        .route(
            "/api/projects/{projectId}/cantrip-os/bindings/{bindingId}/run-definitions",
            post(handle),
        )
        .route("/api/cantrip-os", get(handle))
        .route(
            "/api/projects/{projectId}/cantrip-os/run-sources",
            get(handle),
        )
        .route("/api/cantrip-os/inspect", post(handle))
        .route("/api/cantrip-os/attach", post(handle))
        .route("/api/cantrip-os/{instanceId}/refresh", post(handle))
        .route("/api/cantrip-os/{instanceId}/recovery", post(handle))
        .route(
            "/api/cantrip-os/{instanceId}/workspaces",
            get(handle).post(handle),
        )
        .route(
            "/api/projects/{projectId}/cantrip-os/bindings",
            get(handle).post(handle),
        )
        .route(
            "/api/projects/{projectId}/cantrip-os/bindings/{bindingId}/provision",
            post(handle),
        )
        .route(
            "/api/projects/{projectId}/cantrip-os/bindings/{bindingId}/recover",
            post(handle),
        )
        .route(
            "/api/projects/{projectId}/cantrip-os/bindings/{bindingId}/verify",
            post(handle),
        )
}
