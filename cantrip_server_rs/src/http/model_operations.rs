//! Opaque model-operation transport; credentials and inference stay on the worker.
use super::{
    body,
    middleware::{self, Context},
    settings::{error, output},
};
use crate::{
    auth::service::AuthService,
    operations::logging::{self, LogCall},
    settings::{self, repository::SettingsRepository},
    wire::{self, ValidationError, Value, value::json},
    workers::{command_bus::RequestTimeout, repository::WorkerRepository},
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{MatchedPath, Request, State},
    response::Response,
    routing::post,
};
use std::{sync::Arc, time::Duration};

struct CancelOnDrop {
    service: Arc<AuthService>,
    worker: String,
    command: Option<Value>,
}
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(command) = self.command.take() {
            let service = self.service.clone();
            let worker = self.worker.clone();
            tokio::spawn(async move {
                let _ = service
                    .workers
                    .commands
                    .request(&worker, command, Some(Duration::from_secs(30)), None)
                    .await;
            });
        }
    }
}
fn report_usage(
    service: &Arc<AuthService>,
    owner: &str,
    identity: &Value,
    status: &str,
    raw_receipt: Option<&Value>,
) {
    let receipt = raw_receipt
        .and_then(|value| settings::parse_response("modelOperationUsageSchema", Some(value)).ok())
        .filter(|receipt| settings::model_operation_usage::receipt_fits(receipt, identity));
    let input = json!({"identity":identity,"transportStatus":status,"receipt":receipt});
    let repository = SettingsRepository::new(service.repository.database.clone());
    let jobs = service.scratch_roots.clone();
    let owner = owner.to_owned();
    tokio::spawn(async move {
        // Reporting is tracked during shutdown but never gates inference or its
        // protected response. A missing receipt remains explicitly unknown.
        let result = jobs
            .owned(async move {
                repository
                    .record_model_operation_usage(&owner, &input)
                    .await
            })
            .await;
        if result.is_err() {
            (logging::server_logger())(LogCall::event(
                "warn",
                "Model operation usage could not be recorded.",
                json!({"event":"model.operation.usage-unavailable"}),
            ));
        }
    });
}
async fn execute(
    service: Arc<AuthService>,
    owner: String,
    input: Value,
    cancel: bool,
    operation: &'static str,
) -> Result<Response> {
    let worker = input["scope"]["workerId"]
        .as_str()
        .context("validated worker ID")?
        .to_owned();
    let workers = WorkerRepository::new(service.repository.database.clone());
    if workers.get_worker(&owner, &worker).await?.is_none() {
        return Ok(error(404, "Worker not found."));
    }
    let cancel_command = json!({"type":"model.operation.cancel","serverId":service.server_id,"operationId":input["operationId"],"scope":input["scope"]});
    if cancel {
        let raw = service
            .workers
            .commands
            .request(&worker, cancel_command, Some(Duration::from_secs(30)), None)
            .await?;
        let value = settings::parse_response("modelOperationCancelResultSchema", raw.as_ref())?;
        return output(200, "modelOperationCancelResultSchema", &value);
    }
    let repository = SettingsRepository::new(service.repository.database.clone());
    let selected = input["scope"]["modelId"].as_str().map(str::to_owned);
    let model = match selected {
        Some(id) => Some(id),
        None => repository.get_user_settings(&owner).await?[if operation == "embedding" {
            "defaultEmbeddingModelId"
        } else {
            "defaultDecisionModelId"
        }]
        .as_str()
        .map(str::to_owned),
    };
    let Some(model) = model else {
        return Ok(super::json_response(
            axum::http::StatusCode::CONFLICT,
            json!({"code":"configuration-required","error":format!("Configure a default {operation} model or select a model explicitly.")}),
        ));
    };
    let route = repository
        .get_model_operation_route(
            &owner,
            operation,
            &model,
            &worker,
            input["scope"]["routeId"].as_str(),
        )
        .await?;
    let Some(route) = route else {
        return Ok(super::json_response(
            axum::http::StatusCode::CONFLICT,
            json!({"code":"configuration-required","error":format!("The selected {operation} model has no configured enabled route.")}),
        ));
    };
    let route = Value::from_serialize(&route);
    let usage_identity = json!({"serverId":service.server_id,"workerId":worker,"operationId":input["operationId"],"operation":operation,"modelId":route["modelId"],"routeId":route["routeId"],"providerId":route["provider"]["id"]});
    let command = json!({"type":if operation == "embedding" {"model.embedding"} else {"model.decision"},"serverId":service.server_id,"scope":input["scope"],"operationId":input["operationId"],"protectedRequest":input["protectedRequest"],"route":route});
    // Matches MODEL_OPERATION_WIRE_BYTES_LIMIT; leave room in the 8 MiB frame.
    if command.stringify().len() > 7 * 1024 * 1024 {
        return Ok(super::json_response(
            axum::http::StatusCode::PAYLOAD_TOO_LARGE,
            json!({"code":"invalid-request","error":"The protected model command exceeds 7 MiB. Submit a smaller job or configuration."}),
        ));
    }
    let mut cancellation = CancelOnDrop {
        service: service.clone(),
        worker: worker.clone(),
        command: Some(cancel_command),
    };
    let target = service.clone();
    let result = service
        .scratch_roots
        .owned(async move {
            report_usage(&target, &owner, &usage_identity, "running", None);
            let raw = target
                .workers
                .commands
                .request_with_timeout(&worker, command, RequestTimeout::Disabled, None)
                .await;
            let raw = match raw {
                Ok(value) => value,
                Err(error) => {
                    report_usage(&target, &owner, &usage_identity, "unavailable", None);
                    return Err(error.into());
                }
            };
            let raw = raw.unwrap_or(Value::Null);
            let public = json!({"operationId":raw["operationId"],"scope":raw["scope"],"protectedResponse":raw["protectedResponse"]});
            let response = match settings::parse_response("protectedEmbeddingResponseSchema", Some(&public)) {
                Ok(value) => value,
                Err(error) => {
                    report_usage(&target, &owner, &usage_identity, "unavailable", None);
                    return Err(error);
                }
            };
            if response["operationId"] != input["operationId"] || response["scope"].stringify() != input["scope"].stringify() {
                report_usage(&target, &owner, &usage_identity, "unavailable", None);
            }
            anyhow::ensure!(
                response["operationId"] == input["operationId"]
                    && response["scope"].stringify() == input["scope"].stringify(),
                "Model operation response scope changed."
            );
            report_usage(&target, &owner, &usage_identity, "replied", raw.get("usageReceipt"));
            output(200, "protectedEmbeddingResponseSchema", &response)
        })
        .await;
    if result.is_ok() {
        cancellation.command = None;
    }
    result
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    matched: MatchedPath,
    request: Request,
) -> Response {
    let cancel = matched.as_str().ends_with("/cancel");
    let operation = if matched.as_str().contains("/decision") {
        "decision"
    } else {
        "embedding"
    };
    let body = match body::parse_js_buffer(request, 7 * 1024 * 1024, 7 * 1024 * 1024).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let input = match wire::parse(
        if cancel {
            "modelOperationCancelSchema"
        } else {
            "protectedEmbeddingRequestSchema"
        },
        body.as_ref(),
    ) {
        Ok(value) => value,
        Err(ValidationError::Invalid(_)) => {
            return if cancel {
                error(400, "Invalid model operation cancellation.")
            } else {
                super::json_response(
                    axum::http::StatusCode::BAD_REQUEST,
                    json!({"code":"invalid-request","error":format!("Invalid protected {operation} request.")}),
                )
            };
        }
        Err(ValidationError::Operation) => {
            return middleware::failure(
                &service,
                &ctx.id,
                &anyhow::anyhow!("Model operation request validation failed."),
            );
        }
    };
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    match execute(service, owner, input, cancel, operation).await {
        Ok(response) => response,
        Err(_) if cancel => error(502, "The worker could not confirm cancellation."),
        Err(_) => super::json_response(
            axum::http::StatusCode::BAD_GATEWAY,
            json!({"code":"model-operation-unavailable","error":format!("The {operation} worker operation could not be completed. It was not automatically retried.")}),
        ),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/model-operations/embedding", post(handle))
        .route("/api/model-operations/embedding/cancel", post(handle))
        .route("/api/model-operations/decision", post(handle))
        .route("/api/model-operations/decision/cancel", post(handle))
}
