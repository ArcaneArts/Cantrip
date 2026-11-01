//! Owner-scoped Task Worker settings, including post-commit Live publication.
use super::{
    body, json_response,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    task_scheduling::{Conflict, Repository},
    wire::{Value, value::json},
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    body::Body,
    extract::{Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::{get, patch, put},
};
use std::{collections::HashMap, sync::Arc};
async fn mutate(
    service: Arc<AuthService>,
    owner: String,
    id: Option<String>,
    method: Method,
    input: Value,
) -> Result<Response> {
    let repository = Repository::new(service.repository.database.clone());
    let result: Result<Response> = async {
        if method == Method::POST {
            let worker = repository.create_worker(&owner, &input).await?;
            service.live.invalidate(
                &owner,
                "settings",
                worker["id"].as_str().context("Task Worker id")?,
            );
            return output(201, "taskWorkerSummarySchema", &worker);
        }
        if method == Method::PUT {
            let workers = repository.reorder_workers(&owner, &input).await?;
            service.live.invalidate_resource(&owner, "settings");
            return output(200, "taskWorkerListSchema", &workers);
        }
        let id = id.context("Task Worker path")?;
        if method == Method::DELETE {
            if repository
                .delete_worker(&owner, &id, &input["rowVersion"])
                .await?
            {
                service.live.invalidate(&owner, "settings", &id);
                return Ok(Response::builder()
                    .status(StatusCode::NO_CONTENT)
                    .body(Body::empty())?);
            }
        } else if let Some(worker) = repository.update_worker(&owner, &id, &input).await? {
            service.live.invalidate(
                &owner,
                "settings",
                worker["id"].as_str().context("Task Worker id")?,
            );
            return output(200, "taskWorkerSummarySchema", &worker);
        }
        Ok(error(404, "Task Worker not found."))
    }
    .await;
    match result {
        Err(error) if error.is::<Conflict>() => {
            let conflict = error.downcast_ref::<Conflict>().unwrap();
            Ok(json_response(
                StatusCode::CONFLICT,
                json!({"code":conflict.code,"error":conflict.message}),
            ))
        }
        result => result,
    }
}
async fn execute(
    service: Arc<AuthService>,
    context: &Context,
    params: HashMap<String, String>,
    request: Request,
) -> Result<Response> {
    let owner = context
        .principal
        .user
        .as_ref()
        .context("Authenticated Task Worker owner")?
        .id
        .clone();
    let method = request.method().clone();
    if method == Method::GET || method == Method::HEAD {
        return output(
            200,
            "taskWorkerListSchema",
            &Repository::new(service.repository.database.clone())
                .list_workers(&owner)
                .await?,
        );
    }
    let id = params.get("taskWorkerId").cloned().or_else(|| {
        request
            .uri()
            .path()
            .ends_with("/order")
            .then(|| "order".into())
    });
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let schema = match method {
        Method::POST => "taskWorkerCreateSchema",
        Method::PUT => "taskWorkerOrderUpdateSchema",
        Method::DELETE => "taskWorkerDeleteSchema",
        _ => "taskWorkerUpdateSchema",
    };
    let input = match parse(schema, body.as_ref())? {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    service
        .worker_maintenance
        .owned(mutate(service.clone(), owner, id, method, input))
        .await
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    match execute(service.clone(), &context, params, request).await {
        Ok(response) => response,
        Err(error) => middleware::failure(&service, &context.id, &error),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/settings/task-workers", get(handle).post(handle))
        .route(
            "/api/settings/task-workers/{taskWorkerId}",
            patch(handle).delete(handle),
        )
        .route(
            "/api/settings/task-workers/order",
            put(handle).patch(handle).delete(handle),
        )
}
