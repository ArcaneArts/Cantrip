use super::{
    body, json_response,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    chats::{Repository, message_queries::MessageKind, message_writes::HistoryError},
    wire::{self, Value, value::json},
};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::StatusCode,
    response::Response,
    routing::{get, post},
};
use std::sync::Arc;

async fn read(service: &AuthService, owner: &str, id: &str, query: Value) -> Result<Response> {
    let repository = Repository::new(service.repository.database.clone());
    let Some(context) = repository.execution_context(owner, id).await? else {
        return Ok(error(404, "Chat source not found."));
    };
    let task = context["experience"] == "task";
    let kind = if task {
        "task-encrypted"
    } else {
        "chat-encrypted"
    };
    if query.get("beforeSequence").is_some() || query.get("limit").is_some() {
        // Source uses parse(), so invalid page queries pass through the global
        // error handler after ownership lookup instead of returning body400.
        let query = crate::settings::parse_response("chatMessagePageQuerySchema", Some(&query))?;
        let result = repository
            .opaque_message_page(owner, id, task, &query)
            .await?;
        output(
            200,
            "chatMessageWirePageSchema",
            &json!({"kind":kind,"messages":result["messages"],"page":result["page"]}),
        )
    } else {
        let messages = repository
            .list_messages(
                owner,
                id,
                if task {
                    MessageKind::Task
                } else {
                    MessageKind::Encrypted
                },
            )
            .await?;
        output(
            200,
            "chatMessageWireListSchema",
            &json!({"kind":kind,"messages":messages}),
        )
    }
}
async fn read_handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    let owner = &ctx
        .principal
        .user
        .as_ref()
        .expect("Authenticated message owner")
        .id;
    match read(&service, owner, &id, super::account::query(request.uri())).await {
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &ctx.id, &cause),
    }
}
async fn append(
    service: Arc<AuthService>,
    owner: String,
    id: String,
    input: Value,
) -> Result<Response> {
    let repository = Repository::new(service.repository.database.clone());
    let Some(context) = repository.execution_context(&owner, &id).await? else {
        return Ok(error(404, "Chat not found"));
    };
    if context["experience"] == "task" {
        return Ok(error(
            409,
            "Task messages must be encrypted by a trusted endpoint.",
        ));
    }
    let Some(message) = repository
        .append_encrypted_message(&owner, &id, &input, None)
        .await?
    else {
        return Ok(error(404, "Chat not found"));
    };
    let _=service.live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"chat","chatId":id}),"resource":"chat-message","action":"updated","entityId":message["id"],"revision":message["sequence"],"payload":message}));
    // The repository has already validated the returned DTO, as in Source.
    Ok(json_response(StatusCode::CREATED, message))
}
fn history_failure(cause: anyhow::Error) -> Result<Response> {
    if let Some(history) = cause.downcast_ref::<HistoryError>() {
        let status = StatusCode::from_u16(history.status_code)?;
        return Ok(json_response(
            status,
            json!({"statusCode":history.status_code,"code":history.code,"error":status.canonical_reason().unwrap_or("Unknown"),"message":history.to_string()}),
        ));
    }
    Err(cause)
}
async fn append_handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let input = match parse("chatMessageOpaqueContentSchema", body.as_ref()) {
        Ok(Ok(input)) => input,
        Ok(Err(response)) => return response,
        Err(cause) => return middleware::failure(&service, &ctx.id, &cause),
    };
    let owner = ctx
        .principal
        .user
        .as_ref()
        .expect("Authenticated message owner")
        .id
        .clone();
    let result = service
        .scratch_roots
        .owned(append(service.clone(), owner.clone(), id.clone(), input))
        .await;
    let result = match result {
        Ok(response) => Ok(response),
        Err(cause) => history_failure(cause),
    };
    match result {
        Ok(response) if response.status().as_u16() < 400 => {
            let live = service.live.clone();
            super::on_response::completed(response, move || {
                let _=live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"current-user"}),"resource":"chat","action":"invalidated","entityId":id,"revision":Value::Null,"payload":Value::Null}));
            })
        }
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &ctx.id, &cause),
    }
}
async fn history_handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let input = match wire::parse("nativeHistoryTurnReadRequestSchema", body.as_ref()) {
        Ok(input) => input,
        Err(_) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({"code":"invalid-native-history-turn-read"}),
            );
        }
    };
    let owner = &ctx
        .principal
        .user
        .as_ref()
        .expect("Authenticated history owner")
        .id;
    match Repository::new(service.repository.database.clone())
        .read_native_history_turns(owner, &id, &input)
        .await
    {
        Ok(value) => json_response(StatusCode::OK, value),
        Err(cause) => {
            if let Some(history) = cause.downcast_ref::<HistoryError>() {
                json_response(
                    StatusCode::from_u16(history.status_code).unwrap(),
                    json!({"code":history.code}),
                )
            } else {
                middleware::failure(&service, &ctx.id, &cause)
            }
        }
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(
            "/api/chats/{chatId}/messages",
            get(read_handle).post(append_handle),
        )
        .route(
            "/api/chats/{chatId}/native-history/turns/read",
            post(history_handle),
        )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn native_history_errors_match_source_message_route() -> Result<()> {
        let result = std::process::Command::new("node")
            .args([
                "--import",
                "tsx",
                "scripts/server-rust/chat-message-error-oracle.mjs",
            ])
            .current_dir(
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap(),
            )
            .output()?;
        anyhow::ensure!(
            result.status.success(),
            "Message error oracle failed: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        let expected: serde_json::Value = serde_json::from_slice(&result.stdout)?;
        for (index, code) in ["item-canonical-message-conflict", "output-alias-ambiguous"]
            .into_iter()
            .enumerate()
        {
            let response = history_failure(HistoryError::new(code, 409).into())?;
            let status = response.status().as_u16();
            let body: serde_json::Value =
                serde_json::from_slice(&axum::body::to_bytes(response.into_body(), 4096).await?)?;
            assert_eq!(
                serde_json::json!({"status":status,"body":body}),
                expected[index]
            );
        }
        Ok(())
    }
}
