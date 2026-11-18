//! Protected host conversation input and the wire forms for observed output.
use super::{Emit, protected_mode};
use crate::{
    chat_content::Scope,
    encryption::Service,
    http::checked,
    native_items::{array, concat, join, text},
};
use anyhow::{Context, Result, anyhow, bail};
use cantrip_crypto::content::{Communication, decrypt_communication, encrypt_communication};
use cantrip_history::{canonical::open_message, content::Encryption};
use cantrip_wire::{JsString, Value, value::json};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

pub(super) struct Protected {
    scope: Scope,
    chat: Value,
    response: Value,
    plan: Mutex<Value>,
}

impl Protected {
    pub(super) fn open(
        service: Arc<Service>,
        command: &Value,
        owner: &JsString,
        server: &JsString,
    ) -> Result<(JsString, Self)> {
        let scope = Scope::new(service)?;
        if &scope.owner != owner || &scope.server != server {
            bail!("The worker binding changed before protected chat preparation.");
        }
        let grant = scope.material(None)?;
        let prompt = &command["protectedPrompt"];
        if prompt["id"] != command["clientMessageId"] || prompt["classification"]["role"] != "user"
        {
            bail!("Protected chat input does not match the admitted user message.");
        }
        if !array(&prompt["classification"]["attachmentIds"])?.is_empty() {
            bail!("This native text turn cannot open attachment input.");
        }
        let owner = json!(grant.owner_id);
        let content = open_message(&grant.key, &owner, prompt)
            .map_err(|_| anyhow!("Unable to authenticate protected chat input."))?;
        let prompt_text = join(
            array(&content)?
                .iter()
                .filter(|item| item["type"] == "text")
                .map(runtime_text)
                .collect::<Result<Vec<_>>>()?,
            "\n\n",
        )
        .trim();
        let prompt_text = if prompt_text.is_empty() {
            "Review the attached files and respond to the user.".into()
        } else {
            prompt_text
        };
        let chat = &command["chatId"];
        let input = if command["threadId"].is_null() {
            let mut history = Vec::new();
            for message in array(&command["protectedHistory"])? {
                if message["chatId"] != *chat || message["contextKind"] != command["contextKind"] {
                    bail!("Protected chat history belongs to another conversation.");
                }
                if message["id"] == prompt["id"] {
                    continue;
                }
                let parts = open_message(&grant.key, &owner, message)
                    .map_err(|_| anyhow!("Unable to authenticate protected chat history."))?;
                history.push((message["role"].clone(), parts));
            }
            continuation(&history, prompt_text)?
        } else {
            prompt_text
        };
        let plan = &command["protectedPlan"];
        let plan = if plan.is_null() {
            json!({"explanation": Value::Null, "steps": Vec::<Value>::new(), "question": Value::Null})
        } else {
            decrypt_communication(
                Communication::Plan,
                &grant.key,
                &json!({"ownerId": owner, "chatId": chat, "keyRevision": plan["protectedContent"]["keyRevision"]}),
                &plan["protectedContent"],
                plan.get("classification"),
            ).map_err(|_| anyhow!("Unable to authenticate protected chat plan state."))?
        };
        scope.identity()?;
        Ok((
            input,
            Self {
                scope,
                chat: chat.clone(),
                response: command["resultMode"].clone(),
                plan: Mutex::new(plan),
            },
        ))
    }

    pub(super) fn attach(self: &Arc<Self>, downstream: Emit) -> Emit {
        let protection = self.clone();
        Arc::new(move |event| {
            let protected = protection
                .event(&event)
                .map_err(|_| anyhow!("The worker could not protect a chat event."))?;
            downstream(protected)
        })
    }

    fn event(&self, event: &Value) -> Result<Value> {
        match event["type"].as_str() {
            Some("agent.message") => {
                let message = &event["message"];
                let turn = &message["correlation"]["turnId"];
                let key = concat(&[
                    "agent-message:root:".into(),
                    turn.as_js_string()
                        .cloned()
                        .unwrap_or_else(|| "turn".into()),
                    ":".into(),
                    text(&message["id"])?.clone(),
                ]);
                let id = event_id(text(&self.chat)?, &key);
                let idempotency = if key.len() <= 200 {
                    key
                } else {
                    let digest = Sha256::digest(key.lossy().as_bytes());
                    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
                    format!("agent-output:sha256:{hex}").into()
                };
                let mut content =
                    json!({"type": "text", "text": message["text"], "phase": message["phase"]});
                let mut telemetry =
                    json!({"kind": "message", "phase": message["phase"], "turnId": turn});
                if message["streaming"] == true {
                    content["streaming"] = json!(true);
                    telemetry["streaming"] = json!(true);
                }
                if !message["correlation"].is_null() {
                    content["correlation"] = message["correlation"].clone();
                }
                let protected = self.scope.protect(&json!({
                    "id": id, "role": "assistant", "content": vec![content], "idempotencyKey": idempotency,
                }))?;
                Ok(
                    json!({"type": "agent.protected-message", "message": protected, "telemetry": telemetry}),
                )
            }
            Some("agent.plan.updated") => {
                let mut plan = self.plan.lock().unwrap();
                let grant = self.scope.material(None)?;
                let classification = json!({"hasQuestion": !plan["question"].is_null()});
                let content = json!({
                    "version": 1, "classification": classification,
                    "explanation": event["explanation"], "steps": event["steps"], "question": plan["question"],
                });
                let sealed = encrypt_communication(
                    Communication::Plan,
                    &grant.key,
                    &json!({"ownerId": grant.owner_id, "chatId": self.chat, "keyRevision": grant.key_revision}),
                    &content,
                )?;
                *plan = content;
                Ok(json!({
                    "type": "agent.plan.protected", "turnId": event["turnId"],
                    "state": json!({"classification": classification, "protectedContent": sealed}),
                }))
            }
            _ => bail!("The protected turn cannot publish this event."),
        }
    }

