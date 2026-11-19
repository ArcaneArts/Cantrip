use super::{View, required};
use crate::{
    attachments::content,
    chat_content::{Scope, queue, queue::media, turn_with_attachments},
    filesystem::paths,
    history::input_materializer,
    http::checked,
    native_items::{array, concat, join, text},
};
use anyhow::{Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_history::content::Encryption;
use cantrip_wire::{JsString, Value, value::json};

fn open_vector(scope: &Scope, view: &View, item: &Value) -> Result<Value> {
    ensure!(
        item["chatId"].as_js_string() == Some(&view.chat),
        "The queue item belongs to another chat."
    );
    let display = queue::open_display(scope, item)?;
    let content = text(&display["text"])?;
    if item["protectedNativeInput"].is_null() {
        return Ok(json!({
            "input":vec![queue::text_input(content)],
            "action":item.get("nativeAction").filter(|action| !action.is_null()).cloned().unwrap_or_else(|| json!("literal")),
        }));
    }
    queue::open_native(
        scope,
        &json!(view.chat),
        &item["id"],
        &item["protectedNativeInput"],
        content,
        array(&item["classification"]["attachmentIds"])?,
    )
}

pub(super) async fn open(view: &View, scope: &Scope, item: &Value) -> Result<Value> {
    let opened = open_vector(scope, view, item)?;
    let mut input = array(&opened["input"])?.to_vec();
    let remaining = array(&item["attachments"])?
        .iter()
        .filter(|attachment| {
            let id = &attachment["id"];
            !opened["representedAttachmentIds"]
                .as_array()
                .is_some_and(|ids| ids.contains(id))
                && !opened["attachmentMap"]
                    .as_array()
                    .is_some_and(|map| map.iter().any(|entry| &entry["id"] == id))
        })
        .collect::<Vec<_>>();
    input.extend(attachment_inputs(view, scope, &remaining).await?);
    let message = item
        .get("nativeClientUserMessageId")
        .filter(|value| value.is_string())
        .cloned()
        .unwrap_or_else(|| {
            json!(format!(
                "cantrip:{}",
                item["pendingMessage"]["id"].as_js_string().unwrap().lossy()
            ))
        });
    Ok(json!({
        "id":item["id"],"input":input,"clientUserMessageId":message,
        "managed":json!({
            "frozen":item["frozen"],"mode":item["classification"]["mode"],
            "action":opened["action"],"modelLabel":item["modelId"],"worktreeLabel":item["worktreeId"],
        }),
    }))
}

pub(super) enum Preparation<'a> {
    Add,
    Edit(&'a Value),
    Import,
}

pub(super) async fn prepare(
    view: &View,
    scope: &Scope,
    params: &Value,
    operation: &JsString,
    id: &JsString,
    preparation: Preparation<'_>,
) -> Result<Value> {
    let imported = matches!(preparation, Preparation::Import);
    let existing = match preparation {
        Preparation::Edit(item) => Some(item),
        _ => None,
    };
    let empty = Value::Null;
    let previous = existing.unwrap_or(&empty);
    let configuration = &view.command;
    let captured = media::capture(
        queue::validated_input(&params["input"])?,
        &view.local_directory,
    )
    .await?;
    let requested = params["managed"]["action"]
        .as_str()
        .or_else(|| previous["nativeAction"].as_str())
        .unwrap_or("plain");
    let default_mode = configuration["planMode"].as_str().unwrap_or("default");
    let mode = previous["classification"]["mode"].as_str().unwrap_or(
        if imported && default_mode != "plan" {
            "default"
        } else {
            default_mode
        },
    );
    let (action, method, mode_override) =
        queue::classify(&json!({"input":captured.input,"action":requested}), mode)?;
    let mode = mode_override.unwrap_or(mode);
    let retained = if let Some(previous) = existing {
        retained_attachments(view, scope, previous, &captured.input).await?
    } else {
        media::Projection::default()
    };
    let id_value = json!(id);
    let prompt_id = id.lossy();
    let projected = media::project(
        scope,
        &view.turns.attachments,
        &view.chat,
        id,
        operation,
        captured,
        retained,
    )
    .await?;
    let display = queue::display_text(&projected.input, &projected.map)?;
    let message = previous
        .get("pendingMessage")
        .map(|message| message["id"].clone())
        .unwrap_or_else(|| {
            json!(queue::stable_id(&json!((
                "cantrip:managed-queue-message",
                &scope.server,
                &view.chat,
                id,
            ))))
        });
    let mut client_id = params
        .get("clientUserMessageId")
        .filter(|value| !value.is_null())
        .or_else(|| {
            previous
                .get("nativeClientUserMessageId")
                .filter(|value| !value.is_null())
        })
        .cloned()
        .unwrap_or_else(|| {
            json!(format!(
                "cantrip:{}",
                message.as_js_string().unwrap().lossy()
            ))
        });
    client_id = json!(required(&client_id, "client message ID")?);
    let selected = |field: &str, default: &Value| {
        existing.map_or_else(|| default.clone(), |item| item[field].clone())
    };
    let idempotency = previous
        .get("idempotencyKey")
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| json!(format!("managed-queue:{prompt_id}")));
    let subagents = if imported {
        &empty
    } else {
        &configuration["subagentDefaults"]
    };
    let turn = turn_with_attachments(
        scope,
        &json!({
            "promptId":id_value,"messageId":message,"text":display,"mode":mode,"idempotencyKey":idempotency,
            "modelId":selected("modelId",&configuration["model"]["id"]),
            "reasoningEffort":selected("reasoningEffort",&configuration["model"]["reasoningEffort"]),
            "customSubagentModel":selected("customSubagentModel",&json!(subagents.is_object())),
            "subagentModelId":selected("subagentModelId",&subagents["model"]["id"]),
            "subagentReasoningEffort":selected("subagentReasoningEffort",&subagents["model"]["reasoningEffort"]),
        }),
        &projected.summaries,
    )?;
    let mut prompt = turn["queuedPrompt"].clone();
    prompt["protectedNativeInput"] = queue::seal_native(
        scope,
        &json!(view.chat),
        &id_value,
        &json!({
            "version":1,"input":projected.input,"displayText":display,"action":action,
            "executionMethod":method,"attachmentMap":projected.map,
        }),
    )?;
    prompt["nativeAction"] = json!(action);
    prompt["executionMethod"] = json!(method);
    prompt["nativeClientUserMessageId"] = client_id;
    prompt["worktreeId"] = selected("worktreeId", &configuration["session"]["worktreeId"]);
    prompt["frozen"] = selected("frozen", &json!(false));
    Ok(json!({
        "prompt":checked("queuedPromptOpaqueContentSchema", &prompt)?,
        "attachments":projected.attachments,
    }))
}

