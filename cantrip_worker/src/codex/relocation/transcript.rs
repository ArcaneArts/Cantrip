use crate::{encryption::Service, http::checked, native_items::concat};
use anyhow::{Context, Result, ensure};
use cantrip_crypto::content::{Communication, decrypt_communication};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};

pub(crate) struct Opened {
    pub payload: Value,
    pub encrypted: bool,
}

pub(crate) fn open(bytes: &[u8], service: &Service, bound: &(JsString, Value)) -> Result<Opened> {
    let mut payload = checked(
        "chatRelocationContextPayloadSchema",
        &parse_json_text(&String::from_utf8_lossy(bytes))
            .map_err(|_| anyhow::anyhow!("Relocation transcript is not valid JSON."))?,
    )?;
    let task = payload["kind"] == "task-encrypted";
    let encrypted = payload["kind"] != "visible";
    if encrypted {
        let grant =
            service.bound_component(if task { "task-content" } else { "chat-content" }, None)?;
        ensure!(
            (grant.owner_id.clone(), grant.server_id.clone()) == *bound,
            "The worker binding changed while opening the canonical transcript."
        );
        let messages = payload["messages"]
            .as_array()
            .context("Missing canonical messages.")?;
        let mut visible = Vec::with_capacity(messages.len());
        for message in messages {
            let revision = message["protectedContent"]["keyRevision"].as_u64();
            ensure!(
                revision == Some(grant.component.key_revision),
                "The chat encryption key revision is unavailable."
            );
            let context =
                json!({"ownerId":grant.owner_id,"messageId":message["id"],"keyRevision":revision});
            let classification = json!({"role":message["role"],"mode":message["mode"],"attachmentIds":message["attachmentIds"]});
            let opened = decrypt_communication(
                if task {
                    Communication::TaskMessage
                } else {
                    Communication::Message
                },
                &grant.component.key,
                &context,
                &message["protectedContent"],
                Some(&classification),
            )?;
            visible.push(json!({"sequence":message["sequence"],"role":message["role"],"mode":message["mode"],
                "reasoningEffort":message["reasoningEffort"],"createdAt":message["createdAt"],"content":opened["content"]}));
        }
        payload["messages"] = json!(visible);
        payload["kind"] = json!("visible");
    }
    ensure!(
        service.bound_identity()? == *bound,
        "The worker binding changed while opening the canonical transcript."
    );
    Ok(Opened {
        payload: checked("chatRelocationContextPayloadSchema", &payload)?,
        encrypted,
    })
}

pub(crate) fn response_item(message: &Value) -> Result<(Value, JsString)> {
    let text = content(&message["content"])?;
    let text = if message["mode"] == "default" {
        text
    } else {
        concat(&[
            format!("[Cantrip {} mode]\n", message["mode"].as_str().unwrap()).into(),
            text,
        ])
    };
    let role = match message["role"].as_str() {
        Some("system") => "developer",
        Some(role) => role,
        None => anyhow::bail!("Invalid canonical message role."),
    };
    let item = json!({"type":"message","role":role,"content":vec![
        json!({"type":if role == "assistant" {"output_text"} else {"input_text"},"text":text}),
    ]});
    ensure!(
        item.stringify().len() <= 1_000_000,
        "A canonical chat message is too large to hydrate safely."
    );
    Ok((item, text))
}

fn content(parts: &Value) -> Result<JsString> {
    let parts = parts
        .as_array()
        .context("Invalid canonical message content.")?;
    let mut result = Vec::new();
    for (index, item) in parts.iter().enumerate() {
        if index != 0 {
            result.extend([10, 10]);
        }
        let value = match item["type"].as_str() {
            Some("text") => item["text"]
                .as_js_string()
                .cloned()
                .context("Missing canonical message text.")?,
            Some("attachment") => {
                let source = &item["attachment"];
                let field = |name: &str| {
                    source[name]
                        .as_js_string()
                        .cloned()
                        .unwrap_or_else(|| "".into())
                };
                concat(&[
                    "[Cantrip attachment: ".into(),
                    field("fileName"),
                    " (".into(),
                    field("mimeType"),
                    "), id ".into(),
                    field("id"),
                    "]".into(),
                ])
            }
            _ => {
                let mut activity = item["activity"].clone();
                if activity["type"] == "instructionContext" {
                    concat(&[
                        "[Cantrip effective instructions: ".into(),
                        activity["provenance"]
                            .as_js_string()
                            .cloned()
                            .unwrap_or_else(|| "".into()),
                        "]".into(),
                    ])
                } else {
                    if let Value::Object(fields) = &mut activity {
                        fields.shift_remove(&JsString::from("raw"));
                    }
                    format!(
                        "[Cantrip {} activity: {}]",
                        activity["type"].as_str().unwrap_or("undefined"),
                        activity.stringify()
                    )
                    .into()
                }
            }
        };
        result.extend(value.units());
    }
    let text = JsString::new(result).trim();
    Ok(if text.is_empty() {
        "[Empty message]".into()
    } else {
        text
    })
}
