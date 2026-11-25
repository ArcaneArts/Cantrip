use super::{Authorized, Inner, now};
use crate::{chat_content, encryption::Service, http::checked};
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_crypto::content::decrypt_private_label;
use cantrip_history::{canonical::open_message, content::Encryption};
use cantrip_protocol::{mcp_host, response::response_error};
use cantrip_wire::{JsString, Value, value::json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};
use tokio::time::{Instant, sleep_until};

impl Inner {
    pub(super) async fn chat(
        &self,
        authorization: &Authorized,
        call: &Value,
        operation: &str,
    ) -> Result<Value> {
        let encryption = self
            .encryption
            .as_ref()
            .context("Chat encryption is unavailable.")?;
        let scope = chat_content::Scope::new(encryption.clone())?;
        let council = operation == "council.project.send";
        ensure!(
            authorization.active.binding["contextKind"]
                == if council { "standalone" } else { "project" }
                && (&scope.owner, &scope.server)
                    == (&authorization.identity.0, &authorization.identity.1),
            if council {
                "Project messages require the current Council agent's authorized worker."
            } else {
                "Chat tools require the current project's authorized worker."
            }
        );
        let tool = crate::mcp::bindings::CHAT_TOOLS
            .iter()
            .chain(crate::mcp::bindings::COUNCIL_TOOLS.iter())
            .find(|(candidate, _)| *candidate == operation)
            .map(|(_, tool)| *tool)
            .context("Unsupported Cantrip MCP Chat operation.")?;
        let input = mcp_host::parse(&format!("mcpStdioInput/{tool}"), call.get("arguments"))
            .map_err(response_error)?;
        let request_id = uuid::Uuid::new_v4().to_string();
        let response = match operation {
            "chat.list" => {
                let mut response = self
                    .relay_project(
                        authorization,
                        json!({"operation":operation,"arguments":input}),
                        &request_id,
                    )
                    .await?;
                let chats = response["data"]["chats"]
                    .as_array()
                    .filter(|chats| chats.len() <= 100)
                    .context("Invalid project Chat catalog.")?;
                let opened = chats
                    .iter()
                    .map(|chat| {
                        let chat = cantrip_protocol::parse_property(
                            "agentChatReadWireSchema",
                            "chat",
                            chat,
                        )
                        .map_err(response_error)?;
                        descriptor(encryption, &scope, &chat)
                    })
                    .collect::<Result<Vec<_>>>()?;
                response["data"]["chats"] = json!(opened);
                response
            }
            "chat.send" | "council.project.send" => {
                self.send_chat(authorization, encryption, &scope, &input, &request_id)
                    .await?
            }
            _ => {
                self.read_chat(
                    authorization,
                    encryption,
                    &scope,
                    &input,
                    operation,
                    &request_id,
                )
                .await?
            }
        };
        scope.identity()?;
        mcp_host::parse(&format!("mcpStdioOutput/{tool}"), Some(&response)).map_err(response_error)
    }

