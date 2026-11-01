//! Public reservations and owning-worker acknowledgements for native transfers.
use super::{
    body, json_response,
    middleware::{self, Context},
};
use crate::{
    auth::service::AuthService,
    native_commands::CommandError,
    native_handoffs::Repository,
    wire::{self, Value, value::json},
    workers::credentials,
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::StatusCode,
    response::Response,
    routing::{get, post},
};
use std::sync::Arc;

fn repository(service: &AuthService) -> Repository {
    Repository::new(service.repository.database.clone())
}
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Native handoff identity")?
        .lossy()
        .into_owned())
}
fn code(status: u16, key: &str) -> Response {
    json_response(StatusCode::from_u16(status).unwrap(), json!({"code":key}))
}
fn failure(service: &AuthService, id: &str, cause: anyhow::Error) -> Response {
    if let Some(error) = cause.downcast_ref::<CommandError>() {
        json_response(
            StatusCode::from_u16(error.status).unwrap(),
            json!({"code":error.code,"error":error.message}),
        )
    } else {
        middleware::failure(service, id, &cause)
    }
}
fn owner(context: &Context) -> &str {
    &context
        .principal
        .user
        .as_ref()
        .expect("Authenticated handoff owner")
        .id
}
fn invalidate(service: &AuthService, owner: &str, chat: &str) {
    let _ = service.live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"chat","chatId":chat}),"resource":"chat","action":"invalidated","entityId":Value::Null,"revision":Value::Null,"payload":Value::Null}));
}
async fn inventory(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    Path(chat): Path<String>,
) -> Response {
    match repository(&service).inventory(owner(&context), &chat).await {
        Ok(Some(value)) => json_response(StatusCode::OK, value),
        Ok(None) => code(404, "handoff-chat-not-found"),
        Err(cause) => failure(&service, &context.id, cause),
    }
}
async fn read(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    Path((chat, operation)): Path<(String, String)>,
) -> Response {
    match repository(&service)
        .get(owner(&context), &chat, &operation)
        .await
    {
        Ok(Some(value)) => json_response(StatusCode::OK, value),
        Ok(None) => code(404, "handoff-not-found"),
        Err(cause) => failure(&service, &context.id, cause),
    }
}
async fn start(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    Path(chat): Path<String>,
    request: Request,
) -> Response {
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let input = match wire::parse("nativeRuntimeHandoffRequestSchema", body.as_ref()) {
        Ok(input) => input,
        Err(_) => return code(400, "invalid-native-runtime-handoff"),
    };
    match service
        .native_handoffs
        .start(owner(&context), &chat, &input)
        .await
    {
        Ok(value) => json_response(StatusCode::ACCEPTED, value),
        Err(cause) => failure(&service, &context.id, cause),
    }
}
async fn resume(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    Path((chat, operation)): Path<(String, String)>,
    request: Request,
) -> Response {
    let cancel = request.uri().path().ends_with("/cancel");
    // Fastify parses even an unused retry/cancellation payload.
    if let Err(response) = body::parse_js(request, service.config.api_body_limit_bytes).await {
        return response;
    }
    let result = if cancel {
        service
            .native_handoffs
            .cancel(owner(&context), &chat, &operation)
            .await
            .map(Some)
    } else {
        service
            .native_handoffs
            .retry(owner(&context), &chat, &operation)
            .await
    };
    match result {
        Ok(Some(value)) => json_response(StatusCode::ACCEPTED, value),
        Ok(None) => code(404, "handoff-not-found"),
        Err(cause) => failure(&service, &context.id, cause),
    }
}
async fn internal_apply(
    service: Arc<AuthService>,
    owner: String,
    input: Value,
    configuration: bool,
) -> Result<Response> {
    let repository = repository(&service);
    let (chat, operation, worker) = (
        text(&input["chatId"])?,
        text(&input["operationId"])?,
        text(&input["workerId"])?,
    );
    let Some(state) = repository
        .get(&owner, &chat, &operation)
        .await?
        .filter(|state| state.get("workerId") == input.get("workerId"))
    else {
        return Ok(code(404, "handoff-not-found"));
    };
    if configuration {
        let result = repository
            .configuration(
                &owner,
                &state,
                &text(&input["side"])?,
                &service.managed_console,
            )
            .await?;
        let current = repository.get(&owner, &chat, &operation).await?;
        if current.as_ref().is_none_or(|current| {
            current.get("updatedAt") != state.get("updatedAt")
                || current.get("phase") != state.get("phase")
        }) {
            return Err(CommandError::new("handoff-configuration-replaced", None, 409).into());
        }
        return Ok(json_response(StatusCode::OK, result));
    }
    let action = text(&input["action"])?;
    let result = match action.as_str() {
        "read" => state,
        "prepared" => {
            repository
                .prepared(
                    &owner,
                    &worker,
                    &operation,
                    &input["prepared"],
                    input.get("expectedPreparedRuntimeGeneration"),
                    input.get("expectedPreparedNativeEpoch"),
                )
                .await?
        }
        "recover" => {
            repository
                .recover(
                    &owner,
                    &worker,
                    &operation,
                    &text(&input["side"])?,
                    &input["expectedBindingId"],
                    &input["recovered"],
                )
                .await?
        }
        "commit" => repository.commit(&owner, &worker, &operation).await?,
        "finish" => {
            repository
                .finish(&owner, &worker, &operation, &text(&input["outcome"])?)
                .await?
        }
        "failure" => {
            repository
                .failure(&owner, &worker, &operation, &text(&input["errorCode"])?)
                .await?
        }
        _ => unreachable!("Validated handoff action"),
    };
    if action != "read" {
        invalidate(&service, &owner, &chat);
    }
    Ok(json_response(StatusCode::OK, result))
}
async fn internal(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    request: Request,
) -> Response {
    let configuration = request.uri().path().ends_with("/configuration");
    let authorization = middleware::value(request.headers(), "authorization");
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let input = match wire::parse(
        if configuration {
            "nativeRuntimeHandoffConfigurationRequestSchema"
        } else {
            "nativeRuntimeHandoffWorkerRequestSchema"
        },
        body.as_ref(),
    ) {
        Ok(input) => input,
        Err(_) => return code(400, "invalid-native-runtime-handoff"),
    };
    let worker = match text(&input["workerId"]) {
        Ok(worker) => worker,
        Err(cause) => return failure(&service, &context.id, cause),
    };
    let authentication = match credentials::authenticate(
        &service.workers.repository,
        &service.config,
        authorization.as_deref(),
        &worker,
        "worker:agent-tools",
    )
    .await
    {
        Ok(Some(authentication)) => authentication,
        Ok(None) => return code(401, "unauthorized"),
        Err(cause) => return failure(&service, &context.id, cause),
    };
    match service
        .native_handoffs
        .owned(internal_apply(
            service.clone(),
            authentication.credential.owner_id,
            input,
            configuration,
        ))
        .await
    {
        Ok(response) => response,
        Err(cause) => failure(&service, &context.id, cause),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(
            "/api/chats/{chatId}/runtime-handoffs",
            get(inventory).post(start),
        )
        .route(
            "/api/chats/{chatId}/runtime-handoffs/{operationId}",
            get(read),
        )
        .route(
            "/api/chats/{chatId}/runtime-handoffs/{operationId}/retry",
            post(resume),
        )
        .route(
            "/api/chats/{chatId}/runtime-handoffs/{operationId}/cancel",
            post(resume),
        )
        .route("/api/internal/native-runtime-handoffs", post(internal))
        .route(
            "/api/internal/native-runtime-handoffs/configuration",
            post(internal),
        )
}
