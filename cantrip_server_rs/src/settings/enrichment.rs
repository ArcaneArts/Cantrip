use crate::wire::{JsString, Value};
use indexmap::IndexSet;

fn identity(value: &Value) -> Option<JsString> {
    value
        .as_js_string()
        .map(|s| s.trim().lowercase())
        .filter(|s| !s.is_empty())
}

pub fn aliases(catalog: &Value, provider_kind: &str) -> IndexSet<JsString> {
    let mut aliases: IndexSet<_> = ["nativeModelId", "canonicalModelId"]
        .iter()
        .filter_map(|key| identity(&catalog[key]))
        .collect();
    let prefix = match provider_kind {
        "chatgpt" => Some("openai/"),
        "grok" => Some("x-ai/"),
        _ => None,
    };
    if let Some(prefix) = prefix {
        let native = catalog["nativeModelId"]
            .as_js_string()
            .expect("catalog native model ID")
            .trim()
            .lowercase();
        let mut units: Vec<_> = prefix.encode_utf16().collect();
        units.extend(native.units());
        aliases.insert(JsString::new(units));
    }
    aliases
}

pub fn enrich(catalog: &Value, provider_kind: &str, candidates: &[Value]) -> Value {
    if catalog.is_null() || catalog["metadataSource"] == "openrouter" {
        return catalog.clone();
    }
    let aliases = aliases(catalog, provider_kind);
    let mut matches = candidates.iter().filter(|candidate| {
        ["nativeModelId", "canonicalModelId"]
            .iter()
            .filter_map(|key| identity(&candidate[key]))
            .any(|key| aliases.contains(&key))
    });
    let Some(source) = matches.next() else {
        return catalog.clone();
    };
    if matches.next().is_some() {
        return catalog.clone();
    }
    let mut output = catalog.clone();
    for key in [
        "description",
        "contextWindow",
        "maxOutputTokens",
        "supportsTools",
        "supportsParallelTools",
        "supportsStructuredOutput",
        "supportsVision",
        "supportsReasoning",
        "family",
    ] {
        if catalog[key].is_null() {
            output[key] = source[key].clone();
        }
    }
    if catalog["supportsVision"].is_null() {
        let modalities: IndexSet<_> = catalog["inputModalities"]
            .as_array()
            .expect("catalog modalities")
            .iter()
            .chain(
                source["inputModalities"]
                    .as_array()
                    .expect("source modalities"),
            )
            .map(|v| v.as_js_string().expect("modality").clone())
            .collect();
        output["inputModalities"] =
            Value::Array(modalities.into_iter().map(Value::String).collect());
    }
    if catalog["outputModalities"]
        .as_array()
        .expect("catalog modalities")
        .is_empty()
    {
        output["outputModalities"] = source["outputModalities"].clone();
    }
    if catalog["matchConfidence"].is_null() {
        output["matchConfidence"] = Value::Number(1.0);
    }
    output
}
