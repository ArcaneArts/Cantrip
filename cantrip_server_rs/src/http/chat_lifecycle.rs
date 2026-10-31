//! Chat metadata, retention and opaque worker file operations.
use super::{
    body,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    chats::Repository,
    wire::{Value, value::json},
    workers::{command_bus::CommandFailure, repository::WorkerRepository},
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{MatchedPath, Path, Request, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post},
};
use std::{collections::HashMap, sync::Arc};

fn summary_changed(service: &AuthService, owner: &str, id: &str, project: &Value) {
    let scope = if crate::wire::coercion::truthy(Some(project)) {
        json!({"kind":"project","projectId":project})
    } else {
        json!({"kind":"current-user"})
    };
    let _=service.live.publish_event(json!({"ownerId":owner,"scope":scope,"resource":"chat","action":"invalidated","entityId":id,"revision":Value::Null,"payload":Value::Null}));
}
fn diagnostic(event: &str, id: &str) {
    eprintln!(
        "{}",
        json!({"level":"warn","event":event,"chatId":id,"subsystem":"standalone-chat-scratch"})
            .stringify()
    );
}
async fn revoke_share(service: &AuthService, owner: &str, id: &str) {
    if service
        .project_shares
        .revoke_managed_resource(owner, &format!("chat:{id}"))
        .await
        .is_err()
    {
        diagnostic("standalone-chat.scratch.share-revocation-failed", id);
    }
}
async fn archive_command(service: &AuthService, worker: &str, command: Value, id: &str) {
    if !service.workers.bridge.is_connected(worker) {
        return;
    }
    let result = async {
        let result = service
            .workers
            .commands
            .request(worker, command, None, None)
            .await?;
        crate::settings::parse_response("standaloneChatScratchArchiveResultSchema", result.as_ref())
    }
    .await;
    if result.is_err() {
        diagnostic("standalone-chat.scratch.archive-restore-failed", id);
    }
}
async fn worker_operation(
    service: &AuthService,
    owner: &str,
    id: &str,
    input: &Value,
    files: bool,
) -> Result<Response> {
    let Some(context) = Repository::new(service.repository.database.clone())
        .execution_context(owner, id)
        .await?
    else {
        return Ok(error(404, "Chat not found."));
    };
    let worker = context["workerId"].as_str().context("Chat worker")?;
    let command = if files {
        if context["contextKind"] != "standalone"
            || !crate::wire::coercion::truthy(context.get("scratchRootId"))
        {
            return Ok(error(
                409,
                "Chat files are available only for standalone Chats.",
            ));
        }
        if let Some(binding) = input.get("binding")
            && (binding["workerId"] != context["workerId"]
                || binding["scratchRootId"] != context["scratchRootId"])
        {
            return Ok(error(
                409,
                "This Chat moved to another scratch workspace. Reopen the file there; your draft has not been saved.",
            ));
        }
        let intent = input["intent"].as_str().context("File intent")?;
        let registered = WorkerRepository::new(service.repository.database.clone())
            .get_worker(owner, worker)
            .await?;
        if registered
            .as_ref()
            .is_none_or(|w| w["standaloneChat"]["files"][intent] != true)
        {
            return Ok(error(
                409,
                format!("The Chat worker does not support {intent} file operations."),
            ));
        }
        if !service.workers.bridge.is_connected(worker) {
            return Ok(error(503, "Chat worker is offline."));
        }
        json!({"type":"chat.scratch.files.operation","rootId":context["scratchRootId"],"chatId":context["chatId"],"serverId":service.server_id,"root":context["cwd"],"intent":input["intent"],"operationId":input["operationId"],"sequence":input["sequence"],"protectedRequest":input["protectedRequest"]})
    } else {
        let mut command = json!({"type":"chat.files.references","chatId":context["chatId"],"serverId":service.server_id,"root":context["cwd"]});
        for (key, value) in input.as_object().context("File reference request")? {
            command[key.as_str().context("File reference field")?] = value.clone();
        }
        command
    };
    let result=async{
        let result=service.workers.commands.request(worker,command,None,None).await?;
        let result=crate::settings::parse_response("surfaceStreamWireResponseSchema",result.as_ref())?;
        if files && (input["intent"]=="write" || input["intent"]=="remove"){
            let _=service.live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"chat","chatId":id}),"resource":"chat-files","action":"invalidated","entityId":Value::Null,"revision":Value::Null,"payload":Value::Null}));
        }
        output(200,"surfaceStreamWireResponseSchema",&result)
    }.await;
    Ok(match result {
        Ok(response) => response,
        Err(cause) => error(
            cause
                .downcast_ref::<CommandFailure>()
                .map_or(502, |f| f.status(502)),
            crate::settings::operation_error_message(&cause),
        ),
    })
}
async fn mutate(
    service: Arc<AuthService>,
    owner: String,
    id: String,
    route: String,
    method: Method,
    input: Option<Value>,
) -> Result<Response> {
    let repository = Repository::new(service.repository.database.clone());
    match route.as_str() {
        "/api/chats/{chatId}/archive" => {
            let result = repository.archive_agent(&owner, &id).await?;
            if result == "running" {
                return Ok(error(409, "Stop the running chat first."));
            }
            Ok(if result == false {
                error(404, "Agent conversation not found.")
            } else {
                StatusCode::NO_CONTENT.into_response()
            })
        }
        "/api/chats/{chatId}" if method == Method::DELETE => {
            if repository
                .execution_context(&owner, &id)
                .await?
                .is_some_and(|v| v["contextKind"] == "standalone")
            {
                let archived = repository.archive_standalone(&owner, &id).await?;
                if archived == "running" {
                    return Ok(error(409, "Stop the running Chat first."));
                }
                if archived == false {
                    return Ok(error(404, "Chat not found."));
                }
                archive_command(&service,archived["workerId"].as_str().context("Archive worker")?,json!({"type":"chat.scratch.archive","rootId":archived["rootId"],"chatId":id,"archivedAt":archived["archivedAt"],"archiveExpiresAt":archived["archiveExpiresAt"]}),&id).await;
                revoke_share(&service, &owner, &id).await;
                summary_changed(&service, &owner, &id, &Value::Null);
                return Ok(StatusCode::NO_CONTENT.into_response());
            }
            let result = repository.delete_chat(&owner, &id).await?;
            Ok(if result == "running" {
                error(409, "Stop the running chat first.")
            } else if result == false {
                error(404, "Chat not found.")
            } else {
                StatusCode::NO_CONTENT.into_response()
            })
        }
        "/api/chats/{chatId}/restore" => {
            let default = Value::Object(Default::default());
            let body = input.as_ref().filter(|v| !v.is_null()).unwrap_or(&default);
            let input = match parse("conversationRestoreSchema", Some(body))? {
                Ok(v) => v,
                Err(r) => return Ok(r),
            };
            if let Some(restored) = repository.restore_standalone(&owner, &id).await? {
                archive_command(
                    &service,
                    restored["workerId"].as_str().context("Restore worker")?,
                    json!({"type":"chat.scratch.restore","rootId":restored["rootId"],"chatId":id}),
                    &id,
                )
                .await;
                summary_changed(&service, &owner, &id, &Value::Null);
                return output(200, "standaloneChatWireSummarySchema", &restored["chat"]);
            }
            match repository.restore_archived(&owner, &id, &input).await? {
                Some(chat) => output(200, "chatWireSummarySchema", &chat),
                None => Ok(error(404, "Archived chat not found.")),
            }
        }
        "/api/chats/{chatId}/permanent" => {
            if let Some(root) = repository.standalone_deletion_root(&owner, &id).await? {
                revoke_share(&service, &owner, &id).await;
                let field = |key| {
                    root[key]
                        .as_str()
                        .context("Deletion root identity")
                        .map(str::to_owned)
                };
                crate::chats::roots::Repository::new(service.repository.database.clone())
                    .tombstone_and_purge(
                        &crate::chats::roots::Identity {
                            id: uuid::Uuid::new_v4().to_string(),
                            owner_id: field("ownerId")?,
                            root_id: field("rootId")?,
                            chat_id: field("chatId")?,
                            worker_id: field("workerId")?,
                        },
                        None,
                    )
                    .await?;
                summary_changed(&service, &owner, &id, &Value::Null);
                service.scratch_roots.queue();
                return Ok(StatusCode::NO_CONTENT.into_response());
            }
            Ok(
                if repository.permanently_delete_archived(&owner, &id).await? {
                    StatusCode::NO_CONTENT.into_response()
                } else {
                    error(404, "Archived chat not found.")
                },
            )
        }
        "/api/chats/{chatId}" => {
            let input = match parse("encryptedChatUpdateSchema", input.as_ref())? {
                Ok(v) => v,
                Err(r) => return Ok(r),
            };
            match repository.update_label(&owner, &id, &input).await? {
                Some(v) => output(200, "contextualChatWireSummarySchema", &v),
                None => Ok(error(404, "Chat not found.")),
            }
        }
        "/api/chats/{chatId}/completion/read" => {
            match repository.acknowledge_completion(&owner, &id).await? {
                Some(v) => {
                    summary_changed(&service, &owner, &id, &v["projectId"]);
                    output(200, "contextualChatWireSummarySchema", &v)
                }
                None => Ok(error(404, "Chat not found.")),
            }
        }
        "/api/chats/{chatId}/composer-draft" => {
            let input = match parse("encryptedChatComposerDraftUpdateSchema", input.as_ref())? {
                Ok(v) => v,
                Err(r) => return Ok(r),
            };
            match repository
                .update_composer_draft(&owner, &id, &input["state"])
                .await?
            {
                Some(v) => output(200, "encryptedChatComposerDraftWireStateSchema", &v),
                None => Ok(error(404, "Chat not found.")),
            }
        }
        _ => {
            let files = route.ends_with("/files/operation");
            let input = match parse(
                if files {
                    "standaloneChatFileWireRequestSchema"
                } else {
                    "surfaceStreamWireRequestSchema"
                },
                input.as_ref(),
            )? {
                Ok(v) => v,
                Err(r) => return Ok(r),
            };
            worker_operation(&service, &owner, &id, &input, files).await
        }
    }
}
async fn execute(
    service: Arc<AuthService>,
    owner: String,
    id: String,
    route: &str,
    request: Request,
) -> Result<Response> {
    let method = request.method().clone();
    let repository = Repository::new(service.repository.database.clone());
    if matches!(method, Method::GET | Method::HEAD) {
        return if route.ends_with("/composer-draft") {
            match repository.composer_draft(&owner, &id).await? {
                Some(v) => output(200, "encryptedChatComposerDraftWireStateSchema", &v),
                None => Ok(error(404, "Chat not found.")),
            }
        } else {
            match repository.execution_context(&owner, &id).await? {
                Some(v) => output(
                    200,
                    "chatRuntimeSelectionSchema",
                    &json!({"modelRouteId":v["modelRouteId"],"providerAccountId":v["providerAccountId"]}),
                ),
                None => Ok(error(404, "Chat not found.")),
            }
        };
    }
    let limit = if route.ends_with("/composer-draft") {
        ((2_u64 * 1024 * 1024 + 16) * 4).div_ceil(3) + 1024
    } else if route.ends_with("/file-references") || route.ends_with("/files/operation") {
        4 * 1024 * 1024
    } else {
        service.config.api_body_limit_bytes
    };
    let body = match body::parse_js(request, limit).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    service
        .scratch_roots
        .owned(mutate(
            service.clone(),
            owner,
            id,
            route.to_owned(),
            method,
            body,
        ))
        .await
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    route: MatchedPath,
    request: Request,
) -> Response {
    let mutation = !matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    ) && !route.as_str().ends_with("/composer-draft");
    let placement = [
        "/api/chats/{chatId}",
        "/api/chats/{chatId}/archive",
        "/api/chats/{chatId}/restore",
    ]
    .contains(&route.as_str());
    let owner = ctx
        .principal
        .user
        .as_ref()
        .expect("Authenticated Chat owner")
        .id
        .clone();
    match execute(
        service.clone(),
        owner.clone(),
        params["chatId"].clone(),
        route.as_str(),
        request,
    )
    .await
    {
        Ok(response) if mutation && response.status().as_u16() < 400 => {
            let live = service.live.clone();
            let id = params["chatId"].clone();
            super::on_response::completed(response, move || {
                let resources: &[&str] = if placement {
                    &["chat", "project-tab-layout"]
                } else {
                    &["chat"]
                };
                for resource in resources {
                    let _=live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"current-user"}),"resource":resource,"action":"invalidated","entityId":id,"revision":Value::Null,"payload":Value::Null}));
                }
            })
        }
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &ctx.id, &cause),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/chats/{chatId}", patch(handle).delete(handle))
        .route("/api/chats/{chatId}/archive", post(handle))
        .route("/api/chats/{chatId}/restore", post(handle))
        .route("/api/chats/{chatId}/permanent", delete(handle))
        .route("/api/chats/{chatId}/runtime-selection", get(handle))
        .route("/api/chats/{chatId}/completion/read", post(handle))
        .route(
            "/api/chats/{chatId}/composer-draft",
            get(handle).put(handle),
        )
        .route("/api/chats/{chatId}/file-references", post(handle))
        .route("/api/chats/{chatId}/files/operation", post(handle))
}
