//! Worker-owned chat and queued input envelopes. Plaintext is used only by
//! authenticated worker operations and the selected native runtime.
pub(crate) mod queue;

use crate::{
    attachments::content::{self as attachment, ServiceKeys},
    encryption::Service,
    history::EncryptionService,
    http::checked,
};
use anyhow::{Result, bail};
use cantrip_crypto::content::{Communication, encrypt_communication};
use cantrip_history::{
    canonical::{open_message, protect_message},
    content::{Encryption, Material},
};
use cantrip_wire::{JsString, Value, value::json};
use std::{collections::HashMap, sync::Arc};

pub(crate) const MESSAGE: &str = "chat.message.protect";
pub(crate) const MESSAGES: &str = "chat.messages.protect";
pub(crate) const REPROTECT: &str = "chat.messages.reprotect";
pub(crate) const TURN: &str = "chat.turn.protect";
pub(crate) const QUEUE_PREPARE: &str = "chat.queue.prepare";

/// Re-read live grants when publishing and fence every acquired key to the
/// account and logical server that accepted the operation.
pub(crate) struct Scope {
    pub(crate) owner: JsString,
    pub(crate) server: JsString,
    service: EncryptionService,
}

impl Scope {
    pub(crate) fn new(service: Arc<Service>) -> Result<Self> {
        let service = EncryptionService(service);
        let (owner, server) = service.identity()?;
        Ok(Self {
            owner,
            server,
            service,
        })
    }

    pub(crate) fn protect(&self, message: &Value) -> Result<Value> {
        protect_message(self, &message["id"], message)
    }
}

impl Encryption for Scope {
    fn identity(&self) -> Result<(JsString, JsString)> {
        let identity = self.service.identity()?;
        if identity.0 != self.owner || identity.1 != self.server {
            bail!("The worker binding changed during protected chat processing.");
        }
        Ok(identity)
    }

    fn material(&self, revision: Option<u64>) -> Result<Material> {
        let grant = self.service.material(revision)?;
        if grant.owner_id != self.owner || grant.server_id != self.server {
            bail!("The worker binding changed during protected chat processing.");
        }
        Ok(grant)
    }
}

pub(crate) fn execute(service: Arc<Service>, command: &Value) -> Result<Value> {
    let scope = Scope::new(service.clone())?;
    let result = match command["type"].as_str() {
        Some(TURN) => turn(&scope, command),
        Some(QUEUE_PREPARE) => queue::prepare(&scope, command),
        Some(MESSAGE | MESSAGES) => {
            let keys = ServiceKeys(service);
            let mut opened = HashMap::new();
            for opaque in command["attachments"].as_array().unwrap() {
                let summary = attachment::open(&keys, opaque)?;
                opened.insert(summary["id"].as_js_string().unwrap().clone(), summary);
            }
            // Attachment payloads use a different grant. Check that its reads
            // still belong to this operation's authenticated account.
            scope.identity()?;
            let seal = |mut message: Value| {
                let Value::Array(parts) = &mut message["content"] else {
                    bail!("Invalid chat message content.");
                };
                for item in parts {
                    if item["type"] == "attachment" {
                        let Some(summary) = item["attachment"]["id"]
                            .as_js_string()
                            .and_then(|id| opened.get(id))
                        else {
                            bail!("Protected attachment metadata is unavailable.");
                        };
                        item["attachment"] = checked("chatAttachmentSummarySchema", summary)?;
                    }
                }
                scope.protect(&message)
            };
            if command["type"] == MESSAGE {
                seal(command["message"].clone())
            } else {
                let messages = command["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .cloned()
                    .map(seal)
                    .collect::<Result<Vec<_>>>()?;
                checked(
                    "chatMessageOpaqueContentListSchema",
                    &Value::Array(messages),
                )
            }
        }
        Some(REPROTECT) => {
            let grant = scope.material(None)?;
            let mut messages = Vec::new();
            for request in command["messages"].as_array().unwrap() {
                let source = &request["source"];
                let content = open_message(&grant.key, &json!(grant.owner_id), source)?;
                let classification = json!({
                    "role": source["role"], "mode": source["mode"], "attachmentIds": source["attachmentIds"],
                });
                let sealed = encrypt_communication(
                    Communication::Message,
                    &grant.key,
                    &json!({"ownerId": grant.owner_id, "messageId": request["id"], "keyRevision": grant.key_revision}),
                    &json!({"version": 1, "classification": classification, "content": content}),
                )?;
                messages.push(json!({
                    "id": request["id"], "idempotencyKey": request["idempotencyKey"],
                    "classification": classification, "reasoningEffort": source["reasoningEffort"],
                    "protectedContent": sealed,
                }));
            }
            checked(
                "chatMessageOpaqueContentListSchema",
                &Value::Array(messages),
            )
        }
        _ => bail!("Unsupported chat protection command."),
    }?;
    scope.identity()?;
    Ok(result)
}

fn turn(scope: &Scope, command: &Value) -> Result<Value> {
    let message = scope.protect(&json!({
        "id": command["messageId"], "idempotencyKey": command["idempotencyKey"],
        "role":"user", "mode": command["mode"], "reasoningEffort": command["reasoningEffort"],
        "content": vec![json!({"type": "text", "text": command["text"]})],
    }))?;
    let grant = scope.material(None)?;
    let classification = json!({"mode": command["mode"], "attachmentIds": Vec::<Value>::new()});
    let prompt = checked(
        "queuedPromptOpaqueContentSchema",
        &json!({
            "id": command["promptId"], "classification": classification,
            "protectedContent": encrypt_communication(
                Communication::QueuedPrompt,
                &grant.key,
                &json!({"ownerId": grant.owner_id, "promptId": command["promptId"], "keyRevision": grant.key_revision}),
                &json!({"version": 1, "classification": classification, "text": command["text"]}),
            )?,
            "modelId": command["modelId"], "reasoningEffort": command["reasoningEffort"],
            "customSubagentModel": command["customSubagentModel"].as_bool().unwrap_or(false),
            "subagentModelId": command["subagentModelId"], "subagentReasoningEffort": command["subagentReasoningEffort"],
            "worktreeId": Value::Null, "frozen": false,
            "idempotencyKey": command["idempotencyKey"], "pendingMessage": message,
        }),
    )?;
    checked(
        "encryptedChatTurnCreateSchema",
        &json!({
            "message": message, "queuedPrompt": prompt, "modelId": command["modelId"],
        }),
    )
}
