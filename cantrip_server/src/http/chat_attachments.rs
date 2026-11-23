//! Opaque attachment upload/download and concurrent replica deletion.
use super::{
    account, body,
    middleware::{self, Context},
    settings::{error, output},
    worker_links::request_failure,
};
use crate::{
    auth::service::AuthService,
    chats::{self, attachments::Repository, turn_storage::attachment_summary},
    wire::{self, Value, value::json},
    workers::command_bus::CommandFailure,
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::{Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use std::sync::Arc;

const CHUNK_BYTES: i64 = 256 * 1024;

async fn upload(
    service: &Arc<AuthService>,
    owner: &str,
    chat: &str,
    input: Option<Value>,
) -> Result<Response> {
    let Some(context) = chats::Repository::new(service.repository.database.clone())
        .execution_context(owner, chat)
        .await?
    else {
        return Ok(error(404, "Chat not found."));
    };
    let worker = context["workerId"].as_str().context("Attachment worker")?;
    if !service.workers.bridge.is_connected(worker) {
        return Ok(error(503, "Project worker is offline."));
    }
    let Ok(input) = wire::parse("attachmentUploadOpaqueSchema", input.as_ref()) else {
        return Ok(error(400, "Invalid attachment upload."));
    };
    let size = input["sizeBytes"].as_i64().context("Attachment size")?;
    if size as u64 > service.config.upload_limit_bytes {
        return Ok(error(400, "Invalid attachment upload."));
    }
    let id = input["attachmentId"]
        .as_str()
        .context("Attachment identity")?;
    let repository = Repository::new(service.repository.database.clone());
    if repository.get(owner, id).await?.is_some() {
        return Ok(error(409, "Attachment already exists."));
    }
    // This quota is charged outside the worker catch and carries Retry-After.
    if let Err(limit) = service.workers.relay_quotas.consume_upload_at(
        owner,
        worker,
        size as u64,
        crate::auth::now().timestamp_millis(),
    ) {
        let mut response = error(429, limit.message);
        response.headers_mut().insert(
            header::RETRY_AFTER,
            limit.retry_after_seconds.to_string().parse()?,
        );
        return Ok(response);
    }
    let result: Result<Value> = async {
        let base = json!({"chatId":context["chatId"],"attachmentId":input["attachmentId"],"operationId":input["operationId"]});
        let mut begin = base.clone();
        begin["type"] = json!("attachment.upload.begin");
        begin["direction"] = json!("upload");
        begin["protectedMetadata"] = input["protectedMetadata"].clone();
        begin["sizeBytes"] = input["sizeBytes"].clone();
        service.workers.commands.request(worker,begin,None,None).await?;
        for chunk in input["chunks"].as_array().context("Attachment chunks")? {
            let mut command = base.clone(); command["type"]=json!("attachment.upload.chunk"); command["direction"]=json!("upload"); command["chunk"]=chunk.clone();
            service.workers.commands.request(worker,command,None,None).await?;
        }
        let mut complete = base; complete["type"] = json!("attachment.upload.complete");
        let uploaded = service.workers.commands.request(worker,complete,None,None).await?;
        let uploaded = crate::settings::parse_response("workerAttachmentUploadResultSchema",uploaded.as_ref())?;
        if uploaded["sizeBytes"] != input["sizeBytes"] || uploaded["verified"] != true { anyhow::bail!("Attachment worker rejected the protected upload."); }
        repository.create(owner,context["chatId"].as_str().context("Attachment Chat")?,worker,&input,size as i32).await?.context("Chat not found.")
    }.await;
    match result {
        Ok(record) => output(
            201,
            "chatAttachmentOpaqueSummarySchema",
            &attachment_summary(&record),
        ),
        Err(cause) => {
            let _ = service.workers.commands.request(worker,json!({"type":"attachment.delete","chatId":context["chatId"],"attachmentId":input["attachmentId"]}),None,None).await;
            Ok(request_failure(&cause))
        }
    }
}

async fn content(
    service: &Arc<AuthService>,
    owner: &str,
    id: &str,
    query: &Value,
) -> Result<Response> {
    let repository = Repository::new(service.repository.database.clone());
    let Some(attachment) = repository.get(owner, id).await? else {
        return Ok(error(404, "Attachment not found."));
    };
    if attachment["status"] == "failed" {
        return Ok(error(409, "The attachment content is unavailable."));
    }
    let operation = match query.get("operationId") {
        None | Some(Value::Null) => crate::wire::JsString::from(""),
        Some(value) => value
            .as_js_string()
            .context("Attachment operation trim")?
            .trim(),
    };
    let valid = operation.as_str().is_some_and(|operation| {
        uuid::Uuid::parse_str(operation)
            .is_ok_and(|id| id.get_version_num() == 4 && id.get_variant() == uuid::Variant::RFC4122)
            && operation.len() == 36
            && [8, 13, 18, 23]
                .iter()
                .all(|index| operation.as_bytes()[*index] == b'-')
    });
    if !valid {
        return Ok(error(400, "Invalid attachment operation."));
    }
    let workers = connected(service, &attachment, repository.replicas(owner, id).await?);
    let Some(worker) = workers.first() else {
        return Ok(error(503, "Attachment worker is offline."));
    };
    let mut no_store = false;
    let result: Result<Response> = async {
        let expected = attachment["sizeBytes"].as_i64().context("Attachment size")?;
        let (mut offset,mut sequence) = (0_i64,0_i64);
        let mut chunks = Vec::new();
        while offset<expected || (expected==0 && offset==0) {
            let chunk = service.workers.commands.request(worker,json!({"type":"attachment.read","chatId":attachment["chatId"],"attachmentId":attachment["id"],"operationId":operation,"direction":"download","protectedMetadata":attachment["protectedMetadata"],"sequence":sequence,"offset":offset,"limit":CHUNK_BYTES}),None,None).await?;
            let chunk = crate::settings::parse_response("workerAttachmentReadResultSchema",chunk.as_ref())?;
            if chunk["sizeBytes"] != attachment["sizeBytes"] { anyhow::bail!("Attachment worker returned an inconsistent content size."); }
            let count = chunk["chunk"]["plaintextBytes"].as_i64().context("Attachment chunk bytes")?;
            if chunk["chunk"]["sequence"].as_i64() != Some(sequence) || count > CHUNK_BYTES.min((expected-offset).max(0)) { anyhow::bail!("Attachment worker returned an oversized chunk."); }
            chunks.push(chunk["chunk"].clone()); offset+=count; sequence+=1;
            if chunk["chunk"]["eof"] == true { if offset!=expected { anyhow::bail!("Attachment content was truncated."); } break; }
            if offset==expected { anyhow::bail!("Attachment worker did not terminate the content stream."); }
            if count==0 { anyhow::bail!("Attachment worker returned an empty chunk."); }
        }
        no_store = true;
        output(200,"attachmentDownloadOpaqueSchema",&json!({"attachmentId":attachment["id"],"operationId":operation,"sizeBytes":attachment["sizeBytes"],"protectedMetadata":attachment["protectedMetadata"],"chunks":chunks}))
    }.await;
    let mut response = result.unwrap_or_else(|cause| request_failure(&cause));
    if no_store {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            header::HeaderValue::from_static("no-store"),
        );
    }
    Ok(response)
}

fn connected(service: &AuthService, attachment: &Value, replicas: Vec<String>) -> Vec<String> {
    let mut workers = Vec::new();
    for worker in attachment["workerId"]
        .as_str()
        .map(str::to_owned)
        .into_iter()
        .chain(replicas)
    {
        if !workers.contains(&worker) && service.workers.bridge.is_connected(&worker) {
            workers.push(worker);
        }
    }
    workers
}

async fn remove(service: &Arc<AuthService>, owner: &str, id: &str) -> Result<Response> {
    let repository = Repository::new(service.repository.database.clone());
    let Some(attachment) = repository.get(owner, id).await? else {
        return Ok(error(404, "Attachment not found."));
    };
    let workers = connected(service, &attachment, repository.replicas(owner, id).await?);
    // Promise.all dispatches every replica before settling the first failure.
    // Individually owned tasks continue and drain even if that response settles.
    let pending = workers.into_iter().map(|worker| {
        let service = service.clone(); let command = json!({"type":"attachment.delete","chatId":attachment["chatId"],"attachmentId":attachment["id"]});
        service.clone().project_operations.own(async move { Ok(service.workers.commands.request(&worker,command,None,None).await?) })
    }).collect::<Vec<_>>();
    futures::future::try_join_all(pending).await?;
    repository.delete(owner, id).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    let result: Result<Response> = async {
        let method = request.method().clone();
        let query = account::query(request.uri());
        let binary_limit = (service.config.upload_limit_bytes * 3).div_ceil(2) + 1024 * 1024;
        let body = if method == Method::POST {
            match body::parse_attachment(request, service.config.api_body_limit_bytes, binary_limit)
                .await
            {
                Ok(body) => body,
                Err(response) => return Ok(response),
            }
        } else {
            if let Err(response) =
                body::parse_ignored(request, service.config.api_body_limit_bytes, binary_limit)
                    .await
            {
                return Ok(response);
            }
            None
        };
        let owner = ctx
            .principal
            .user
            .as_ref()
            .context("Attachment principal")?
            .id
            .clone();
        let service = service.clone();
        service
            .clone()
            .project_operations
            .own(async move {
                if method == Method::POST {
                    upload(&service, &owner, &id, body).await
                } else if method == Method::DELETE {
                    remove(&service, &owner, &id).await
                } else {
                    content(&service, &owner, &id, &query).await
                }
            })
            .await
    }
    .await;
    match result {
        Ok(response) => response,
        Err(cause) => {
            // DELETE deliberately has no worker catch in Source. Its actual
            // command quota failure reaches the global handler with Retry-After.
            if let Some(CommandFailure::Limit(limit)) = cause.downcast_ref::<CommandFailure>() {
                let mut response = error(429, limit.message);
                response.headers_mut().insert(
                    header::RETRY_AFTER,
                    limit.retry_after_seconds.to_string().parse().unwrap(),
                );
                response
            } else {
                middleware::failure(&service, &ctx.id, &cause)
            }
        }
    }
}

pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/chats/{chatId}/attachments", post(handle))
        .route("/api/attachments/{attachmentId}/content", get(handle))
        .route("/api/attachments/{attachmentId}", delete(handle))
}
