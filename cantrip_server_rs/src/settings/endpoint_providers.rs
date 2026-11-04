//! Shared endpoint definitions exported from the protocol registry.
use crate::wire::Value;
use serde_json::{Map, Value as Json};
use std::sync::OnceLock;

fn definitions() -> &'static Map<String, Json> {
    static DEFINITIONS: OnceLock<Map<String, Json>> = OnceLock::new();
    DEFINITIONS.get_or_init(|| {
        serde_json::from_str(include_str!("../../contracts/endpoint-providers.json"))
            .expect("generated endpoint definitions")
    })
}

pub fn worker_endpoint_kind(kind: &str) -> bool {
    definitions().contains_key(kind)
}

pub fn label(kind: &str) -> &'static str {
    definitions()
        .get(kind)
        .and_then(|definition| definition["label"].as_str())
        .unwrap_or("Model endpoint")
}

pub fn normalize_model(model: &Value) -> Value {
    let mut result = model.clone();
    let loaded = model["loaded"].clone();
    if let Value::Object(fields) = &mut result {
        fields.shift_remove("loaded");
    }
    result["canonicalModelId"] = Value::Null;
    result["matchConfidenceBasisPoints"] = Value::Null;
    result["rawMetadata"] = Value::object([("loaded", loaded)]);
    result
}

#[cfg(test)]
mod tests {
    #[test]
    fn endpoint_registry_excludes_account_containers_and_preserves_labels() {
        for kind in [
            "ollama",
            "lm-studio",
            "llama-cpp",
            "vllm",
            "unsloth",
            "litellm",
        ] {
            assert!(super::worker_endpoint_kind(kind));
            assert_ne!(super::label(kind), "Model endpoint");
        }
        assert!(!super::worker_endpoint_kind("chatgpt"));
        assert!(!super::worker_endpoint_kind("grok"));
        assert!(!super::worker_endpoint_kind("openai-compatible"));
    }
}
