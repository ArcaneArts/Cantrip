//! Opaque model-operation transport; credentials and inference stay on the worker.
use super::{
    body,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    settings::{self, repository::SettingsRepository},
    wire::{Value, value::json},
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
async fn execute(
    service: Arc<AuthService>,
    owner: String,
    input: Value,
    cancel: bool,
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
        None => repository.get_user_settings(&owner).await?["defaultEmbeddingModelId"]
            .as_str()
            .map(str::to_owned),
    };
    let Some(model) = model else {
        return Ok(super::json_response(
            axum::http::StatusCode::CONFLICT,
            json!({"code":"configuration-required","error":"Configure a default embedding model or select a model explicitly."}),
        ));
    };
    let route = repository
        .get_model_operation_route(
            &owner,
            "embedding",
            &model,
            &worker,
            input["scope"]["routeId"].as_str(),
        )
        .await?;
    let Some(route) = route else {
        return Ok(super::json_response(
            axum::http::StatusCode::CONFLICT,
            json!({"code":"configuration-required","error":"The selected embedding model has no configured enabled route."}),
        ));
    };
    let route = Value::from_serialize(&route);
    let command = json!({"type":"model.embedding","serverId":service.server_id,"scope":input["scope"],"operationId":input["operationId"],"protectedRequest":input["protectedRequest"],"route":route});
    // Matches MODEL_OPERATION_WIRE_BYTES_LIMIT; leave room in the 8 MiB frame.
    if command.stringify().len() > 7 * 1024 * 1024 {
        return Ok(super::json_response(
            axum::http::StatusCode::PAYLOAD_TOO_LARGE,
            json!({"code":"invalid-request","error":"The protected embedding command exceeds 7 MiB. Submit a smaller job or configuration."}),
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
            let raw = target
                .workers
                .commands
                .request_with_timeout(&worker, command, RequestTimeout::Disabled, None)
                .await?;
            let response =
                settings::parse_response("protectedEmbeddingResponseSchema", raw.as_ref())?;
            anyhow::ensure!(
                response["operationId"] == input["operationId"]
                    && response["scope"].stringify() == input["scope"].stringify(),
                "Embedding response scope changed."
            );
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
    let body = match body::parse_js_buffer(request, 7 * 1024 * 1024, 7 * 1024 * 1024).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let input = match parse(
        if cancel {
            "modelOperationCancelSchema"
        } else {
            "protectedEmbeddingRequestSchema"
        },
        body.as_ref(),
    ) {
        Ok(Ok(value)) => value,
        Ok(Err(response)) => return response,
        Err(cause) => return middleware::failure(&service, &ctx.id, &cause),
    };
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    match execute(service, owner, input, cancel).await {
        Ok(response) => response,
        Err(_) => super::json_response(
            axum::http::StatusCode::BAD_GATEWAY,
            json!({"code":"model-operation-unavailable","error":if cancel {"The worker could not confirm cancellation."} else {"The embedding worker operation could not be completed. It was not automatically retried."}}),
        ),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/model-operations/embedding", post(handle))
        .route("/api/model-operations/embedding/cancel", post(handle))
}
