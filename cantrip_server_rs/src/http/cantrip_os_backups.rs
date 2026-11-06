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
    let param = |key: &str| {
        params
            .get(key)
            .map(String::as_str)
            .context("Backup route identity")
    };
    let list = request.method() == Method::GET && !params.contains_key("operationId");
    let output = if request.method() == Method::GET && !list {
        coordinator
            .backup_get(&owner, param("operationId")?)
            .await?
    } else {
        let raw = if list {
            Some(account::query(request.uri()))
        } else {
            match body::parse_js(request, 24 * 1024 * 1024).await {
                Ok(raw) => raw,
                Err(response) => return Ok(response),
            }
        };
        let schema = if list {
            "cantripOsBackupListQuerySchema"
        } else if route.ends_with("/recovery") {
            "cantripOsBackupRecoverySchema"
        } else {
            "cantripOsBackupAdmissionSchema"
        };
        let input = match parse(schema, raw.as_ref())? {
            Ok(value) => serde_json::from_str(&value.stringify())?,
            Err(response) => return Ok(response),
        };
        if list {
            coordinator
                .backup_list(&owner, &input, route.ends_with("/backups"))
                .await?
        } else if route.ends_with("/recovery") {
            coordinator
                .backup_recover(&owner, param("operationId")?, &input)
                .await?
        } else {
            coordinator
                .backup_admit(&owner, param("instanceId")?, &input)
                .await?
        }
    };
    Ok(json_response(StatusCode::OK, output))
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
    match service
        .project_operations
        .own(async move {
            execute(
                owned,
                owner,
                params.map(|Path(p)| p).unwrap_or_default(),
                route.as_str().into(),
                request,
            )
            .await
        })
        .await
    {
        Ok(response) => response,
        Err(_) => error(
            409,
            "CantripOS backup request failed. Observe the original operation before retrying.",
        ),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/cantrip-os/backups", get(handle))
        .route("/api/cantrip-os/backup-operations", get(handle))
        .route(
            "/api/cantrip-os/backup-operations/{operationId}",
            get(handle),
        )
        .route(
            "/api/cantrip-os/{instanceId}/backup-operations",
            post(handle),
        )
        .route(
            "/api/cantrip-os/backup-operations/{operationId}/recovery",
            post(handle),
        )
}
