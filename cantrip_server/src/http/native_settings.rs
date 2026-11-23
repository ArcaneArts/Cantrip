//! Protected settings are read and changed by the owning worker.
mod model_inventory;
use super::{
    body, json_response,
    middleware::{self, Context},
};
use crate::{
    auth::service::AuthService,
    native_commands::{CommandError, settings_persistence::SettingsRepository},
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
use futures::FutureExt;
use std::sync::Arc;
fn repository(service: &AuthService) -> SettingsRepository {
    SettingsRepository::new(service.repository.database.clone())
}
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Native settings routing identity")?
        .lossy()
        .into_owned())
}
fn code(status: u16, key: &str) -> Response {
    json_response(StatusCode::from_u16(status).unwrap(), json!({"code":key}))
}
fn failure(service: &AuthService, id: &str, cause: anyhow::Error) -> Response {
    if let Some(e) = cause.downcast_ref::<CommandError>() {
        json_response(
            StatusCode::from_u16(e.status).unwrap(),
            json!({"code":e.code,"error":e.message}),
        )
    } else {
        middleware::failure(service, id, &cause)
    }
}
fn invalidate(service: &AuthService, owner: &str, chat: &str) {
    let _=service.live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"chat","chatId":chat}),"resource":"chat","action":"invalidated","entityId":Value::Null,"revision":Value::Null,"payload":Value::Null}));
}
async fn refresh(
    service: Arc<AuthService>,
    owner: &str,
    chat: &str,
    worker: Option<Value>,
) -> Result<Value> {
    let commands = service.workers.commands.clone();
    repository(&service)
        .refresh(owner, chat, move |scope| async move {
            if worker
                .as_ref()
                .is_some_and(|worker| scope.get("workerId") != Some(worker))
            {
                return Err(CommandError::new(
                    "settings-worker-mismatch",
                    Some("The chat belongs to another worker."),
                    403,
                )
                .into());
            }
            let result = commands
                .request(
                    &text(&scope["workerId"])?,
                    json!({"type":"chat.settings.read","scope":scope}),
                    None,
                    None,
                )
                .await?;
            match result {
                Some(value) => Ok(value),
                None => {
                    crate::settings::parse_response("protectedNativeSettingsSnapshotSchema", None)
                }
            }
        })
        .boxed()
        .await
}
async fn read_handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(chat): Path<String>,
) -> Response {
    let owner = &ctx
        .principal
        .user
        .as_ref()
        .expect("Authenticated settings owner")
        .id;
    match repository(&service).get(owner, &chat).await {
        Ok(Some(value)) => json_response(StatusCode::OK, value),
        Ok(None) => json_response(StatusCode::NOT_FOUND, json!({"error":"Chat not found."})),
        Err(cause) => middleware::failure(&service, &ctx.id, &cause),
    }
}
async fn client_apply(
    service: Arc<AuthService>,
    owner: String,
    chat: String,
    phase: String,
    input: Value,
) -> Result<Value> {
    let repository = repository(&service);
    if phase == "refresh" {
        let state = refresh(service.clone(), &owner, &chat, None).await?;
        invalidate(&service, &owner, &chat);
        return Ok(state);
    }
    let binding = repository
        .resolve_write_binding(&owner, &chat, &input["bindingId"])
        .await?;
    let defaults = phase == "defaults";
    let command = if defaults {
        json!({"type":"chat.account-defaults","binding":binding,"request":input})
    } else {
        let mut command = input.clone();
        command["type"] = json!("chat.settings.update");
        command["binding"] = binding.clone();
        command
    };
    let result = service
        .workers
        .commands
        .request(&text(&binding["workerId"])?, command, None, None)
        .await?;
    let result = crate::settings::parse_response(
        if defaults {
            "nativeAccountDefaultsResponseSchema"
        } else {
            "nativeSettingsUpdateReceiptSchema"
        },
        result.as_ref(),
    )?;
    if result.get("operationId") != input.get("operationId")
        || (defaults && result.get("bindingId") != binding.get("bindingId"))
    {
        anyhow::bail!(if defaults {
            "Account defaults response belongs to another operation."
        } else {
            "Native settings response belongs to another operation."
        });
    }
    if defaults {
        repository
            .resolve_write_binding(&owner, &chat, &input["bindingId"])
            .await?;
    } else {
        invalidate(&service, &owner, &chat);
    }
    Ok(result)
}
async fn client_handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(chat): Path<String>,
    request: Request,
) -> Response {
    let phase = if request.uri().path().ends_with("/refresh") {
        "refresh"
    } else if request.uri().path().ends_with("/native-account-defaults") {
        "defaults"
    } else {
        "update"
    }
    .to_owned();
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let input = if phase == "refresh" {
        Value::Null
    } else {
        match wire::parse(
            if phase == "defaults" {
                "nativeAccountDefaultsRequestSchema"
            } else {
                "nativeSettingsUpdateRequestSchema"
            },
            body.as_ref(),
        ) {
            Ok(value) => value,
            Err(_) => {
                return code(
                    400,
                    if phase == "defaults" {
                        "invalid-native-account-defaults"
                    } else {
                        "invalid-native-settings-update"
                    },
                );
            }
        }
    };
    let owner = ctx
        .principal
        .user
        .as_ref()
        .expect("Authenticated settings owner")
        .id
        .clone();
    match service
        .scratch_roots
        .owned(client_apply(service.clone(), owner, chat, phase, input))
        .await
    {
        Ok(value) => json_response(StatusCode::OK, value),
        Err(cause) => failure(&service, &ctx.id, cause),
    }
}
async fn internal_apply(
    service: Arc<AuthService>,
    owner: String,
    input: Value,
    is_refresh: bool,
) -> Result<Value> {
    let chat = if is_refresh {
        &input["chatId"]
    } else {
        &input["snapshot"]["context"]["chatId"]
    };
    let chat = text(chat)?;
    let result = if is_refresh {
        refresh(
            service.clone(),
            &owner,
            &chat,
            Some(input["workerId"].clone()),
        )
        .await?
    } else {
        repository(&service).observe(&owner, &input).await?
    };
    invalidate(&service, &owner, &chat);
    Ok(result)
}
async fn internal_handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    request: Request,
) -> Response {
    let is_refresh = request.uri().path().ends_with("/settings-refresh");
    let authorization = middleware::value(request.headers(), "authorization");
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let input = match wire::parse(
        if is_refresh {
            "nativeSettingsRefreshRequestSchema"
        } else {
            "nativeSettingsObservationRequestSchema"
        },
        body.as_ref(),
    ) {
        Ok(input) => input,
        Err(_) => return code(400, "invalid-native-settings"),
    };
    let worker = match text(&input["workerId"]) {
        Ok(worker) => worker,
        Err(cause) => return failure(&service, &ctx.id, cause),
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
        Err(cause) => return failure(&service, &ctx.id, cause),
    };
    match service
        .scratch_roots
        .owned(internal_apply(
            service.clone(),
            authentication.credential.owner_id,
            input,
            is_refresh,
        ))
        .await
    {
        Ok(value) => json_response(StatusCode::OK, value),
        Err(cause) => failure(&service, &ctx.id, cause),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(
            "/api/chats/{chatId}/native-settings/models",
            get(model_inventory::handle),
        )
        .route("/api/chats/{chatId}/native-settings", get(read_handle))
        .route(
            "/api/chats/{chatId}/native-settings/refresh",
            post(client_handle),
        )
        .route(
            "/api/chats/{chatId}/native-settings/update",
            post(client_handle),
        )
        .route(
            "/api/chats/{chatId}/native-account-defaults",
            post(client_handle),
        )
        .route(
            "/api/internal/native-commands/settings-refresh",
            post(internal_handle),
        )
        .route(
            "/api/internal/native-commands/settings-observation",
            post(internal_handle),
        )
}
