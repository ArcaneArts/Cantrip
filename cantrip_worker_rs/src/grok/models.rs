use crate::http::checked;
use anyhow::Result;
use cantrip_wire::{JsString, Value, value::json};
use indexmap::{IndexMap, IndexSet};

pub(super) fn inventory(payload: &Value, observed_at: String) -> Result<Value> {
    let mut models: Vec<Value> = payload["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(normalize)
        .collect();
    if !models.iter().any(|row| row["isDefault"] == true)
        && let Some(first) = models.iter_mut().find(|row| row["hidden"] == false)
    {
        first["isDefault"] = json!(true);
    }
    checked(
        "grokModelInventorySchema",
        &json!({"models":models,"observedAt":observed_at}),
    )
}

fn string(value: &Value, names: &[&str]) -> Option<JsString> {
    names
        .iter()
        .filter_map(|key| value[*key].as_js_string())
        .map(JsString::trim)
        .find(|field| !field.is_empty())
}

fn positive_number(value: &Value, names: &[&str]) -> Option<i64> {
    names
        .iter()
        .filter_map(|key| value[*key].as_i64())
        .find(|value| value.unsigned_abs() <= 9_007_199_254_740_991)
        .filter(|value| *value > 0)
}

fn boolean(value: &Value, names: &[&str]) -> Option<bool> {
    names.iter().find_map(|key| value[*key].as_bool())
}

fn modalities(input: &[&Value], names: &[&str]) -> IndexSet<JsString> {
    input
        .iter()
        .filter_map(|value| names.iter().find_map(|key| value[*key].as_array()))
        .map(|array| {
            array
                .iter()
                .filter_map(Value::as_js_string)
                .map(JsString::trim)
                .filter(|value| !value.is_empty())
                .map(|value| value.lowercase())
                .collect::<IndexSet<_>>()
        })
        .find(|modes| !modes.is_empty())
        .unwrap_or_default()
}

fn efforts(value: &Value, meta: &Value) -> Vec<Value> {
    let raw = [
        &value["reasoningEfforts"],
        &value["reasoning_efforts"],
        &meta["reasoningEfforts"],
        &meta["reasoning_efforts"],
    ]
    .into_iter()
    .find(|field| !field.is_null())
    .and_then(Value::as_array);
    let mut result = IndexMap::new();
    for item in raw.into_iter().flatten() {
        if let Some(text) = item.as_js_string().map(JsString::trim) {
            if !text.is_empty() {
                result.insert(text, None);
            }
        } else if let Some(effort) = string(item, &["value", "effort", "id"]) {
            result.insert(effort, string(item, &["description", "label"]));
        }
    }
    result
        .into_iter()
        .map(|(effort, description)| json!({"effort":effort,"description":description}))
        .collect()
}

fn normalize(value: &Value) -> Option<Value> {
    if !value.is_object() {
        return None;
    }
    let meta = &value["_meta"];
    let ids = ["model", "modelId", "id"];
    let id = string(value, &ids).or_else(|| string(meta, &ids))?;
    let inputs = [value, meta, &value["architecture"], &meta["architecture"]];
    let mut input = modalities(&inputs, &["inputModalities", "input_modalities"]);
    let mut output = modalities(&inputs, &["outputModalities", "output_modalities"]);
    let direct = [
        "supportsVision",
        "supports_vision",
        "supportsImageInput",
        "supports_image_input",
    ];
    let nested = ["vision", "image", "imageInput", "image_input"];
    let vision = boolean(value, &direct)
        .or_else(|| boolean(meta, &direct))
        .or_else(|| boolean(&value["capabilities"], &nested))
        .or_else(|| boolean(&meta["capabilities"], &nested));
    if input.is_empty() {
        input.insert("text".into());
    }
    if vision == Some(true) {
        input.insert("image".into());
    }
    if output.is_empty() {
        output.insert("text".into());
    }
    let reasoning_keys = ["reasoningEffort", "reasoning_effort"];
    let reasoning_flags = ["supportsReasoningEffort", "supports_reasoning_effort"];
    let reasoning_default =
        string(value, &reasoning_keys).or_else(|| string(meta, &reasoning_keys));
    let efforts = efforts(value, meta);
    let reasoning = boolean(value, &reasoning_flags)
        .or_else(|| boolean(meta, &reasoning_flags))
        .unwrap_or(reasoning_default.is_some() || !efforts.is_empty());
    Some(json!({
        "id":id,"displayName":string(value, &["name","displayName"]).unwrap_or_else(|| id.clone()),
        "description":string(value, &["description"]),
        "contextWindow":positive_number(value, &["contextWindow","context_window"])
            .or_else(|| positive_number(meta, &["contextWindow","totalContextTokens"])),
        "maxOutputTokens":positive_number(value, &["maxCompletionTokens","max_completion_tokens","maxOutputTokens","max_output_tokens"]),
        "inputModalities":input.into_iter().collect::<Vec<_>>(),
        "outputModalities":output.into_iter().collect::<Vec<_>>(),
        "supportedReasoningEfforts":efforts,"defaultReasoningEffort":reasoning_default,"supportsReasoning":reasoning,
        "hidden":boolean(value, &["hidden"]).or_else(|| boolean(meta, &["hidden"])).unwrap_or(false),
        "isDefault":boolean(value, &["isDefault","is_default"]).unwrap_or(false),"rawMetadata":value
    }))
}
