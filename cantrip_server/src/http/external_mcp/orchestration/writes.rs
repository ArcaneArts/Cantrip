use super::{Authority, OperationError, receipts, task_status};
use crate::{
    auth::service::AuthService,
    chats,
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use cantrip_protocol::external_mcp::orchestration::{CoreOperation, Tool, resource_id};
use std::sync::Arc;
use uuid::Uuid;

pub(super) async fn execute(
    service: &Arc<AuthService>,
    authority: &Authority,
    request: CoreOperation,
) -> Result<Value> {
    let operation = match &request {
        CoreOperation::Prepare { operation_id } | CoreOperation::Commit { operation_id, .. } => {
            *operation_id
        }
        _ => return Err(OperationError::validation().into()),
    };
    let operation_id = operation.to_string();
    let key = receipts::Key {
        owner: &authority.owner,
        principal: &authority.principal,
        operation: &operation_id,
    };
    let receipts = receipts::Repository(service.repository.database.clone());
    match request {
        CoreOperation::Prepare { .. } => {
            let revision = receipts.revision(&key).await?;
            let mut response = json!({
                "ownerId":authority.owner, "principalId":authority.principal, "label":authority.label,
                "keyRevision":revision,
            });
            if authority.tool == Tool::ChatSend {
                let chat = authority.chat.as_deref().context("Agent identity")?;
                let context = chat_context(service, authority, chat).await?;
                response["configuration"] = context["modelConfiguration"].clone();
            }
            Ok(response)
        }
        CoreOperation::Commit {
            key_revision,
            fingerprint,
            protected_request,
            ..
        } => {
            if key_revision <= 0
                || fingerprint.len() != 43
                || !fingerprint
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            {
                return Err(OperationError::validation().into());
            }
            let input = validate(
                authority,
                operation,
                &Value::from_serialize(&protected_request),
            )?;
            let tool = Value::from_serialize(&authority.tool);
            let input = match receipts
                .reserve(
                    &key,
                    &authority.project,
                    tool.as_str().expect("String tool name"),
                    key_revision,
                    &fingerprint,
                    &input,
                )
                .await?
            {
                receipts::Admission::Complete(receipt) => return Ok(receipt),
                receipts::Admission::Pending(input) => validate(authority, operation, &input)
                    .map_err(|_| {
                        OperationError::new(
                            409,
                            "placement-changed",
                            "The original operation's placement changed before admission.",
                        )
                    })?,
            };
            // Native mutations recognize the same identity after a lost response
            // or a process restart. The first completed receipt is authoritative.
            let receipt = apply(service, authority, operation, &input).await?;
            receipts.complete(&key, &receipt).await
        }
        _ => unreachable!("Validated mutation phase"),
    }
}

fn validate(authority: &Authority, operation: Uuid, input: &Value) -> Result<Value> {
    let invalid = OperationError::validation;
    let parse = |schema, value| crate::wire::parse(schema, Some(value)).map_err(|_| invalid());
    let id =
        |kind| resource_id(&authority.owner, &authority.principal, operation, kind).to_string();
    match authority.tool {
        Tool::AgentCreate => {
            let input = parse("encryptedChatCreateSchema", input)?;
            if input["id"] != id("agent")
                || input["attachToTabLayout"] != false
                || input["worktreeId"] != authority.worktree
                || input.get("target").is_some()
                || input.get("cantripOsBindingId").is_some()
                || input.get("githubAgentContext").is_some()
            {
                return Err(invalid().into());
            }
            Ok(input)
        }
        Tool::TaskCreate => {
            let start = input["start"].as_bool().ok_or_else(invalid)?;
            let create = parse("encryptedTaskCreateSchema", &input["create"])?;
            if create["chatId"] != id("task")
                || create["worktreeId"] != authority.worktree
                || create["planGoalEnabled"] != false
                || create.get("target").is_some()
                || create.get("modelConfiguration").is_some()
            {
                return Err(invalid().into());
            }
            Ok(json!({"start":start,"create":create}))
        }
        Tool::ChatSend => {
            let input = parse("encryptedChatTurnCreateSchema", input)?;
            let message = &input["message"];
            let prompt = &input["queuedPrompt"];
            let key = format!("external-mcp:{}:{operation}", authority.principal);
            if message["id"] != id("message")
                || prompt["id"] != id("prompt")
                || message["idempotencyKey"] != key
                || prompt["idempotencyKey"] != key
                || prompt["pendingMessage"] != *message
                || message["classification"]["role"] != "user"
                || message["classification"]["mode"] != "default"
                || !message["classification"]["attachmentIds"]
                    .as_array()
                    .is_some_and(Vec::is_empty)
                || prompt.get("protectedNativeInput").is_some()
                || !prompt["worktreeId"].is_null()
            {
                return Err(invalid().into());
            }
            Ok(input)
        }
        Tool::TaskStart if input.as_object().is_some_and(|input| input.is_empty()) => {
            Ok(input.clone())
        }
        _ => Err(invalid().into()),
    }
}

async fn chat_context(service: &AuthService, authority: &Authority, chat: &str) -> Result<Value> {
    chats::Repository::new(service.repository.database.clone())
        .execution_context(&authority.owner, chat)
        .await?
        .filter(|context| {
            context["projectId"] == authority.project
                && context["workerId"] == authority.worker
                && context["worktreeId"] == authority.worktree
                && context["experience"] == "agent"
        })
        .ok_or_else(|| {
            OperationError::new(
                409,
                "placement-changed",
                "The chat moved. Open a new MCP request.",
            )
            .into()
        })
}

async fn apply(
    service: &Arc<AuthService>,
    authority: &Authority,
    operation: Uuid,
    input: &Value,
) -> Result<Value> {
    let owner = &authority.owner;
    let connected = |worker: &str| service.workers.bridge.is_connected(worker);
    let conversations = chats::Repository::new(service.repository.database.clone());
    let tasks = crate::tasks::Repository::new(service.repository.database.clone());
    let missing = || {
        OperationError::new(
            404,
            "not-found",
            "The requested Cantrip resource is unavailable.",
        )
    };
    let response = match authority.tool {
        Tool::AgentCreate => {
            let id = input["id"].as_str().context("Agent identity")?;
            conversations
                .create_project_chat(owner, &authority.project, input, Some(&connected))
                .await?
                .ok_or_else(missing)?;
            service.managed_preparation.request(owner, id).await?;
            service
                .chat_mutations
                .publish_summary(owner, &json!(id), &json!(authority.project));
            json!({"summary":"Created a project Agent chat.","chatId":id,"state":"created","workerId":authority.worker,"worktreeId":authority.worktree})
        }
        Tool::ChatSend => {
            let id = authority.chat.as_deref().context("Agent identity")?;
            let context = chat_context(service, authority, id).await?;
            let response =
                crate::http::chat_execution::submit_external(service.clone(), owner, id, input)
                    .await?;
            let status = response.status();
            let body = axum::body::to_bytes(response.into_body(), 128 * 1024).await?;
            let payload: serde_json::Value = serde_json::from_slice(&body)?;
            let delivery = if !status.is_success() {
                let reason = payload
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("Chat admission failed.");
                return Err(
                    OperationError::new(status.as_u16(), "chat-admission-failed", reason).into(),
                );
            } else if payload["status"] == "queued" {
                if context["automationPaused"] == true {
                    "paused"
                } else if context["status"] == "waiting-for-approval" {
                    "blocked"
                } else {
                    "queued"
                }
            } else {
                "running"
            };
            json!({
                "summary":"Submitted work through the Cantrip chat queue.","chatId":id,
                "messageId":input["message"]["id"],"promptId":input["queuedPrompt"]["id"],
                "delivery":delivery,"actor":json!({"kind":"external-integration","id":authority.principal,"label":authority.label}),
            })
        }
        Tool::TaskCreate | Tool::TaskStart => {
            let create = authority.tool == Tool::TaskCreate;
            let id = if create {
                input["create"]["chatId"].as_str()
            } else {
                authority.chat.as_deref()
            }
            .context("Task identity")?;
            if create && tasks.get(owner, id).await?.is_none() {
                let created = conversations
                    .create_task(
                        owner,
                        &authority.project,
                        &input["create"],
                        Some(&connected),
                    )
                    .await;
                match created {
                    Ok(Some(created)) => {
                        crate::http::task_controls::announce_created(service, owner, &created)?
                    }
                    Ok(None) => return Err(missing().into()),
                    Err(cause) if tasks.get(owner, id).await?.is_none() => return Err(cause),
                    Err(_) => {}
                }
            }
            let task = tasks.get(owner, id).await?.ok_or_else(missing)?;
            if !conversations
                .live_routing(owner, id)
                .await?
                .is_some_and(|chat| {
                    chat["projectId"] == authority.project && chat["experience"] == "task"
                })
            {
                return Err(missing().into());
            }
            let start = !create || input["start"] == true;
            if start && task["dispatch"]["operationId"] != operation.to_string() {
                service
                    .execution
                    .queue
                    .queue(
                        owner,
                        id,
                        &json!({"operationId":operation,"rowVersion":task["rowVersion"]}),
                        "direct",
                        false,
                    )
                    .await?
                    .ok_or_else(missing)?;
            }
            let task = tasks.get(owner, id).await?.ok_or_else(missing)?;
            json!({"summary":if start {"Task submitted to the Cantrip scheduler."} else {"Created a Task draft."},
                "taskId":id,"task":task_status(&task)})
        }
        _ => unreachable!("Validated mutation tool"),
    };
    let mut response = response;
    response["projectId"] = json!(authority.project);
    response["operationId"] = json!(operation);
    Ok(response)
}
