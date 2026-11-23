//! Owner-scoped durable external Chat import admission and job inspection.
use super::{
    body,
    middleware::{self, Context},
    settings::{error, output},
};
use crate::{
    auth::service::AuthService,
    chats::imports::Error,
    operations::logging::LogCall,
    projects::placement::{PlacementRepository, Unavailable},
    wire::{Value, value::json},
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::Method,
    response::Response,
    routing::{get, post},
};
use std::{collections::HashMap, sync::Arc};
async fn operation(
    service: Arc<AuthService>,
    owner: String,
    params: HashMap<String, String>,
    input: Option<Value>,
) -> Result<Response> {
    let repository = &service.chat_imports.repository;
    let Some(input) = input else {
        return if let Some(project) = params.get("projectId") {
            match repository.list(&owner, project).await? {
                Some(jobs) => output(200, "chatImportJobListSchema", &jobs),
                None => Ok(error(404, "Project not found.")),
            }
        } else {
            match repository.get(&owner, &params["jobId"]).await? {
                Some(job) => output(200, "chatImportJobSummarySchema", &job),
                None => Ok(error(404, "Chat import not found.")),
            }
        };
    };
    let Some(project) = params.get("projectId") else {
        let Some(job) = repository
            .retry(
                &owner,
                &params["jobId"],
                input["stateRevision"]
                    .as_f64()
                    .context("Import state revision")?,
            )
            .await?
        else {
            return Ok(error(
                409,
                "The import changed or cannot be retried in its current state.",
            ));
        };
        service.chat_imports.publish(&owner, &job);
        service.chat_imports.queue();
        return output(200, "chatImportJobSummarySchema", &job);
    };
    let admitted: Result<Vec<Value>> = async {
        let placement = PlacementRepository::new(service.repository.database.clone())?;
        let connected = |worker: &str| service.workers.bridge.is_connected(worker);
        let selections = input["imports"]
            .as_array()
            .context("Chat import selections")?;
        let resolutions = futures::future::try_join_all(selections.iter().map(|selection| {
            placement.resolve(
                &owner,
                project,
                "chat",
                selection.get("target"),
                Some(&connected),
                false,
            )
        }))
        .await?;
        let mut jobs = Vec::new();
        for (selection, resolved) in selections.iter().zip(resolutions) {
            let mut request = selection.clone();
            request["targetPlacement"] = resolved["placement"].clone();
            jobs.push(repository.create(&owner, project, &request).await?);
        }
        Ok(jobs)
    }
    .await;
    match admitted {
        Ok(jobs) => {
            for job in &jobs {
                service.chat_imports.publish(&owner, job);
            }
            let unique = |field: &str| {
                let mut values = Vec::new();
                for job in &jobs {
                    let value = if field == "sourceWorkerId" {
                        &job[field]
                    } else {
                        &job["targetPlacement"]["workerId"]
                    };
                    if !values.contains(value) {
                        values.push(value.clone());
                    }
                }
                Value::Array(values)
            };
            (crate::operations::logging::server_logger())(LogCall::event(
                "info",
                "Chat imports created",
                json!({"chatImportJobIds":jobs.iter().map(|j|j["id"].clone()).collect::<Vec<_>>(),"importCount":jobs.len(),"projectId":project,"sourceWorkerIds":unique("sourceWorkerId"),"targetWorkerIds":unique("targetWorkerId")}),
            ));
            service.chat_imports.queue();
            output(202, "chatImportJobListSchema", &Value::Array(jobs))
        }
        Err(cause) => {
            if let Some(error) = cause.downcast_ref::<Error>() {
                return match error {
                    Error::NotFound(_) => Ok(super::settings::error(404, error.to_string())),
                    Error::Conflict(_) => Ok(super::settings::error(409, error.to_string())),
                    Error::Stale => Err(cause),
                };
            }
            if cause.is::<Unavailable>() {
                return Ok(error(409, cause.to_string()));
            }
            Err(cause)
        }
    }
}
async fn execute(
    service: Arc<AuthService>,
    owner: String,
    params: HashMap<String, String>,
    request: Request,
) -> Result<Response> {
    let input = if matches!(*request.method(), Method::GET | Method::HEAD) {
        None
    } else {
        let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
            Ok(body) => body,
            Err(response) => return Ok(response),
        };
        let schema = if params.contains_key("projectId") {
            "chatImportCreateSchema"
        } else {
            "chatImportJobRetrySchema"
        };
        // Source's import routes let schema exceptions reach the application's
        // generic error handler, unlike routes using explicit safeParse bodies.
        Some(crate::settings::parse_response(schema, body.as_ref())?)
    };
    service
        .chat_imports
        .owned(operation(service.clone(), owner, params, input))
        .await
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    match execute(service.clone(), owner, params, request).await {
        Ok(response) => response,
        Err(error) => middleware::failure(&service, &ctx.id, &error),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(
            "/api/projects/{projectId}/chat-imports",
            get(handle).post(handle),
        )
        .route("/api/chat-imports/{jobId}", get(handle))
        .route("/api/chat-imports/{jobId}/retry", post(handle))
}