async fn retained_attachments(
    view: &View,
    scope: &Scope,
    previous: &Value,
    input: &[Value],
) -> Result<media::Projection> {
    let opened = open_vector(scope, view, previous)?;
    let mut projection = media::Projection::default();
    let mut represented = vec![false; input.len()];
    for attachment in array(&previous["attachments"])? {
        let id = &attachment["id"];
        let mut items = Vec::new();
        if let Some(map) = opened["attachmentMap"].as_array() {
            let native = array(&opened["input"])?;
            for mapping in map.iter().filter(|entry| &entry["id"] == id) {
                if let Some(item) = mapping["index"]
                    .as_u64()
                    .and_then(|index| native.get(index as usize))
                {
                    items.push(item.clone());
                }
            }
        }
        if items.is_empty() {
            items = attachment_inputs(view, scope, &[attachment]).await?;
        }
        if items.is_empty() || items.len() > input.len() {
            continue;
        }
        let start = input
            .windows(items.len())
            .enumerate()
            .find_map(|(start, window)| {
                (window
                    .iter()
                    .zip(&items)
                    .enumerate()
                    .all(|(offset, (actual, expected))| {
                        !represented[start + offset] && actual.stringify() == expected.stringify()
                    }))
                .then_some(start)
            });
        let Some(start) = start else { continue };
        for (index, taken) in represented
            .iter_mut()
            .enumerate()
            .skip(start)
            .take(items.len())
        {
            *taken = true;
            projection.map.push(json!({"id":id,"index":index}));
        }
        let metadata = content::open(scope, attachment)?;
        projection
            .summaries
            .push(checked("chatAttachmentSummarySchema", &metadata)?);
        projection.attachments.push(attachment.clone());
    }
    Ok(projection)
}

async fn attachment_inputs(
    view: &View,
    scope: &Scope,
    attachments: &[&Value],
) -> Result<Vec<Value>> {
    let mut inputs = Vec::new();
    let mut media_references = Vec::new();
    let guest = view.prepared.environment.is_some();
    for &attachment in attachments {
        ensure!(
            attachment["chatId"].as_js_string() == Some(&view.chat),
            "The queued attachment belongs to another chat."
        );
        let metadata = content::open(scope, attachment)?;
        let path = view.turns.attachments.resolve(
            &view.chat,
            text(&metadata["id"])?,
            text(&metadata["fileName"])?,
        )?;
        let location = if guest {
            view.turns
                .guest_files
                .materialize(
                    &view.command["session"]["osExecution"],
                    &metadata,
                    &path,
                    &scope.server,
                    false,
                    &view.turns.encryption,
                )
                .await?
                .0
        } else {
            paths::text(&path)
        };
        let reference = concat(&[
            "- ".into(),
            text(&metadata["fileName"])?.clone(),
            " (".into(),
            text(&metadata["mimeType"])?.clone(),
            format!(", {} bytes): ", metadata["sizeBytes"].stringify()).into(),
            location,
        ]);
        if matches!(metadata["kind"].as_str(), Some("image" | "audio")) {
            let bytes = input_materializer::media::read(&path).await?;
            ensure!(
                bytes.len() as u64 == metadata["sizeBytes"].as_u64().unwrap()
                    && metadata["sha256"] == cantrip_crypto::content::attachment_digest(&bytes),
                "Queued attachment bytes no longer match their authorized metadata."
            );
            let url = format!(
                "data:{};base64,{}",
                text(&metadata["mimeType"])?.lossy(),
                STANDARD.encode(&bytes)
            );
            inputs.push(json!({"type":metadata["kind"],"url":url}));
            if guest {
                media_references.push(reference);
            }
        } else {
            inputs.push(reference_input(reference, guest));
        }
    }
    if !media_references.is_empty() {
        inputs.push(reference_input(join(media_references, "\n"), true));
    }
    scope.identity()?;
    Ok(inputs)
}

fn reference_input(reference: JsString, guest: bool) -> Value {
    let location = if guest {
        "in this Linux workspace"
    } else {
        "on this worker"
    };
    queue::text_input(&concat(&[
        format!("\n\nAttachments are stored outside the repository {location}. Read them from these paths as needed:\n").into(),
        reference,
    ]))
}
