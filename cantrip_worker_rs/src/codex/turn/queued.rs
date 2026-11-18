//! Core-claimed host queue turns use the retained native input when present.
use super::{RPC_TIMEOUT, Runtime};
use crate::{
    attachments::{Store, content},
    chat_content::{Scope, queue},
    filesystem::paths,
    native_items::{array, concat, join, text},
};
use anyhow::{Context, Result, bail};
use cantrip_history::content::Encryption;
use cantrip_wire::{JsString, Value, text::trim, value::json};

pub(super) fn is_queued(command: &Value) -> bool {
    command["queuedPromptId"].is_string()
}

pub(super) fn open(command: &Value, display: &JsString, scope: &Scope) -> Result<Option<Value>> {
    let payload = &command["protectedNativeInput"];
    if payload.is_null() {
        return Ok(None);
    }
    let mut opened = queue::open_native(
        scope,
        &command["chatId"],
        &command["queuedPromptId"],
        payload,
        display,
        array(&command["protectedPrompt"]["classification"]["attachmentIds"])?,
    )?;
    if opened["executionMethod"] != "turn/start" {
        bail!("The protected queued action is not a native turn.");
    }
    if opened["action"] == "parseSlash" {
        opened["input"] = json!(strip_plan(array(&opened["input"])?)?);
    }
    Ok(Some(opened))
}

fn strip_plan(input: &[Value]) -> Result<Vec<Value>> {
    let joined = queue::native_text(input)?;
    let mut remaining = queue::slash_prefix_len(&joined, "/plan")
        .context("This queued slash command has no native model input.")?;
    if JsString::new(joined.units()[remaining..].to_vec())
        .trim()
        .is_empty()
    {
        bail!("This queued slash command has no native model input.");
    }
    let mut output = Vec::new();
    let mut seen_text = false;
    for item in input {
        let mut item = item.clone();
        if item["type"] == "text" {
            if seen_text && remaining > 0 {
                remaining -= 1; // The delimiter in the joined vector is virtual.
            }
            seen_text = true;
            let units = text(&item["text"])?.units();
            let count = remaining.min(units.len());
            remaining -= count;
            if count > 0 {
                if count == units.len() {
                    continue;
                }
                let bytes = JsString::new(units[..count].to_vec()).lossy().len() as u64;
                item["text"] = json!(JsString::new(units[count..].to_vec()));
                if let Some(spans) = item["text_elements"].as_array() {
                    let shifted = spans
                        .iter()
                        .filter_map(|span| {
                            let start = span["byteRange"]["start"].as_u64()?;
                            let end = span["byteRange"]["end"].as_u64()?;
                            let start = start.checked_sub(bytes)?;
                            let mut span = span.clone();
                            span["byteRange"]["start"] = json!(start);
                            span["byteRange"]["end"] =
                                json!(i64::try_from(end).ok()? - bytes as i64);
                            Some(span)
                        })
                        .collect::<Vec<_>>();
                    item["text_elements"] = json!(shifted);
                }
            }
        }
        output.push(item);
    }
    Ok(output)
}

pub(super) async fn inputs(
    command: &Value,
    prompt: &JsString,
    retained: Option<Value>,
    runtime: &Runtime,
    store: &Store,
    keys: &content::ServiceKeys,
    scope: &Scope,
) -> Result<Vec<Value>> {
    let mut attachments = Vec::new();
    for raw in array(&command["attachments"])? {
        if raw["chatId"] != command["chatId"] {
            bail!("The queued attachment belongs to another chat.");
        }
        if retained
            .as_ref()
            .is_some_and(|opened| represented(opened, &raw["id"]))
        {
            continue;
        }
        let metadata = content::open_for(keys, raw, Some((&scope.owner, &scope.server)))?;
        let path = store.resolve(
            text(&metadata["chatId"])?,
            text(&metadata["id"])?,
            text(&metadata["fileName"])?,
        )?;
        attachments.push((metadata, paths::text(&path)));
    }
    let is_retained = retained.is_some();
    let mut input = if let Some(retained) = retained {
        array(&retained["input"])?.to_vec()
    } else {
        Vec::new()
    };
    if is_retained && attachments.is_empty() {
        return Ok(input);
    }
    let mut display = if is_retained {
        JsString::from("")
    } else {
        prompt.clone()
    };
    let images = attachments
        .iter()
        .any(|(metadata, _)| metadata["kind"] == "image");
    let with_images =
        images && supports_images(runtime, &command["model"], &command["provider"]).await;
    if !attachments.is_empty() {
        let references = attachments.iter().map(|(metadata, path)| {
            concat(&[
                "- ".into(),
                metadata["fileName"].as_js_string().unwrap().clone(),
                " (".into(),
                metadata["mimeType"].as_js_string().unwrap().clone(),
                format!(", {} bytes): ", metadata["sizeBytes"].stringify()).into(),
                path.clone(),
            ])
        });
        display = concat(&[
            display,
            "\n\nAttachments are stored outside the repository on this worker. Read them from these paths as needed:\n".into(),
            join(references, "\n"),
            if images && !with_images {
                "\n\nThe selected model is text-only. Image files were not sent as model image input; inspect their listed paths with the current environment tools if needed.".into()
            } else {
                "".into()
            },
        ]);
    }
    scope.identity()?;
    input.push(queue::text_input(&display));
    if with_images {
        input.extend(attachments.into_iter().filter_map(|(metadata, path)| {
            (metadata["kind"] == "image").then(|| json!({"type":"localImage","path":path}))
        }));
    }
    Ok(input)
}

