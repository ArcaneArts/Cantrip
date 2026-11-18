//! Authenticated retained native inputs shared by queue preparation and execution.
use super::Scope;
use crate::{
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
use std::collections::HashMap;

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

fn seal_native(scope: &Scope, chat: &Value, prompt: &Value, input: &Value) -> Result<Value> {
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
    let (prefix, suffix) = text.units().split_at_checked(command.len())?;
    if !prefix.iter().copied().eq(command.encode_utf16())
        || suffix
            .first()
            .is_some_and(|&unit| !char::from_u32(u32::from(unit)).is_some_and(whitespace))
    {
        return None;
    }
    Some(JsString::new(suffix.to_vec()).trim())
}

fn classify(
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

    let grant = scope.material(Some(revision(&prompt["protectedContent"])?))?;
    let display = decrypt_communication(
        Communication::QueuedPrompt,
        &grant.key,
        &json!({"ownerId":grant.owner_id,"promptId":prompt["id"],"keyRevision":grant.key_revision}),
        &prompt["protectedContent"],
        prompt.get("classification"),
    )?;
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
