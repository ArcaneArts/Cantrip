//! Authenticated retained native inputs shared by queue preparation and execution.
pub(crate) mod media;

use super::Scope;
use crate::{
    attachments::Store,
    http::checked,
    native_items::{array, join, text},
};
use anyhow::{Context, Result, anyhow, bail};
use cantrip_crypto::{
    Zeroizing,
    content::{Communication, decrypt_communication, encrypt_communication},
    decrypt_payload, derive_field_key, encrypt_payload,
};
use cantrip_history::content::{Encryption, Material};
use cantrip_wire::{
    JsString, Value, parse_json_text, payload_digest, text::whitespace, value::json,
};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::Path};

const NATIVE_INPUT: &str = "managedQueueNativeInputSchema";

pub(crate) fn open_native(
    scope: &Scope,
    chat: &Value,
    prompt: &Value,
    payload: &Value,
    display: &JsString,
    attachment_ids: &[Value],
) -> Result<Value> {
    let grant = scope.material(Some(revision(payload)?))?;
    let aad = native_aad(&grant, chat, prompt);
    let key = derive_field_key(&grant.key, &aad)?;
    let plaintext = decrypt_payload(&key, payload, &aad)?;
    let value = parse_json_text(&String::from_utf8_lossy(&plaintext))
        .map_err(|_| anyhow!("Invalid protected native queue input."))?;
    let mut opened = checked(NATIVE_INPUT, &value)?;
    let changed = opened["displayText"].as_js_string() != Some(display);
    opened["displayText"] = json!(display);
    if opened["retainedGui"] == true
        && (changed
            || opened["representedAttachmentIds"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default()
                != attachment_ids)
    {
        opened["retainedGui"] = json!(false);
        opened["representedAttachmentIds"] = json!(Vec::<Value>::new());
        opened["attachmentMap"] = json!(Vec::<Value>::new());
        opened["input"] = json!(vec![text_input(display)]);
        return Ok(opened);
    }

    let by_index: HashMap<_, _> = array(&opened["attachmentMap"])?
        .iter()
        .map(|entry| (entry["index"].as_u64().unwrap(), &entry["id"]))
        .collect();
    let mut items = Vec::new();
    let mut mappings = Vec::new();
    let mut wrote_text = false;
    for (index, item) in array(&opened["input"])?.iter().enumerate() {
        if let Some(id) = by_index.get(&(index as u64)) {
            if !attachment_ids.contains(id) {
                continue;
            }
            mappings.push(((*id).clone(), items.len()));
        } else if changed && item["type"] == "text" {
            if !wrote_text {
                items.push(text_input(display));
                wrote_text = true;
            }
            continue;
        }
        items.push(item.clone());
    }
    let prepend = changed && !wrote_text && !display.is_empty();
    if prepend {
        items.insert(0, text_input(display));
    }
    opened["input"] = json!(items);
    opened["attachmentMap"] = json!(
        mappings
            .into_iter()
            .map(|(id, index)| { json!({"id":id,"index":index + usize::from(prepend)}) })
            .collect::<Vec<_>>()
    );
    Ok(opened)
}

/// Keep the native vector (including text spans and reference items) beside
/// the ordinary protected queue display and pending user message.
pub(crate) async fn retain_console(
    scope: &Scope,
    store: &Store,
    chat: &JsString,
    operation: &str,
    params: &mut Value,
    configuration: &Value,
    mode: &str,
    console_directory: &Path,
) -> Result<Value> {
    let prompt = stable_id(&json!([
        json!("cantrip:deferred-terminal"),
        json!(scope.server),
        json!(chat),
        json!(operation)
    ]));
    let message = stable_id(&json!([
        json!("cantrip:managed-queue-message"),
        json!(scope.server),
        json!(chat),
        json!(prompt)
    ]));
    let client_id = params["clientUserMessageId"]
        .as_js_string()
        .cloned()
        .unwrap_or_else(|| format!("cantrip:{message}").into());
    anyhow::ensure!(
        !client_id.is_empty() && client_id.len() <= 255,
        "Invalid native user message identity."
    );
    let input = validated_input(&params["input"])?;
    let captured = media::capture(input, console_directory).await?;
    let projected = media::project(
        scope,
        store,
        chat,
        &prompt.clone().into(),
        &operation.into(),
        captured,
        media::Projection::default(),
    )
    .await?;
    let input = &projected.input;
    let display = display_text(input, &projected.map)?;
    let native = json!({
        "version":1, "input":input, "displayText":display, "action":"literal",
        "executionMethod":"turn/start", "attachmentMap":projected.map, "retainedTurnStart":true,
    });
    let raw = super::turn_with_attachments(
        scope,
        &json!({
            "promptId":prompt, "messageId":message, "text":display, "mode":mode,
            "idempotencyKey":format!("managed-queue:{prompt}"),
            "modelId":configuration["model"]["id"],"reasoningEffort":configuration["model"]["reasoningEffort"],
            "customSubagentModel":configuration["subagentDefaults"].is_object(),
            "subagentModelId":configuration["subagentDefaults"]["model"]["id"],
            "subagentReasoningEffort":configuration["subagentDefaults"]["model"]["reasoningEffort"],
        }),
        &projected.summaries,
    )?;
    let mut queued = raw["queuedPrompt"].clone();
    queued["protectedNativeInput"] = seal_native(scope, &json!(chat), &json!(prompt), &native)?;
    queued["nativeAction"] = json!("literal");
    queued["executionMethod"] = json!("turn/start");
    queued["nativeClientUserMessageId"] = json!(client_id);
    queued["worktreeId"] = configuration["session"]["worktreeId"].clone();
    params["input"] = Value::Array(projected.input);
    Ok(json!({
        "prompt":checked("queuedPromptOpaqueContentSchema", &queued)?,
        "attachments":projected.attachments,
    }))
}

pub(crate) async fn retain_gui(scope: &Scope, command: &Value, input: &Value) -> Result<Value> {
    let message = &command["protectedPrompt"];
    let chat = &command["chatId"];
    let attachments = array(&command["attachments"])?;
    let ids = attachments
        .iter()
        .map(|attachment| attachment["id"].clone())
        .collect();
    anyhow::ensure!(
        message["classification"]["role"] == "user"
            && message["id"] == command["clientMessageId"]
            && message["classification"]["attachmentIds"] == Value::Array(ids)
            && attachments
                .iter()
                .all(|attachment| attachment["chatId"] == *chat),
        "The retained GUI input does not match its original message and attachments."
    );
    let previous = scope.material(Some(revision(&message["protectedContent"])?))?;
    let opened = decrypt_communication(
        Communication::Message,
        &previous.key,
        &json!({"ownerId":previous.owner_id,"messageId":message["id"],"keyRevision":previous.key_revision}),
        &message["protectedContent"],
        message.get("classification"),
    )?;
    let text = join(
        array(&opened["content"])?.iter().filter_map(|item| {
            if item["type"] == "text" {
                item["text"].as_js_string().cloned()
            } else {
                None
            }
        }),
        "\n",
    );
    let id = json!(stable_id(&Value::Array(vec![
        json!("cantrip:deferred-gui"),
        json!(scope.server),
        chat.clone(),
        message["id"].clone(),
    ])));
    let classification = json!({
        "mode":message["classification"]["mode"],"attachmentIds":message["classification"]["attachmentIds"],
    });
    let cwd = crate::filesystem::paths::native(
        command["cwd"]
            .as_js_string()
            .context("Missing GUI placement.")?,
    );
    let native = media::capture(validated_input(input)?, &cwd).await?;
    let native = seal_native(
        scope,
        chat,
        &id,
        &json!({
            "version":1,"input":native.input,"displayText":text,"action":"literal","executionMethod":"turn/start",
            "retainedGui":true,"attachmentMap":Vec::<Value>::new(),"representedAttachmentIds":classification["attachmentIds"],
        }),
    )?;
    let grant = scope.material(None)?;
    let protected = encrypt_communication(
        Communication::QueuedPrompt,
        &grant.key,
        &json!({"ownerId":grant.owner_id,"promptId":id,"keyRevision":grant.key_revision}),
        &json!({"version":1,"classification":classification,"text":text}),
    )?;
    let message_id = message["id"]
        .as_js_string()
        .context("Missing admitted message ID.")?;
    let prompt = checked(
        "queuedPromptOpaqueContentSchema",
        &json!({
            "id":id,"classification":classification,"protectedContent":protected,"pendingMessage":message,
            "modelId":command["model"]["id"],"reasoningEffort":message["reasoningEffort"],
            "customSubagentModel":command["subagentDefaults"].is_object(),
            "subagentModelId":command["subagentDefaults"]["model"]["id"],
            "subagentReasoningEffort":command["subagentDefaults"]["model"]["reasoningEffort"],
            "worktreeId":command["worktreeId"],"frozen":false,
            "idempotencyKey":crate::native_items::concat(&["deferred-gui:".into(), message_id.clone()]),
            "protectedNativeInput":native,"nativeAction":"literal","executionMethod":"turn/start",
            "nativeClientUserMessageId":crate::native_items::concat(&["cantrip:".into(), message_id.clone()]),
        }),
    )?;
    Ok(json!({"prompt":prompt,"attachments":attachments}))
}

pub(crate) fn validated_input(input: &Value) -> Result<Vec<Value>> {
    let mut request = checked(
        NATIVE_INPUT,
        &json!({
            "version":1, "input":input, "displayText":"",
            "action":"literal", "executionMethod":"turn/start",
        }),
    )?;
    let Value::Array(input) = &mut request["input"] else {
        unreachable!("validated native input vector")
    };
    Ok(std::mem::take(input))
}

pub(crate) fn display_text(input: &[Value], map: &[Value]) -> Result<JsString> {
    let display = join(
        input
            .iter()
            .enumerate()
            .filter(|(index, item)| {
                item["type"] == "text"
                    && !map
                        .iter()
                        .any(|value| value["index"].as_u64() == Some(*index as u64))
            })
            .map(|(_, item)| text(&item["text"]).cloned())
            .collect::<Result<Vec<_>>>()?,
        "\n",
    )
    .trim();
    Ok(if display.is_empty() {
        join(
            input.iter().filter_map(|item| {
                let kind = item["type"].as_str()?;
                match kind {
                    "image" => Some("[Queued image]".into()),
                    "audio" => Some("[Queued audio]".into()),
                    "skill" => Some(crate::native_items::concat(&[
                        "[Skill: ".into(),
                        item["name"].as_js_string()?.clone(),
                        "]".into(),
                    ])),
                    "mention" => Some(crate::native_items::concat(&[
                        "[Mention: ".into(),
                        item["name"].as_js_string()?.clone(),
                        "]".into(),
                    ])),
                    _ => None,
                }
            }),
            "\n",
        )
    } else {
        display
    })
}

pub(crate) fn stable_id(parts: &Value) -> String {
    let digest = Sha256::digest(parts.stringify().as_bytes());
    let mut bytes: [u8; 16] = digest[..16].try_into().unwrap();
    bytes[6] = (bytes[6] & 15) | 80;
    bytes[8] = (bytes[8] & 63) | 128;
    uuid::Uuid::from_bytes(bytes).to_string()
}

pub(crate) fn seal_native(
    scope: &Scope,
    chat: &Value,
    prompt: &Value,
    input: &Value,
) -> Result<Value> {
    let input = checked(NATIVE_INPUT, input)?;
    let grant = scope.material(None)?;
    let aad = native_aad(&grant, chat, prompt);
    let key = derive_field_key(&grant.key, &aad)?;
    let plaintext = Zeroizing::new(input.stringify());
    encrypt_payload(&key, plaintext.as_bytes(), &aad)
}

fn native_aad(grant: &Material, chat: &Value, prompt: &Value) -> Value {
    let row = Value::Array(vec![json!(grant.server_id), chat.clone(), prompt.clone()]);
    json!({
        "ownerId":grant.owner_id,"component":"chat-content","table":"managed-queue",
        "rowId":payload_digest(&row),"field":"native-input","formatVersion":1,
        "keyRevision":grant.key_revision,
    })
}

fn revision(payload: &Value) -> Result<u64> {
    payload["keyRevision"]
        .as_u64()
        .context("Missing queued input key revision.")
}

pub(crate) fn text_input(text: &JsString) -> Value {
    json!({"type":"text","text":text,"text_elements":Vec::<Value>::new()})
}

pub(crate) fn native_text(items: &[Value]) -> Result<JsString> {
    Ok(join(
        items
            .iter()
            .filter(|item| item["type"] == "text")
            .map(|item| text(&item["text"]).cloned())
            .collect::<Result<Vec<_>>>()?,
        "\n",
    ))
}

pub(crate) fn slash_argument(text: &JsString, command: &str) -> Option<JsString> {
    let start = slash_prefix_len(text, command)?;
    Some(JsString::new(text.units()[start..].to_vec()).trim())
}

pub(crate) fn slash_prefix_len(text: &JsString, command: &str) -> Option<usize> {
    let (prefix, suffix) = text.units().split_at_checked(command.len())?;
    let space = |unit| char::from_u32(u32::from(unit)).is_some_and(whitespace);
    if !prefix.iter().copied().eq(command.encode_utf16())
        || suffix.first().is_some_and(|&unit| !space(unit))
    {
        return None;
    }
    Some(prefix.len() + suffix.iter().take_while(|&&unit| space(unit)).count())
}

pub(crate) fn classify(
    native: &Value,
    mode: &str,
) -> Result<(&'static str, &'static str, Option<&'static str>)> {
    let text = native_text(array(&native["input"])?)?;
    let method = if mode == "goal" {
        "thread/goal/set"
    } else {
        "turn/start"
    };
    match native["action"].as_str() {
        Some("runShell") => Ok(("runShell", "thread/shellCommand", Some("default"))),
        Some("plain") if text.units().first() == Some(&u16::from(b'!')) => {
            Ok(("runShell", "thread/shellCommand", Some("default")))
        }
        Some("plain") => Ok(("plain", method, None)),
        Some("literal") => Ok(("literal", method, None)),
        Some("parseSlash") => {
            if let Some(argument) = slash_argument(&text, "/plan") {
                return Ok((
                    "parseSlash",
                    if argument.is_empty() {
                        "thread/settings/update"
                    } else {
                        "turn/start"
                    },
                    Some("plan"),
                ));
            }
            if let Some(argument) = slash_argument(&text, "/goal") {
                let method = match argument.lossy().to_lowercase().as_str() {
                    "" | "edit" => bail!(
                        "This goal command opens an interactive CLI view. Run it directly; the queued draft was not dispatched."
                    ),
                    "clear" => "thread/goal/clear",
                    _ => "thread/goal/set",
                };
                return Ok(("parseSlash", method, Some("goal")));
            }
            bail!(
                "This queued slash command has no managed execution mapping yet. Edit the queued command or run it directly in the CLI."
            );
        }
        _ => bail!("Missing protected native queue action."),
    }
}

pub(super) fn prepare(scope: &Scope, command: &Value) -> Result<Value> {
    let mut prompt = command["prompt"].clone();
    if prompt["protectedNativeInput"].is_null() {
        if prompt["nativeAction"].is_null() {
            prompt["nativeAction"] = json!("literal");
        }
        prompt["executionMethod"] = json!(if prompt["classification"]["mode"] == "goal" {
            "thread/goal/set"
        } else {
            "turn/start"
        });
        return checked("queuedPromptOpaqueContentSchema", &prompt);
    }

    let display = open_display(scope, &prompt)?;
    let mut native = open_native(
        scope,
        &command["chatId"],
        &prompt["id"],
        &prompt["protectedNativeInput"],
        text(&display["text"])?,
        array(&prompt["classification"]["attachmentIds"])?,
    )?;

    if native["retainedGui"] != true && native["retainedTurnStart"] != true {
        let mode = prompt["classification"]["mode"]
            .as_str()
            .context("Missing queued input mode.")?;
        let (action, method, new_mode) = classify(&native, mode)?;
        native["action"] = json!(action);
        native["executionMethod"] = json!(method);
        if let Some(new_mode) = new_mode.filter(|new_mode| *new_mode != mode) {
            reseal_mode(scope, &mut prompt, display, new_mode)?;
        }
    }

    prompt["nativeAction"] = native["action"].clone();
    prompt["executionMethod"] = native["executionMethod"].clone();
    prompt["protectedNativeInput"] =
        seal_native(scope, &command["chatId"], &prompt["id"], &native)?;
    checked("queuedPromptOpaqueContentSchema", &prompt)
}

pub(crate) fn open_display(scope: &Scope, prompt: &Value) -> Result<Value> {
    let grant = scope.material(Some(revision(&prompt["protectedContent"])?))?;
    decrypt_communication(
        Communication::QueuedPrompt,
        &grant.key,
        &json!({"ownerId":grant.owner_id,"promptId":prompt["id"],"keyRevision":grant.key_revision}),
        &prompt["protectedContent"],
        prompt.get("classification"),
    )
}

fn reseal_mode(scope: &Scope, prompt: &mut Value, mut display: Value, mode: &str) -> Result<()> {
    let pending = &prompt["pendingMessage"];
    let previous = scope.material(Some(revision(&pending["protectedContent"])?))?;
    let mut message = decrypt_communication(
        Communication::Message,
        &previous.key,
        &json!({"ownerId":previous.owner_id,"messageId":pending["id"],"keyRevision":previous.key_revision}),
        &pending["protectedContent"],
        pending.get("classification"),
    )?;

    let grant = scope.material(None)?;
    display["classification"]["mode"] = json!(mode);
    message["classification"]["mode"] = json!(mode);
    let protected_display = encrypt_communication(
        Communication::QueuedPrompt,
        &grant.key,
        &json!({"ownerId":grant.owner_id,"promptId":prompt["id"],"keyRevision":grant.key_revision}),
        &display,
    )?;
    let protected_message = encrypt_communication(
        Communication::Message,
        &grant.key,
        &json!({"ownerId":grant.owner_id,"messageId":pending["id"],"keyRevision":grant.key_revision}),
        &message,
    )?;
    prompt["classification"] = display["classification"].clone();
    prompt["protectedContent"] = protected_display;
    prompt["pendingMessage"]["classification"] = message["classification"].clone();
    prompt["pendingMessage"]["protectedContent"] = protected_message;
    Ok(())
}