fn represented(opened: &Value, id: &Value) -> bool {
    opened["representedAttachmentIds"]
        .as_array()
        .is_some_and(|ids| ids.contains(id))
        || opened["attachmentMap"]
            .as_array()
            .is_some_and(|entries| entries.iter().any(|entry| &entry["id"] == id))
}

async fn supports_images(runtime: &Runtime, model: &Value, provider: &Value) -> bool {
    let catalog = &model["catalog"];
    if provider["kind"] == "chatgpt"
        || catalog["supportsVision"] == true
        || catalog["inputModalities"]
            .as_array()
            .is_some_and(|modalities| {
                modalities.iter().any(|v| {
                    v.as_str()
                        .is_some_and(|s| trim(s).eq_ignore_ascii_case("image"))
                })
            })
    {
        return true;
    }
    if provider["kind"] == "grok" && catalog["supportsVision"] != false {
        let model = model["name"].as_str().unwrap_or_default();
        let slug = trim(model)
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if slug
            .strip_prefix("grok-4")
            .is_some_and(|suffix| suffix.is_empty() || suffix.starts_with(['.', '-']))
        {
            return true;
        }
    }
    runtime
        .request(
            "model/list".into(),
            Some(json!({"includeHidden":true,"limit":100})),
            Some(RPC_TIMEOUT),
            None,
        )
        .await
        .ok()
        .flatten()
        .is_some_and(|models| {
            models["data"]
                .as_array()
                .and_then(|models| {
                    models.iter().find(|entry| {
                        entry["id"] == model["name"] || entry["model"] == model["name"]
                    })
                })
                .is_some_and(|entry| {
                    entry["inputModalities"]
                        .as_array()
                        .is_some_and(|modalities| modalities.contains(&json!("image")))
                })
        })
}

pub(super) fn deferred(error: &Value) -> bool {
    error["code"].as_f64() == Some(-32001.0)
        && error["data"]["reason"] == "pendingSettings"
        && error["data"]["inputConsumed"] == false
}

#[cfg(test)]
mod tests {
    use super::*;
    use cantrip_wire::parse_json_text;

    #[test]
    fn strips_plan_across_rich_items_and_rebases_byte_spans() {
        let frames = parse_json_text(
            r#"[
            {"type":"text","text":"/plan"},
            {"type":"image","url":"data:image/png;base64,AA=="},
            {"type":"text","text":"\u3000alpha","text_elements":[
                {"byteRange":{"start":0,"end":3}},
                {"byteRange":{"start":3,"end":8},"placeholder":"alpha"}
            ]},
            {"type":"text","text":" tail "}
        ]"#,
        )
        .unwrap();
        let input = array(&frames).unwrap();
        let shifted = strip_plan(input).unwrap();
        assert_eq!(shifted.len(), 3);
        assert_eq!(shifted[0], input[1]);
        assert_eq!(shifted[1], parse_json_text(r#"{"type":"text","text":"alpha","text_elements":[{"byteRange":{"start":0,"end":5},"placeholder":"alpha"}]}"#).unwrap());
        assert_eq!(shifted[2], input[3]);
        assert!(strip_plan(&[queue::text_input(&"/plan \n".into())]).is_err());
    }

    #[test]
    fn only_native_no_consumption_is_a_deferral() {
        let mut error = parse_json_text(r#"{"code":-32001,"message":"pending settings","data":{"reason":"pendingSettings","inputConsumed":false}}"#).unwrap();
        assert!(deferred(&error));
        error["data"]["inputConsumed"] = json!(true);
        assert!(!deferred(&error));
        error["data"] = Value::Null;
        assert!(!deferred(&error));
    }
}
