//! Dispatch preserves Source's claim/catch boundary. The unchanged worker
//! evaluates protected conditions and creates encrypted turns; this server
//! forwards opaque envelopes into the existing queue or turn runtime.
use super::repository::{DispatchLease, Repository};
use crate::{
    auth::service::AuthService,
    chats::{self, message_queries::MessageKind, turn_runtime::engine::Hooks},
    native_commands::queued_prompt::PromptRepository,
    operations::logging::{self, LogCall},
    projects::targets::TargetRepository,
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use std::{sync::Arc, time::Duration};

pub struct Reply {
    pub status: u16,
    pub value: Value,
    completed: bool,
}
fn reply(status: u16, accepted: bool, state: &str, next: Option<i64>) -> Result<Reply> {
    let value = json!({"accepted":accepted,"status":state,"nextRunAt":next.map(|n|crate::wire::date_iso_milliseconds(n).expect("Valid automation date"))});
    Ok(Reply {
        status,
        completed: false,
        value: crate::settings::parse_response(
            "projectAutomationDispatchResultSchema",
            Some(&value),
        )?,
    })
}
fn failure(message: &'static str) -> Reply {
    Reply {
        status: 409,
        completed: false,
        value: json!({"error":message}),
    }
}
fn text(v: &Value) -> Result<String> {
    Ok(v.as_js_string()
        .context("Automation dispatch identity")?
        .lossy()
        .into_owned())
}
pub fn publish(service: &AuthService, owner: &str, project: &Value, id: &Value) {
    if let Err(error)=service.live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"project","projectId":project}),"resource":"project-automation","action":"invalidated","entityId":id,"revision":Value::Null,"payload":Value::Null})) {
        logging::server_logger()(LogCall::event("error","Could not publish application live invalidation",json!({"err":logging::error_details(&error),"resource":"project-automation"})));
    }
}
async fn finish(
    service: &AuthService,
    repository: &Repository,
    owner: &str,
    lease: &DispatchLease,
    status: &str,
    error: Option<&str>,
) -> Result<bool> {
    let error = error.map(crate::wire::JsString::from);
    let finalized = repository
        .finish_dispatch(lease, status, error.as_ref())
        .await?;
    if finalized {
        publish(
            service,
            owner,
            &lease.automation["projectId"],
            &lease.automation["id"],
        );
    }
    Ok(finalized)
}
async fn perform(
    service: &Arc<AuthService>,
    repository: &Repository,
    owner: &str,
    worker: &str,
    input: &Value,
    lease: &DispatchLease,
) -> Result<Reply> {
    let automation = &lease.automation;
    let chat = text(&automation["chatId"])?;
    let context = chats::Repository::new(service.repository.database.clone())
        .execution_context(owner, &chat)
        .await?
        .filter(|c| c["workerId"] == worker)
        .context("The automation target moved to another worker.")?;
    anyhow::ensure!(
        context["experience"] != "task",
        "Project automation prompts are unavailable for encrypted Tasks."
    );
    let key = format!(
        "automation:{}:{}",
        text(&automation["id"])?,
        text(&input["scheduledFor"])?
    );
    // Promise.all rejects as soon as a read fails, while the other database read
    // remains alive. Each existing operation owner retains that independent read.
    let message_read = {
        let (database, owner, chat, key) = (
            service.repository.database.clone(),
            owner.to_owned(),
            chat.clone(),
            key.clone(),
        );
        service.scratch_roots.owned(async move {
            chats::Repository::new(database)
                .message_by_idempotency_key(&owner, &chat, &key, MessageKind::Plain)
                .await
        })
    };
    let prompt_read = {
        let (database, owner, chat, key) = (
            service.repository.database.clone(),
            owner.to_owned(),
            chat.clone(),
            key.clone(),
        );
        service.scratch_roots.owned(async move {
            PromptRepository::new(database)
                .visible_by_key(&owner, &chat, &key)
                .await
        })
    };
    let (message, prompt) = tokio::try_join!(message_read, prompt_read)?;
    if message.is_some() || prompt.is_some() {
        let status = if prompt.is_some() {
            "queued"
        } else {
            "started"
        };
        if !finish(service, repository, owner, lease, status, None).await? {
            return Ok(failure(
                "Automation dispatch lease expired before recovery.",
            ));
        }
        return reply(202, true, status, lease.next_run_at);
    }
    let model = service
        .model_routing
        .resolve_model_id(owner, &context, None)
        .await?;
    let github = TargetRepository::new(service.repository.database.clone())
        .github_context(owner, &text(&automation["projectId"])?, Some(worker))
        .await?;
    let command = json!({"type":"automation.dispatch.protect","automationId":automation["id"],"content":automation["content"],"cwd":context["cwd"],"repository":github.as_ref().map(|v|v["nameWithOwner"].clone()).unwrap_or(Value::Null),"promptId":uuid::Uuid::new_v4().to_string(),"messageId":uuid::Uuid::new_v4().to_string(),"mode":"default","modelId":model,"reasoningEffort":lease.reasoning_effort,"customSubagentModel":context["modelConfiguration"]["customSubagentModel"],"subagentModelId":context["modelConfiguration"]["subagentModelId"],"subagentReasoningEffort":context["modelConfiguration"]["subagentReasoningEffort"],"idempotencyKey":key});
    let protected = service
        .workers
        .commands
        .request(worker, command, Some(Duration::from_secs(45)), None)
        .await?;
    let protected = crate::settings::parse_response(
        "projectAutomationProtectedDispatchResultSchema",
        protected.as_ref(),
    )?;
    if protected["allowed"] == false {
        if !finish(service, repository, owner, lease, "skipped", None).await? {
            return Ok(failure(
                "Automation dispatch lease expired before completion.",
            ));
        }
        return reply(202, true, "skipped", lease.next_run_at);
    }
    let turn = crate::settings::parse_response(
        "encryptedChatTurnCreateSchema",
        Some(&protected["protectedTurn"]),
    )?;
    let paused = context["automationPaused"] == true;
    let executing = matches!(
        context["status"].as_str(),
        Some("running" | "waiting-for-approval")
    );
    let status = if paused || executing {
        let prompt = PromptRepository::new(service.repository.database.clone())
            .create_encrypted(
                owner,
                &chat,
                &turn["queuedPrompt"],
                &json!(Vec::<Value>::new()),
            )
            .await?
            .context("The target chat is unavailable.")?;
        service.chat_mutations.publish_entity_invalidation(
            owner,
            &chat,
            "chat-queue",
            &prompt["id"],
            None,
        );
        if !paused {
            drop(service.execution.recovery.dispatch(owner, &chat));
        }
        "queued"
    } else {
        let input = json!({"text":"Encrypted automation prompt.","attachmentIds":Vec::<Value>::new(),"mode":"default","modelId":model,"reasoningEffort":lease.reasoning_effort,"customSubagentModel":turn["queuedPrompt"]["customSubagentModel"],"subagentModelId":turn["queuedPrompt"]["subagentModelId"],"subagentReasoningEffort":turn["queuedPrompt"]["subagentReasoningEffort"],"idempotencyKey":key});
        let options = json!({"encryptedChatMessages":json!({"userMessage":turn["message"],"response":json!({"id":uuid::Uuid::new_v4().to_string(),"idempotencyKey":format!("assistant:{}",text(&turn["message"]["id"])?)})})});
        service
            .execution
            .runtime
            .begin(owner, &context, &input, &options, Hooks::default())
            .await?;
        "started"
    };
    if !finish(service, repository, owner, lease, status, None).await? {
        return Ok(failure(
            "Automation dispatch lease expired before completion.",
        ));
    }
    let mut result = reply(202, true, status, lease.next_run_at)?;
    result.completed = true;
    Ok(result)
}
pub async fn run(
    service: Arc<AuthService>,
    owner: String,
    worker: String,
    id: String,
    input: Value,
    request_id: String,
) -> Result<Reply> {
    let started = chrono::Utc::now().timestamp_millis();
    let repository = Repository::new(service.repository.database.clone());
    let instance = service
        .config
        .server_instance_id
        .as_deref()
        .unwrap_or("local-single-instance");
    let lease = repository
        .claim_due(
            &owner,
            &worker,
            &id,
            &input,
            instance,
            service.config.scheduler_lease_ttl_ms as i64,
        )
        .await?;
    let Some(lease) = lease else {
        logging::server_logger()(LogCall::event(
            "debug",
            "Automation dispatch skipped without a lease",
            json!({"event":"automation.dispatch.skipped","subsystem":"automation","operation":"dispatch","status":"skipped","reasonCode":"not_due_or_already_claimed","requestId":request_id,"workerId":worker,"automationId":id,"durationMs":chrono::Utc::now().timestamp_millis()-started}),
        ));
        let current = repository.get(&owner, &id).await?;
        let next = current
            .as_ref()
            .and_then(|a| a["nextRunAt"].as_js_string())
            .and_then(crate::wire::date_milliseconds);
        return reply(200, false, "skipped", next);
    };
    publish(
        &service,
        &owner,
        &lease.automation["projectId"],
        &lease.automation["id"],
    );
    let context = json!({"event":"automation.dispatch.claimed","subsystem":"automation","operation":"dispatch","status":"claimed","requestId":request_id,"workerId":worker,"projectId":lease.automation["projectId"],"chatId":lease.automation["chatId"],"automationId":lease.automation["id"],"attempt":lease.fencing_token});
    logging::server_logger()(LogCall::event(
        "info",
        "Automation dispatch lease claimed",
        context,
    ));
    match perform(&service, &repository, &owner, &worker, &input, &lease).await {
        Ok(result) => {
            if result.completed {
                logging::server_logger()(LogCall::event(
                    "info",
                    "Automation dispatch completed",
                    json!({"event":"automation.dispatch.completed","subsystem":"automation","operation":"dispatch","status":result.value["status"],"requestId":request_id,"workerId":worker,"projectId":lease.automation["projectId"],"chatId":lease.automation["chatId"],"automationId":lease.automation["id"],"durationMs":chrono::Utc::now().timestamp_millis()-started}),
                ));
            }
            Ok(result)
        }
        Err(_) => {
            finish(
                &service,
                &repository,
                &owner,
                &lease,
                "failed",
                Some("Protected automation dispatch failed."),
            )
            .await?;
            logging::server_logger()(LogCall::event(
                "warn",
                "Automation dispatch failed",
                json!({"event":"automation.dispatch.failed","subsystem":"automation","operation":"dispatch","status":"failed","reasonCode":"protected_dispatch_failed","requestId":request_id,"workerId":worker,"projectId":lease.automation["projectId"],"chatId":lease.automation["chatId"],"automationId":lease.automation["id"],"durationMs":chrono::Utc::now().timestamp_millis()-started}),
            ));
            Ok(failure("Protected automation dispatch failed."))
        }
    }
}