    async fn send_chat(
        &self,
        authorization: &Authorized,
        encryption: &Service,
        scope: &chat_content::Scope,
        input: &Value,
        request_id: &str,
    ) -> Result<Value> {
        let project = input.get("projectId");
        let lookup = match project {
            Some(project) => {
                json!({"operation":"council.project.send","arguments":json!({"kind":"resolve","projectId":project,"chatId":input["chatId"]})})
            }
            None => {
                json!({"operation":"chat.read","arguments":json!({"chatId":input["chatId"],"limit":1})})
            }
        };
        let response = self
            .relay_project(authorization, lookup, request_id)
            .await?;
        let wire = if project.is_some() {
            let wire = checked("councilProjectChatTargetWireSchema", &response["data"])?;
            ensure!(
                wire["chat"]["id"] == input["chatId"]
                    && wire["sender"]["id"] == authorization.active.binding["chatId"],
                "Cantrip returned another Council delivery target."
            );
            wire
        } else {
            read_wire(authorization, &response, &input["chatId"])?
        };
        let source = descriptor(encryption, scope, &wire["sender"])?;
        let target = descriptor(encryption, scope, &wire["chat"])?;
        ensure!(
            !target["modelId"].is_null(),
            "Choose a model in the receiving chat first."
        );
        let key = format!(
            "agent-chat:{}:{}:{}",
            source["id"].as_js_string().unwrap().lossy(),
            target["id"].as_js_string().unwrap().lossy(),
            input["operationId"].as_str().unwrap(),
        );
        let mut communication = json!({
            "deliveryId":input["operationId"],"sourceChatId":source["id"],"sourceTitle":source["title"],
            "targetChatId":target["id"],"targetTitle":target["title"],"direction":"received",
        });
        if project.is_some() {
            communication["senderKind"] = json!("council");
        }
        let mut draft = wire["chat"]["configuration"].clone();
        draft["idempotencyKey"] = json!(format!("{key}:input"));
        draft["messageId"] = json!(stable_id(&format!("{key}:input")));
        draft["promptId"] = json!(stable_id(&format!("{key}:prompt")));
        draft["mode"] = json!("default");
        draft["text"] = input["message"].clone();
        let turn = chat_content::turn_with_communication(scope, &draft, &communication)?;
        let receipt = |direction: &str, communication: &Value| {
            scope.protect(&json!({
            "id":stable_id(&format!("{key}:{direction}")), "idempotencyKey":format!("{key}:{direction}"),
            "role":"assistant","mode":"default",
            "content":[json!({"type":"text","text":input["message"],"phase":"commentary","chatCommunication":communication})],
        }))
        };
        let received = receipt("received", &communication)?;
        communication["direction"] = json!("sent");
        let sent = receipt("sent", &communication)?;
        let delivery = checked(
            "agentChatSendWireSchema",
            &json!({
                "chatId":target["id"],"operationId":input["operationId"],
                "turn":turn,"sentMessage":sent,"receivedMessage":received,
            }),
        )?;
        scope.identity()?;
        let send = match project {
            Some(project) => {
                json!({"operation":"council.project.send","arguments":json!({"kind":"send","projectId":project,"steer":input["steer"],"delivery":delivery})})
            }
            None => json!({"operation":"chat.send","arguments":delivery}),
        };
        let mut result = self.relay_project(authorization, send, request_id).await?;
        ensure!(result["data"].is_object(), "Invalid chat delivery receipt.");
        result["summary"] = json!(crate::native_items::concat(&[
            "Sent an agent message to ".into(),
            target["title"].as_js_string().unwrap().clone(),
            ".".into(),
        ]));
        if project.is_none() {
            result["data"]["message"] = input["message"].clone();
            result["data"]["sourceTitle"] = source["title"].clone();
            result["data"]["targetTitle"] = target["title"].clone();
        }
        Ok(result)
    }

    async fn read_chat(
        &self,
        authorization: &Authorized,
        encryption: &Service,
        scope: &chat_content::Scope,
        input: &Value,
        operation: &str,
        request_id: &str,
    ) -> Result<Value> {
        let cursor = input.get("afterCursor");
        let args = if cursor.is_some() {
            mcp_host::parse(
                "mcpStdioInput/chat_read",
                Some(&json!({"chatId":input["chatId"]})),
            )
            .map_err(response_error)?
        } else {
            input.clone()
        };
        let request = json!({"operation":operation,"arguments":args});
        let deadline =
            Instant::now() + Duration::from_millis(input["timeoutMs"].as_u64().unwrap_or(0));
        let mut lane = authorization.active.stopped.subscribe();
        let expires = Instant::now()
            + Duration::from_millis(authorization.expires_at.saturating_sub(now()).max(0) as u64);
        let poll = async {
            loop {
                let response = self
                    .relay_project(authorization, request.clone(), request_id)
                    .await?;
                let wire = read_wire(authorization, &response, &args["chatId"])?;
                if cursor != Some(&wire["cursor"]) || Instant::now() >= deadline {
                    break Ok::<_, anyhow::Error>((response, wire));
                }
                sleep_until(deadline.min(Instant::now() + Duration::from_secs(1))).await;
            }
        };
        let (mut response, wire) = tokio::select! {
            biased;
            _ = lane.wait_for(|stopped| *stopped) => Err(anyhow!("Chat read stopped with its agent turn.")),
            _ = sleep_until(expires) => Err(anyhow!("Cantrip MCP binding has expired.")),
            result = poll => result,
        }?;
        let (messages, truncated) =
            history(scope, &wire, args["maxChars"].as_u64().unwrap() as usize)?;
        let timed_out = cursor == Some(&wire["cursor"]);
        response["summary"] = if cursor.is_none() {
            json!(format!("Read {} chat messages.", messages.len()))
        } else if timed_out {
            json!("No chat changes before the wait timed out.")
        } else {
            json!("The chat changed.")
        };
        response["data"] = json!({
            "chat":descriptor(encryption, scope, &wire["chat"])?,
            "messages":messages,"page":wire["page"],"cursor":wire["cursor"],"truncated":truncated,
        });
        if cursor.is_some() {
            response["data"]["timedOut"] = json!(timed_out);
        }
        Ok(response)
    }
}

