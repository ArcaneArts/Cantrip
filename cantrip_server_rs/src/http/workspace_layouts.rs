//! Durable workspace ownership and opaque file-view migration.
use super::{
    body, json_response,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    wire::{Value, value::json},
    workspace_layouts::{LegacyInvariant, ModelError, Repository, assert_version},
};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::{get, post},
};
use std::{collections::HashMap, sync::Arc};

fn failure(cause: anyhow::Error) -> Result<Response> {
    if let Some(ModelError {
        code: Some(code),
        message,
        ..
    }) = cause.downcast_ref::<ModelError>()
    {
        return Ok(json_response(
            if *code == "invalid" {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::CONFLICT
            },
            if *code == "version" {
                json!({"error":message,"code":code,"supportedVersions":vec![1,2],"requiredVersion":2})
            } else {
                json!({"error":message,"code":code})
            },
        ));
    }
    if cause.is::<LegacyInvariant>() {
        return Ok(json_response(
            StatusCode::BAD_REQUEST,
            json!({"statusCode":400,"error":"Bad Request","message":cause.to_string()}),
        ));
    }
    Err(cause)
}

fn readable(layout: Value, supported: u64) -> Result<Response> {
    match assert_version(layout["version"].as_u64().unwrap(), supported) {
        Ok(()) => Ok(json_response(StatusCode::OK, layout)),
        Err(cause) => failure(cause),
    }
}

async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    let supported_version = if request
        .headers()
        .get("x-cantrip-workspace-version")
        .and_then(|value| value.to_str().ok())
        == Some("2")
    {
        2
    } else {
        1
    };
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    let project = params["projectId"].clone();
    let workspace = params["workspaceId"].clone();
    let result: Result<Response> = async {
        if request.method() == Method::GET || request.method() == Method::HEAD {
            return match Repository::new(service.repository.database.clone())
                .get(&owner, &project, &workspace)
                .await?
            {
                Some(layout) => readable(layout, supported_version),
                None => Ok(error(404, "Workspace not found.")),
            };
        }
        let action = request.uri().path().rsplit('/').next().unwrap().to_owned();
        let schema = match action.as_str() {
            "seed" => "workspaceSeedRequestSchema",
            "commands" => "workspaceCommandSchema",
            _ => "workspaceLegacyFileImportRequestSchema",
        };
        let raw = match body::parse_js(request, service.config.api_body_limit_bytes).await {
            Ok(value) => value,
            Err(response) => return Ok(response),
        };
        let input = match parse(schema, raw.as_ref())? {
            Ok(value) => value,
            Err(response) => return Ok(response),
        };
        if action == "commands"
            && (input["projectId"] != project.as_str()
                || input["workspaceId"] != workspace.as_str())
        {
            return Ok(error(400, "Command and route scope do not match."));
        }
        let execution = service.clone();
        service
            .worker_maintenance
            .owned(async move {
                let repository = Repository::new(execution.repository.database.clone());
                let result = match action.as_str() {
                    "seed" => repository.seed(&owner, &project, &workspace, &input).await,
                    "commands" => {
                        repository
                            .execute_with_version(&owner, &input, supported_version)
                            .await
                    }
                    _ => {
                        repository
                            .import_legacy_files_with_version(
                                &owner,
                                &project,
                                &workspace,
                                &input,
                                supported_version,
                            )
                            .await
                    }
                };
                match result {
                    Ok(Some(value)) if action == "seed" => readable(value, supported_version),
                    Ok(Some(value)) => output(
                        200,
                        if action == "commands" {
                            "workspaceReceiptSchema"
                        } else {
                            "workspaceLegacyFileImportReceiptSchema"
                        },
                        &value,
                    ),
                    Ok(None) => Ok(error(
                        404,
                        if action == "seed" {
                            "Project not found."
                        } else {
                            "Workspace not found."
                        },
                    )),
                    Err(cause) => failure(cause),
                }
            })
            .await
    }
    .await;
    // Source mutationLiveResources returns [] for all workspace-layout routes.
    // Successful retries acknowledge state without publishing extra events.
    result.unwrap_or_else(|cause| middleware::failure(&service, &ctx.id, &cause))
}

pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(
            "/api/projects/{projectId}/workspace-layouts/{workspaceId}",
            get(handle),
        )
        .route(
            "/api/projects/{projectId}/workspace-layouts/{workspaceId}/seed",
            post(handle),
        )
        .route(
            "/api/projects/{projectId}/workspace-layouts/{workspaceId}/commands",
            post(handle),
        )
        .route(
            "/api/projects/{projectId}/workspace-layouts/{workspaceId}/import-legacy-files",
            post(handle),
        )
}
