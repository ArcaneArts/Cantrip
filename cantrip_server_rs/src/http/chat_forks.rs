use super::{
    body,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    chats::{Repository, forks::Conflict},
    wire::{Value, value::json},
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    response::Response,
    routing::post,
};
use std::sync::Arc;

async fn reprotect(
    service: Arc<AuthService>,
    worker: String,
    messages: Vec<Value>,
) -> Result<Vec<Value>> {
    let mut copies = Vec::new();
    for batch in messages.chunks(100) {
        let mut requested = Vec::with_capacity(batch.len());
        for message in batch {
            requested.push(json!({"source":message,"id":uuid::Uuid::new_v4().to_string(),"idempotencyKey":format!("fork:{}",message["id"].as_str().context("Fork source message ID")?)}));
        }
        let result = service
            .workers
            .commands
            .request(
                &worker,
                json!({"type":"chat.messages.reprotect","messages":requested}),
                None,
                None,
            )
            .await?;
        let parsed =
            crate::settings::parse_response("chatMessageOpaqueContentListSchema", result.as_ref())?;
        copies.extend(
            parsed
                .as_array()
                .context("Protected message list")?
                .iter()
                .cloned(),
        );
    }
    let parsed = crate::settings::parse_response(
        "chatMessageOpaqueContentListSchema",
        Some(&Value::Array(copies)),
    )?;
    Ok(parsed
        .as_array()
        .context("Protected fork message list")?
        .clone())
}
async fn fork(
    service: Arc<AuthService>,
    owner: String,
    id: String,
    input: Value,
) -> Result<Response> {
    let repository = Repository::new(service.repository.database.clone());
    let source = repository.execution_context(&owner, &id).await?;
    if source.as_ref().is_some_and(|s| s["experience"] == "task") {
        return Ok(error(
            409,
            "Encrypted Task chats must be relocated rather than forked so message row bindings remain valid.",
        ));
    }
    let Some(source) = source else {
        return Ok(error(404, "Chat not found."));
    };
    let worker = source["workerId"]
        .as_str()
        .context("Fork source worker")?
        .to_owned();
    if !service.workers.bridge.is_connected(&worker) {
        return Ok(error(503, "Chat worker is offline."));
    }
    let result=async{
        let transport=service.clone();
        let protect=move |messages|reprotect(transport,worker,messages);
        let (created,standalone)=if source["contextKind"]=="standalone"{
            (repository.fork_standalone(&owner,&id,&input,|id|service.workers.bridge.is_connected(id),protect).await?,true)
        }else{
            (repository.fork_project(&owner,&id,&input,protect).await?,false)
        };
        let Some(created)=created else{return Ok(error(404,"Chat or message not found."))};
        let chat=if standalone{&created["chat"]}else{&created};
        let scope=if crate::wire::coercion::truthy(chat.get("projectId")){json!({"kind":"project","projectId":chat["projectId"]})}else{json!({"kind":"current-user"})};
        let _=service.live.publish_event(json!({"ownerId":owner,"scope":scope,"resource":"chat","action":"invalidated","entityId":chat["id"],"revision":Value::Null,"payload":Value::Null}));
        if standalone{service.scratch_roots.queue();}
        output(if standalone{202}else{201},if standalone{"standaloneChatWireSummarySchema"}else{"chatWireSummarySchema"},chat)
    }.await;
    match result {
        Ok(response) => Ok(response),
        Err(cause) => failed(cause),
    }
}
fn failed(cause: anyhow::Error) -> Result<Response> {
    if cause.is::<Conflict>() {
        return Ok(error(409, cause.to_string()));
    }
    let duplicate = cause
        .downcast_ref::<crate::chats::catalog::StatementFailure>()
        .map_or_else(
            || {
                let message = cause.to_string().to_lowercase();
                message.contains("unique") || message.contains("duplicate")
            },
            |c| c.duplicate_message,
        );
    if duplicate {
        Ok(error(
            409,
            "This worktree is already leased by another chat.",
        ))
    } else if let Some(crate::workers::command_bus::CommandFailure::Limit(limit)) =
        cause.downcast_ref::<crate::workers::command_bus::CommandFailure>()
    {
        let mut response = error(429, limit.message);
        response.headers_mut().insert(
            axum::http::header::RETRY_AFTER,
            limit.retry_after_seconds.to_string().parse()?,
        );
        Ok(response)
    } else {
        Err(cause)
    }
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    let owner = ctx
        .principal
        .user
        .as_ref()
        .expect("Authenticated fork owner")
        .id
        .clone();
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(body) => body,
        Err(response) => return response,
    };
    let default = Value::Object(Default::default());
    let input = match parse(
        "encryptedChatForkSchema",
        Some(body.as_ref().filter(|v| !v.is_null()).unwrap_or(&default)),
    ) {
        Ok(Ok(input)) => input,
        Ok(Err(response)) => return response,
        Err(cause) => return middleware::failure(&service, &ctx.id, &cause),
    };
    match service
        .scratch_roots
        .owned(fork(service.clone(), owner.clone(), id.clone(), input))
        .await
    {
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
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new().route("/api/chats/{chatId}/fork", post(handle))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn relay_limit_response_matches_reference_fork_route() -> Result<()> {
        let result = std::process::Command::new("node")
            .args([
                "--import",
                "tsx",
                "scripts/server-rust/chat-fork-error-oracle.mjs",
            ])
            .current_dir(
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap(),
            )
            .output()?;
        anyhow::ensure!(
            result.status.success(),
            "Fork error oracle failed: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        let expected: serde_json::Value = serde_json::from_slice(&result.stdout)?;
        for (index, message) in [
            "Controlled fork budget exhausted.",
            "Controlled duplicate fork budget.",
        ]
        .into_iter()
        .enumerate()
        {
            let cause = crate::workers::command_bus::CommandFailure::Limit(
                crate::relay::RelayLimitError::new(message, 17),
            );
            let response = failed(cause.into())?;
            let status = response.status().as_u16();
            let retry = response
                .headers()
                .get(axum::http::header::RETRY_AFTER)
                .map(|v| v.to_str().unwrap().to_owned());
            let body: serde_json::Value =
                serde_json::from_slice(&axum::body::to_bytes(response.into_body(), 1024).await?)?;
            assert_eq!(
                serde_json::json!({"status":status,"retryAfter":retry,"body":body}),
                expected[index]
            );
        }
        Ok(())
    }
}
