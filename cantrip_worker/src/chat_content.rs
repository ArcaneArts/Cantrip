//! Worker-owned chat and queued input envelopes. Plaintext is used only by
//! authenticated worker operations and the selected native runtime.
mod council_request;
mod council_result;
pub(crate) mod queue;

use crate::{
    attachments::content::{self as attachment, Keys, ServiceKeys},
    encryption::Service,
    history::EncryptionService,
    http::checked,
    native_items::{concat, text},
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
pub(crate) const COUNCIL_PROJECT_RESULT: &str = "council.project-result.prepare";
pub(crate) const COUNCIL_PROJECT_REQUEST: &str = "council.project-request.prepare";

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

impl Keys for Scope {
    fn attachment_identity(&self) -> Result<(JsString, JsString)> {
        self.identity()
    }

    fn attachment_material(&self) -> Result<Material> {
        let grant = ServiceKeys(self.service.0.clone()).attachment_material()?;
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
        Some(COUNCIL_PROJECT_RESULT) => council_result::prepare(&scope, command),
        Some(COUNCIL_PROJECT_REQUEST) => council_request::prepare(&scope, &service, command),
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
    turn_with_attachments(scope, command, &[])
}

pub(crate) fn turn_with_attachments(
    scope: &Scope,
    command: &Value,
    attachments: &[Value],
) -> Result<Value> {
    protect_turn(scope, command, attachments, None)
}

pub(crate) fn turn_with_communication(
    scope: &Scope,
    command: &Value,
    communication: &Value,
) -> Result<Value> {
    protect_turn(scope, command, &[], Some(communication))
}

fn prepare_council_input(
    scope: &Scope,
    command: &Value,
    source_field: &str,
    text: String,
) -> Result<Value> {
    let mut draft = command["configuration"].clone();
    for key in ["messageId", "promptId", "idempotencyKey"] {
        draft[key] = command[key].clone();
    }
    draft["mode"] = json!("default");
    draft[source_field] = command["source"].clone();
    draft["text"] = json!(text);
    protect_turn(scope, &draft, &[], None)
}

fn protect_turn(
    scope: &Scope,
    command: &Value,
    attachments: &[Value],
    communication: Option<&Value>,
) -> Result<Value> {
    let mut text = json!({"type": "text", "text": command["text"]});
    if let Some(communication) = communication {
        text["chatCommunication"] = communication.clone();
    }
    let mut internal = false;
    for field in ["councilProjectResult", "councilProjectRequest"] {
        if let Some(source) = command.get(field) {
            text[field] = source.clone();
            internal = true;
        }
    }
    let prompt_text = if communication.is_some() {
        json!(runtime_text(&text)?)
    } else {
        command["text"].clone()
    };
    let mut content = vec![text];
    content.extend(attachments.iter().map(|attachment| {
        json!({
            "type":"attachment", "attachment":attachment,
        })
    }));
    let message = scope.protect(&json!({
        "id": command["messageId"], "idempotencyKey": command["idempotencyKey"],
        "role":"user", "mode": command["mode"], "reasoningEffort": command["reasoningEffort"],
        "content": content,
    }))?;
    let grant = scope.material(None)?;
    let classification = json!({"mode": command["mode"], "attachmentIds": message["classification"]["attachmentIds"]});
    let mut protected_prompt =
        json!({"version": 1, "classification": classification, "text": prompt_text});
    if internal {
        protected_prompt["internal"] = json!(true);
    }
    let prompt = checked(
        "queuedPromptOpaqueContentSchema",
        &json!({
            "id": command["promptId"], "classification": classification,
            "protectedContent": encrypt_communication(
                Communication::QueuedPrompt,
                &grant.key,
                &json!({"ownerId": grant.owner_id, "promptId": command["promptId"], "keyRevision": grant.key_revision}),
                &protected_prompt,
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

pub(crate) fn runtime_text(item: &Value) -> Result<JsString> {
    let value = text(&item["text"])?;
    let source = &item["chatCommunication"];
    Ok(match source["direction"].as_str() {
        Some("received") => concat(&[
            "Message from Cantrip agent ".into(),
            source["sourceTitle"].stringify().into(),
            " (chat ".into(),
            text(&source["sourceChatId"])?.clone(),
            "). This is another agent, not the human user.\n\n".into(),
            value.clone(),
        ]),
        Some("sent") => concat(&[
            "Message sent by this agent to ".into(),
            source["targetTitle"].stringify().into(),
            " (chat ".into(),
            text(&source["targetChatId"])?.clone(),
            "):\n\n".into(),
            value.clone(),
        ]),
        _ => value.clone(),
    })
}
