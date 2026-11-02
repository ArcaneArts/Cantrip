//! Public Task metadata and encrypted draft/plan edits. The repository owns
//! revision and state checks; publication follows the committed mutation.
use super::{
    body, json_response,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    operations::shared_failure::downcast_ref,
    task_dispatch, tasks,
    wire::{Value, value::json},
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{MatchedPath, Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::{get, patch},
};
use std::sync::Arc;

fn mutation_error(cause: anyhow::Error) -> Result<Response> {
    if let Some(conflict) = downcast_ref::<task_dispatch::Conflict>(&cause) {
        return Ok(json_response(
            StatusCode::CONFLICT,
            json!({"code":conflict.code,"error":conflict.message}),
        ));
    }
    if let Some(conflict) = downcast_ref::<tasks::Conflict>(&cause) {
        return Ok(json_response(
            StatusCode::CONFLICT,
            json!({"code":conflict.code,"error":conflict.message}),
        ));
    }
    if let Some(transition) = downcast_ref::<tasks::policy::StateTransitionError>(&cause) {
        return Ok(json_response(
            StatusCode::CONFLICT,
            json!({"code":"invalid-state","error":transition.to_string()}),
        ));
    }
    Err(cause)
}

async fn mutate(
    service: Arc<AuthService>,
    owner: String,
    chat: String,
    draft: bool,
    input: Value,
) -> Result<Response> {
    let repository = tasks::Repository::new(service.repository.database.clone());
    let result = if draft {
        repository.update_draft(&owner, &chat, &input).await
    } else {
        repository.update_plan(&owner, &chat, &input).await
    };
    match result {
        Ok(Some(task)) => {
            service
                .chat_mutations
                .publish_invalidation(&owner, &chat, "task", None);
            output(200, "taskOpaqueSummarySchema", &task)
        }
        Ok(None) => Ok(error(404, "Task not found.")),
        Err(cause) => mutation_error(cause),
    }
}

async fn execute(
    service: Arc<AuthService>,
    context: &Context,
    chat: String,
    path: &str,
    request: Request,
) -> Result<Response> {
    let owner = context
        .principal
        .user
        .as_ref()
        .context("Authenticated Task owner")?
        .id
        .clone();
    if matches!(*request.method(), Method::GET | Method::HEAD) {
        return match tasks::Repository::new(service.repository.database.clone())
            .get(&owner, &chat)
            .await?
        {
            Some(task) => output(200, "taskOpaqueSummarySchema", &task),
            None => Ok(error(404, "Task not found.")),
        };
    }
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let input = match parse("taskOpaqueMutationSchema", body.as_ref())? {
        Ok(input) => input,
        Err(response) => return Ok(response),
    };
    service
        .worker_maintenance
        .owned(mutate(
            service.clone(),
            owner,
            chat,
            path.ends_with("/draft"),
            input,
        ))
        .await
}

async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    Path(chat): Path<String>,
    matched: MatchedPath,
    request: Request,
) -> Response {
    match execute(service.clone(), &context, chat, matched.as_str(), request).await {
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &context.id, &cause),
    }
}

pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/tasks/{chatId}", get(handle))
        .route("/api/tasks/{chatId}/draft", patch(handle))
        .route("/api/tasks/{chatId}/plan", patch(handle))
}
