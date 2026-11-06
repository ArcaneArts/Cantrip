//! The legacy worker CLI relay keeps its own diagnostics and mutation audit contract.
use super::{
    body, json_response,
    middleware::{self, Context},
};
use crate::{
    auth::service::AuthService,
    cli::{self, Error, optional},
    wire::{ValidationError, Value, value::json},
    workers::credentials,
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Request, State},
    http::StatusCode,
    response::Response,
    routing::post,
};
use std::sync::Arc;

fn classify(cause: &anyhow::Error) -> Error {
    if let Some(error) = cause.downcast_ref::<Error>() {
        return Error::new(error.status, error.code, error.message.clone());
    }
    if let Some(error) = cause.downcast_ref::<crate::projects::worktrees::MutationError>() {
        let missing = error.failure["mutation"]["outcome"] == "notStarted";
        return Error::new(
            if missing { 404 } else { 409 },
            if missing { "not-found" } else { "conflict" },
            error.failure["error"]
                .as_js_string()
                .cloned()
                .unwrap_or_else(|| "".into()),
        );
    }
    if let Some(error) = cause.downcast_ref::<super::agent_operations::OperationError>() {
        return Error::new(
            error.status,
            if error.code == "stale-binding" {
                "conflict"
            } else {
                error.code
            },
            error.message.clone(),
        );
    }
    if let Some(error) = cause.downcast_ref::<crate::projects::placement::Unavailable>() {
        let (status, code) = match error.code {
            "project-not-found" | "target-not-found" => (404, "not-found"),
            "worker-offline" | "capability-unavailable" => (503, "unavailable"),
            _ => (409, "conflict"),
        };
        return Error::new(status, code, error.message.clone());
    }
    if let Some(error) = cause.downcast_ref::<crate::run_configurations::lifecycle::ApiError>() {
        return Error::new(error.status, error.code, error.message.clone());
    }
    if cause.is::<crate::browsers::StateConflict>() {
        return Error::new(
            409,
            "conflict",
            "Browser state changed before this operation.",
        );
    }
    if let Some(error) = cause.downcast_ref::<crate::workers::bridge::CommandError>() {
        return bridge_error(error);
    }
    if let Some(crate::workers::command_bus::CommandFailure::Bridge(error)) =
        cause.downcast_ref::<crate::workers::command_bus::CommandFailure>()
    {
        return bridge_error(error);
    }
    let message = if let Some(error) =
        cause.downcast_ref::<crate::database::query_error::QueryError>()
    {
        error.message.clone()
    } else if let Some(error) = cause.downcast_ref::<crate::policies::PolicyQueryError>() {
        error.message.clone()
    } else if let Some(error) = cause.downcast_ref::<crate::policies::StoredPolicyValidationError>()
    {
        error.0.to_string().into()
    } else if let Some(error) =
        cause.downcast_ref::<crate::projects::targets::StoredTargetValidationError>()
    {
        error.0.to_string().into()
    } else {
        crate::settings::operation_error_message(cause)
    };
    Error::new(400, "invalid", message)
}
fn bridge_error(error: &crate::workers::bridge::CommandError) -> Error {
    let message = match error.encoding_error.as_deref() {
        Some(ValidationError::Invalid(issues)) => {
            Value::Array(issues.clone()).stringify_pretty().into()
        }
        _ => error.message.clone(),
    };
    Error::new(
        if error.unavailable { 503 } else { 400 },
        if error.unavailable {
            "unavailable"
        } else {
            "invalid"
        },
        message,
    )
}
async fn operation(
    service: &Arc<AuthService>,
    context: &Context,
    authorization: Option<&str>,
    raw: Option<&Value>,
) -> Result<Response> {
    let call = match crate::wire::parse("workerCliCommandCallSchema", raw) {
        Ok(value) => value,
        Err(ValidationError::Invalid(issues)) => {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                json!({"code":"invalid","error":"Invalid request body","issues":issues}),
            ));
        }
        Err(ValidationError::Operation) => anyhow::bail!("CLI request parsing failed"),
    };
    let worker = call["workerId"]
        .as_js_string()
        .context("CLI worker")?
        .lossy();
    let Some(auth) = credentials::authenticate(
        &service.workers.repository,
        &service.config,
        authorization,
        &worker,
        "worker:agent-tools",
    )
    .await?
    else {
        return Ok(super::agent_alerts::failure(401, "invalid", "Unauthorized"));
    };
    let owner = &auth.credential.owner_id;
    if crate::projects::targets::TargetRepository::for_mcp(service.repository.database.clone())
        .worker(owner, &call["workerId"])
        .await?
        .is_none()
    {
        return Ok(super::agent_alerts::failure(
            404,
            "not-found",
            "Worker not found.",
        ));
    }
    let command = call["command"].as_str().context("CLI command")?;
    let mutation = cli::is_mutation(command);
    let result: Result<Value> = async {
        let result = super::cli_commands::execute(service, owner, &call).await?;
        if mutation {
            // Source validates this audit identity after the operation has completed.
            let id = optional(&call["arguments"], "configurationId")?
                .unwrap_or_else(|| call["requestId"].clone());
            let action = if let Some(suffix) = command.strip_prefix("run.") {
                format!("run.configuration.cli.{suffix}")
            } else {
                "cli.command.mutated".to_owned()
            };
            super::agent_operations::audit_resource(
                service,
                owner,
                &context.id,
                &action,
                "succeeded",
                if command.starts_with("run.") {
                    "run-configuration"
                } else {
                    "cli-command"
                },
                Some(&id.as_js_string().context("CLI audit identity")?.lossy()),
            )
            .await;
        }
        crate::settings::parse_response("cantripCliCommandResultSchema", Some(&result))
    }
    .await;
    match result {
        Ok(result) => Ok(json_response(StatusCode::OK, result)),
        Err(cause) => {
            let error = classify(&cause);
            if mutation {
                let action = match command {
                    "run.start" => "run.configuration.cli.start-failed",
                    "run.restart" => "run.configuration.cli.restart-failed",
                    "run.stop" => "run.configuration.cli.stop-failed",
                    c if c.starts_with("run.") => "run.configuration.cli.mutation-failed",
                    _ => "cli.command.mutated",
                };
                let result = if matches!(
                    error.code,
                    "conflict" | "unsupported-capability" | "context-not-found"
                ) {
                    "denied"
                } else {
                    "failed"
                };
                super::agent_operations::audit_resource(
                    service,
                    owner,
                    &context.id,
                    action,
                    result,
                    "cli-command",
                    Some(
                        &call["requestId"]
                            .as_js_string()
                            .context("CLI request ID")?
                            .lossy(),
                    ),
                )
                .await;
            }
            let body = cause
                .downcast_ref::<crate::projects::worktrees::MutationError>()
                .map(|error| error.failure.clone())
                .unwrap_or_else(|| json!({"code":error.code,"error":error.message}));
            Ok(json_response(StatusCode::from_u16(error.status)?, body))
        }
    }
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    request: Request,
) -> Response {
    let authorization = middleware::value(request.headers(), "authorization");
    let raw = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(raw) => raw,
        Err(response) => return response,
    };
    let owned = service.scratch_roots.clone();
    let on_failure = service.clone();
    let request_id = context.id.clone();
    owned
        .owned(async move {
            operation(&service, &context, authorization.as_deref(), raw.as_ref()).await
        })
        .await
        .unwrap_or_else(|cause| middleware::failure(&on_failure, &request_id, &cause))
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new().route("/api/internal/cli", post(handle))
}