fn read_wire(authorization: &Authorized, response: &Value, target: &Value) -> Result<Value> {
    let wire = checked("agentChatReadWireSchema", &response["data"])?;
    ensure!(
        &wire["chat"]["id"] == target
            && wire["sender"]["id"] == authorization.active.binding["chatId"],
        "Cantrip returned history for another chat."
    );
    Ok(wire)
}

fn descriptor(service: &Service, scope: &chat_content::Scope, chat: &Value) -> Result<Value> {
    let opaque = &chat["titleProtection"];
    let revision = opaque["protectedLabel"]["keyRevision"].as_u64().unwrap();
    let title = match service.bound_component("private-surface-metadata", Some(revision)) {
        Ok(grant) => {
            ensure!(
                grant.owner_id == scope.owner
                    && grant.server_id.as_js_string() == Some(&scope.server),
                "The worker binding changed during protected chat processing."
            );
            decrypt_private_label(
                &grant.component.key,
                &json!({"ownerId":scope.owner,"keyRevision":revision,"recordKind":"chat","rowId":chat["id"]}),
                opaque,
            ).ok()
        }
        Err(error) if error.code == Some("missing-scope") => {
            scope.identity()?;
            None
        }
        Err(error) => return Err(error.into()),
    };
    let title = title.unwrap_or_else(|| {
        json!(crate::native_items::concat(&[
            "Agent ".into(),
            chat["id"].as_js_string().unwrap().clone(),
        ]))
    });
    Ok(json!({
        "id":chat["id"],"title":title,"status":chat["status"],
        "automationPaused":chat["automationPaused"],"modelId":chat["configuration"]["modelId"]
    }))
}

fn history(
    scope: &chat_content::Scope,
    wire: &Value,
    mut remaining: usize,
) -> Result<(Vec<Value>, bool)> {
    let mut keys = HashMap::new();
    let mut opened = Vec::new();
    for message in wire["messages"].as_array().unwrap() {
        let revision = message["protectedContent"]["keyRevision"].as_u64().unwrap();
        let key = match keys.entry(revision) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(scope.material(Some(revision))?.key)
            }
        };
        let content = open_message(key, &json!(scope.owner), message)?;
        opened.push((message, content));
    }
    let delivered: HashSet<_> = opened
        .iter()
        .filter(|(message, _)| message["role"] == "user")
        .flat_map(|(_, content)| content.as_array().unwrap().iter().filter_map(delivery_key))
        .collect();
    let mut messages = Vec::new();
    let mut truncated = false;
    for (message, content) in opened.iter().rev() {
        let items = content.as_array().unwrap();
        if message["role"] == "assistant"
            && items
                .iter()
                .filter_map(delivery_key)
                .any(|key| delivered.contains(&key))
        {
            continue;
        }
        let parts: Vec<_> = items.iter().filter(|item| item["type"] == "text").collect();
        let text = crate::native_items::join(
            parts
                .iter()
                .map(|item| item["text"].as_js_string().unwrap().clone()),
            "\n\n",
        );
        let take = remaining.min(text.len());
        truncated |= take < text.len();
        remaining -= take;
        let mut row = json!({
            "id":message["id"], "sequence":message["sequence"], "role":message["role"],
            "text":JsString::new(text.units()[..take].to_vec()),"createdAt":message["createdAt"],
        });
        if let Some(communication) = parts.iter().find_map(|item| item.get("chatCommunication")) {
            row["chatCommunication"] = communication.clone();
            if communication["direction"] == "received" {
                row["role"] = json!("agent");
            }
        }
        messages.push(row);
    }
    messages.reverse();
    Ok((messages, truncated))
}

fn delivery_key(item: &Value) -> Option<[&JsString; 3]> {
    let delivery = &item["chatCommunication"];
    if item["type"] != "text" || delivery["direction"] != "received" {
        return None;
    }
    Some([
        delivery["sourceChatId"].as_js_string()?,
        delivery["targetChatId"].as_js_string()?,
        delivery["deliveryId"].as_js_string()?,
    ])
}

fn stable_id(key: &str) -> String {
    let mut bytes: [u8; 16] = Sha256::digest(key.as_bytes())[..16].try_into().unwrap();
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).to_string()
}
