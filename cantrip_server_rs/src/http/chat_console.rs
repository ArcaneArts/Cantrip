//! Linked consoles use the same managed launch and durable terminal identity.
use super::{
    body,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    chats, terminals,
    wire::{Value, coercion::truthy},
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    response::Response,
    routing::post,
};
use std::sync::Arc;

async fn create(service: &AuthService, owner: &str, chat: &str, input: &Value) -> Result<Response> {
    let chats = chats::Repository::new(service.repository.database.clone());
    let Some(mut context) = chats.execution_context(owner, chat).await? else {
        return Ok(error(404, "Chat source not found."));
    };
    if context["contextKind"] == "standalone" {
        return Ok(error(
            409,
            "Standalone Chats do not support linked Codex consoles.",
        ));
    }
    if context["experience"] == "task" {
        return Ok(error(
            409,
            "Encrypted Task console state stays on its authorized worker.",
        ));
    }
    let Some(runtime) = service
        .model_routing
        .runtime_for_context(owner, &context)
        .await?
    else {
        return Ok(error(409, "No provider route is currently available."));
    };
    if !truthy(context.get("threadId"))
        || runtime["routeId"] != context["modelRouteId"]
        || runtime["provider"].get("accountId").unwrap_or(&Value::Null)
            != &context["providerAccountId"]
    {
        let worker = context["workerId"].as_str().context("Console worker")?;
        if !service.workers.bridge.is_connected(worker) {
            return Ok(error(503, "Project worker is offline."));
        }
        context["threadId"] = Value::Null;
        if let Err(cause) = service
            .managed_console
            .prepare_launch(owner, &context, &runtime)
            .await
        {
            return Ok(error(409, crate::settings::operation_error_message(&cause)));
        }
        context = chats
            .execution_context(owner, chat)
            .await?
            .context("Chat source not found.")?;
    }
    match terminals::Repository::new(service.repository.database.clone())
        .get_or_create_chat_console(
            owner,
            context["chatId"].as_str().context("Console chat")?,
            input,
        )
        .await?
    {
        Some(terminal) => output(201, "terminalWireSummarySchema", &terminal),
        None => Ok(error(404, "Chat source not found.")),
    }
}

async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    Path(chat): Path<String>,
    request: Request,
) -> Response {
    let result: Result<Response> = async {
        let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
            Ok(body) => body,
            Err(response) => return Ok(response),
        };
        let input = match parse("encryptedLinkedConsoleCreateSchema", body.as_ref())? {
            Ok(input) => input,
            Err(response) => return Ok(response),
        };
        let owner = context
            .principal
            .user
            .as_ref()
            .context("Authenticated console owner")?
            .id
            .clone();
        let owned_service = service.clone();
        service
            .worker_maintenance
            .owned(async move { create(&owned_service, &owner, &chat, &input).await })
            .await
    }
    .await;
    result.unwrap_or_else(|cause| middleware::failure(&service, &context.id, &cause))
}

pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new().route("/api/chats/{chatId}/console", post(handle))
}
