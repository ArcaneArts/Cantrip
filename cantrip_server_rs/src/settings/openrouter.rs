//! Public catalog metadata; provider secrets never enter public requests.
mod cache;
mod hydrator;
mod service;
pub use cache::{
    CatalogCache, CatalogFailure, CatalogFetcher, CatalogRead, CatalogRefresh, CatalogSnapshot,
    FetchResponse, HttpCatalogFetcher,
};
pub use hydrator::{CatalogLoader, HydrationResult, RuntimeHydrator};
pub use service::CatalogService;

use crate::wire::{JsString, Value};
use indexmap::IndexSet;

pub const GLOBAL_SCOPE: &str = "openrouter:global";

fn text(value: &Value) -> Option<JsString> {
    value
        .as_js_string()
        .map(JsString::trim)
        .filter(|s| !s.is_empty())
}
fn object_field<'a>(value: &'a Value, key: &str) -> &'a Value {
    static NULL: Value = Value::Null;
    if matches!(value, Value::Object(_)) {
        &value[key]
    } else {
        &NULL
    }
}
fn strings(value: &Value) -> Vec<Value> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(text)
        .map(|s| s.lowercase())
        .collect::<IndexSet<_>>()
        .into_iter()
        .map(Value::String)
        .collect()
}
fn positive_integer(value: &Value) -> Option<Value> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && *n > 0.0)
        .map(|n| Value::Number(n.round()))
}
pub fn is_provider(kind: &str, base: &str) -> bool {
    kind == "openai-compatible"
        && url::Url::parse(base)
            .ok()
            .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
            .is_some_and(|host| host == "openrouter.ai" || host.ends_with(".openrouter.ai"))
}
pub fn models_url(base: &str) -> Result<url::Url, CatalogFailure> {
    let mut url = url::Url::parse(base).map_err(|_| CatalogFailure("Invalid URL".into()))?;
    let path = format!("{}/models", url.path().trim_end_matches('/'));
    if !url.cannot_be_a_base() {
        url.set_path(&path);
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}
pub fn parse_payload(payload: &Value) -> Result<Vec<Value>, CatalogFailure> {
    let data = object_field(payload, "data").as_array().ok_or_else(|| {
        CatalogFailure("OpenRouter model catalog response did not contain data.".into())
    })?;
    Ok(data
        .iter()
        .filter_map(|entry| {
            if !matches!(entry, Value::Object(_)) {
                return None;
            }
            let id = text(&entry["id"])?;
            let mut record = entry.clone();
            record["id"] = Value::String(id);
            Some(record)
        })
        .collect())
}
pub fn normalize_model(record: &Value) -> Value {
    let architecture = object_field(record, "architecture");
    let reasoning = object_field(record, "reasoning");
    let top = object_field(record, "top_provider");
    let parameters = strings(&record["supported_parameters"]);
    let efforts = strings(object_field(reasoning, "supported_efforts"));
    let advertised = text(object_field(reasoning, "default_effort")).map(|s| s.lowercase());
    let default = advertised.filter(|s| efforts.contains(&Value::String(s.clone())));
    let input = strings(object_field(architecture, "input_modalities"));
    let output = strings(object_field(architecture, "output_modalities"));
    let tools = parameters
        .iter()
        .any(|p| p == "tools" || p == "tool_choice");
    let supports_reasoning = !efforts.is_empty()
        || parameters
            .iter()
            .any(|p| p == "include_reasoning" || p == "reasoning" || p == "reasoning_effort");
    let efforts = efforts
        .into_iter()
        .map(|effort| {
            let mut description = effort
                .as_js_string()
                .expect("normalized effort")
                .units()
                .to_vec();
            description.extend(" reasoning".encode_utf16());
            Value::object([
                ("effort", effort),
                ("description", Value::String(JsString::new(description))),
            ])
        })
        .collect();
    Value::object([
        ("nativeModelId", record["id"].clone()),
        (
            "canonicalModelId",
            text(&record["canonical_slug"])
                .map(Value::String)
                .unwrap_or_else(|| record["id"].clone()),
        ),
        (
            "displayName",
            text(&record["name"])
                .map(Value::String)
                .unwrap_or_else(|| record["id"].clone()),
        ),
        (
            "description",
            text(&record["description"])
                .map(|s| Value::String(JsString::new(s.units()[..s.len().min(20_000)].to_vec())))
                .unwrap_or(Value::Null),
        ),
        (
            "contextWindow",
            positive_integer(object_field(top, "context_length"))
                .or_else(|| positive_integer(&record["context_length"]))
                .unwrap_or(Value::Null),
        ),
        (
            "maxOutputTokens",
            positive_integer(object_field(top, "max_completion_tokens")).unwrap_or(Value::Null),
        ),
        (
            "supportsVision",
            Value::Bool(input.iter().any(|v| v == "image")),
        ),
        (
            "inputModalities",
            Value::Array(if input.is_empty() {
                vec![Value::String("text".into())]
            } else {
                input
            }),
        ),
        (
            "outputModalities",
            Value::Array(if output.is_empty() {
                vec![Value::String("text".into())]
            } else {
                output
            }),
        ),
        ("supportsTools", Value::Bool(tools)),
        (
            "supportsParallelTools",
            if parameters.iter().any(|p| p == "parallel_tool_calls") {
                Value::Bool(true)
            } else if tools {
                Value::Null
            } else {
                Value::Bool(false)
            },
        ),
        (
            "supportsStructuredOutput",
            Value::Bool(
                parameters
                    .iter()
                    .any(|p| p == "response_format" || p == "structured_outputs"),
            ),
        ),
        ("supportsReasoning", Value::Bool(supports_reasoning)),
        ("supportedReasoningEfforts", Value::Array(efforts)),
        (
            "defaultReasoningEffort",
            default.map(Value::String).unwrap_or(Value::Null),
        ),
        (
            "reasoningMandatory",
            object_field(reasoning, "mandatory")
                .as_bool()
                .map(Value::Bool)
                .unwrap_or(Value::Null),
        ),
        (
            "family",
            text(object_field(architecture, "instruct_type"))
                .or_else(|| text(object_field(architecture, "tokenizer")))
                .map(Value::String)
                .unwrap_or(Value::Null),
        ),
        ("parameterSize", Value::Null),
        ("quantization", Value::Null),
        ("digest", Value::Null),
        ("metadataSource", Value::String("openrouter".into())),
        ("matchConfidenceBasisPoints", Value::Number(10_000.0)),
        ("rawMetadata", record.clone()),
    ])
}