    pub(super) fn result(&self, mut result: Value) -> Result<Value> {
        let answer = text(&result["text"])?;
        let message = self.scope.protect(&json!({
            "id": self.response["messageId"], "role": "assistant",
            "idempotencyKey": self.response["idempotencyKey"],
            "content": vec![json!({
                "type": "text", "phase": "final_answer",
                "text": if answer.is_empty() { "The agent completed without a message.".into() } else { answer.clone() },
            })],
        })).map_err(|_| anyhow!("The worker could not protect the chat response."))?;
        result["text"] = json!("");
        result["structuredResult"] =
            checked("chatMessageRelayResultSchema", &json!({"message": message}))?;
        checked("agentTurnResultSchema", &result)
    }
}

fn event_id(chat: &JsString, key: &JsString) -> String {
    let mut hash = Sha256::new();
    hash.update(b"cantrip:protected-agent-event\0");
    hash.update(chat.lossy().as_bytes());
    hash.update(b"\0");
    hash.update(key.lossy().as_bytes());
    let mut bytes: [u8; 16] = hash.finalize()[..16].try_into().unwrap();
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).to_string()
}

fn runtime_text(item: &Value) -> Result<JsString> {
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

fn continuation(history: &[(Value, Value)], prompt: JsString) -> Result<JsString> {
    if history.is_empty() {
        return Ok(prompt);
    }
    let mut lines = Vec::new();
    for (role, content) in history.iter().skip(history.len().saturating_sub(100)) {
        let items = array(content)?;
        let scope = |item: &Value| {
            if item["type"] == "activity" {
                item["activity"]["agentScope"].clone()
            } else {
                item["agentScope"].clone()
            }
        };
        let scopes = items
            .iter()
            .map(scope)
            .filter(Value::is_object)
            .collect::<Vec<_>>();
        if !scopes.is_empty() && scopes.iter().all(|scope| scope["isRoot"] != true) {
            continue;
        }
        let mut parts = Vec::new();
        for item in items {
            let scope = scope(item);
            if scope.is_object() && scope["isRoot"] != true {
                continue;
            }
            parts.push(match item["type"].as_str() {
                Some("text") => runtime_text(item)?,
                Some("attachment") => concat(&[
                    "[attachment: ".into(),
                    text(&item["attachment"]["fileName"])?.clone(),
                    " (".into(),
                    text(&item["attachment"]["mimeType"])?.clone(),
                    ")]".into(),
                ]),
                Some("activity") => summarize(&item["activity"])?,
                _ => continue,
            });
        }
        if !parts.is_empty() {
            lines.push(concat(&[
                role.as_str()
                    .context("Invalid protected chat role")?
                    .to_uppercase()
                    .into(),
                ": ".into(),
                join(parts, "\n"),
            ]));
        }
    }
    Ok(concat(&[
        "Continue this existing Cantrip conversation. The encrypted endpoint history follows:\n\n"
            .into(),
        join(lines, "\n\n"),
        "\n\nUSER: ".into(),
        prompt,
    ]))
}

fn summarize(activity: &Value) -> Result<JsString> {
    Ok(match activity["type"].as_str() {
        Some("instructionContext") => concat(&[
            "[effective instructions: ".into(),
            text(&activity["provenance"])?.clone(),
            "]".into(),
        ]),
        Some("usage") => format!(
            "[usage: {} tokens]",
            activity["last"]["totalTokens"].stringify()
        )
        .into(),
        Some("rateLimit") => {
            let percent = activity["primary"]
                .get("usedPercent")
                .map(Value::stringify)
                .unwrap_or_else(|| "unknown".into());
            format!("[rate limit: {percent}% used]").into()
        }
        _ => {
            let mut reduced = activity.clone();
            if let Value::Object(fields) = &mut reduced {
                fields.shift_remove("agentScope");
                fields.shift_remove("raw");
            }
            concat(&[
                "[".into(),
                text(&activity["type"])?.clone(),
                ": ".into(),
                reduced.stringify().into(),
                "]".into(),
            ])
        }
    })
}

pub(super) fn redact(command: &Value, error: anyhow::Error) -> anyhow::Error {
    if protected_mode(command) && error.is::<super::Failure>() {
        anyhow!("Codex could not complete this protected turn.")
    } else {
        error
    }
}
