use super::litellm;
use cantrip_wire::{JsString, Value, value::json};
use indexmap::IndexSet;

pub(super) const OPERATIONS: [(&str, &str); 3] = [
    ("language", "text"),
    ("embedding", "embeddings"),
    ("decision", "decisions"),
];

pub(super) fn text(value: &Value) -> Option<JsString> {
    value
        .as_js_string()
        .map(JsString::trim)
        .filter(|value| !value.is_empty())
}

pub(super) fn positive(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .filter(|value| (1..=9_007_199_254_740_991).contains(value))
}

fn boolean(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(value) => Some(*value),
        _ => None,
    }
}

pub(super) fn either<'a>(preferred: &'a Value, fallback: &'a Value) -> &'a Value {
    if preferred.is_null() {
        fallback
    } else {
        preferred
    }
}

fn strings(value: &Value) -> IndexSet<JsString> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(text)
        .map(|text| text.lowercase())
        .collect()
}

pub(super) fn add_modalities(modalities: &mut IndexSet<JsString>, value: &Value) {
    modalities.extend(
        value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_js_string)
            .cloned(),
    );
}

pub(super) fn preserve_outputs(outputs: &mut IndexSet<JsString>, operations: &Value) {
    for (operation, modality) in OPERATIONS {
        if operations[operation]["status"] == "supported" {
            outputs.insert(modality.into());
        }
    }
}

pub(super) fn keyed_capability(source: &str, supported: bool) -> Value {
    json!({"status":if supported { "supported" } else { "unknown" },"source":source})
}

fn registered_openai(model: &JsString) -> Value {
    let source = "registry:v1:openai";
    let unsupported = json!({"status":"unsupported","source":source});
    let embedding = match model.as_str() {
        Some("text-embedding-3-small") => Some((1536, true)),
        Some("text-embedding-3-large") => Some((3072, true)),
        Some("text-embedding-ada-002") => Some((1536, false)),
        _ => None,
    };
    if let Some((dimensions, configurable)) = embedding {
        return json!({
            "language":unsupported,"decision":unsupported,
            "embedding":json!({"status":"supported","source":source,"adapter":"openai-embeddings",
                "inputModalities":vec!["text"],"dimensions":dimensions,"configurableDimensions":configurable,
                "vectorRepresentation":"dense","maxInputTokens":8192}),
        });
    }
    if model.as_str() == Some("gpt-6-luna") {
        return json!({
            "language":json!({"status":"supported","source":source,"inputModalities":vec!["text","image"]}),
            "embedding":unsupported,
            "decision":json!({"status":"supported","source":source,"adapter":"openai-decisions",
                "inputModalities":vec!["text","image","json"],"questionTypes":vec!["predicate","choice","score"],
                "maxQuestions":400}),
        });
    }
    let unknown = keyed_capability(source, false);
    json!({"language":unknown,"embedding":unknown,"decision":unknown})
}

pub(super) fn model(raw: &Value, kind: &str, openai: bool, observed: &str) -> Option<Value> {
    let id = text(&raw["id"]).or_else(|| text(&raw["key"]))?;
    let vision = [
        &raw["capabilities"]["vision"],
        &raw["supports_vision"],
        &raw["has_vision_adapter"],
    ]
    .into_iter()
    .find_map(boolean);
    let mut inputs = strings(either(
        &raw["architecture"]["input_modalities"],
        &raw["input_modalities"],
    ));
    let mut outputs = strings(either(
        &raw["architecture"]["output_modalities"],
        &raw["output_modalities"],
    ));
    let model_type = raw["type"].as_js_string().map(JsString::lowercase);
    let model_type = model_type.as_ref().and_then(JsString::as_str);
    let embedding_type = matches!(model_type, Some("embedding" | "embeddings"));
    let inferred = match model_type {
        Some("llm" | "vlm") => Some("text"),
        Some("embedding" | "embeddings") => Some("embeddings"),
        Some("decision") => Some("decisions"),
        _ => None,
    };
    if let Some(output) = inferred {
        if outputs.is_empty() {
            outputs.insert(output.into());
        }
        if inputs.is_empty() {
            inputs.insert("text".into());
            if model_type == Some("vlm")
                || !embedding_type
                    && [
                        &raw["capabilities"]["vision"],
                        &raw["supports_vision"],
                        &raw["has_vision_adapter"],
                    ]
                    .into_iter()
                    .any(|value| value == &Value::Bool(true))
            {
                inputs.insert("image".into());
            }
        }
    }
    let mut operations = json!({});
    if !outputs.is_empty() {
        let input_modalities =
            (!inputs.is_empty()).then(|| inputs.iter().cloned().collect::<Vec<_>>());
        for (operation, modality) in OPERATIONS {
            let mut capability = json!({
                "status":if outputs.contains(&JsString::from(modality)) {"supported"} else {"unsupported"},
                "source":"compatible-api","inputModalities":input_modalities,
            });
            if operation == "embedding" {
                capability["adapter"] = json!("openai-embeddings");
            }
            operations[operation] = capability;
        }
    }
    if kind == "unsloth" && text(&raw["task"]).is_some() {
        for (operation, _) in OPERATIONS {
            if operations.get(operation).is_none() {
                operations[operation] = keyed_capability("unsloth-catalog", false);
            }
        }
    }
    if kind == "litellm" {
        for (operation, capability) in litellm::capabilities(raw, observed) {
            if capability["status"] == "supported" || operations.get(operation).is_none() {
                operations[operation] = capability;
            }
        }
    }
    if openai {
        let fallback = registered_openai(&id);
        for (operation, _) in OPERATIONS {
            if operations.get(operation).is_none() {
                operations[operation] = fallback[operation].clone();
            }
        }
    }
    preserve_outputs(&mut outputs, &operations);
    if inputs.is_empty()
        && let Some(fields) = operations.as_object()
    {
        for capability in fields
            .values()
            .filter(|value| value["status"] == "supported")
        {
            add_modalities(&mut inputs, &capability["inputModalities"]);
        }
    }
    if operations["decision"]["status"] == "supported" {
        let adapter = match kind {
            "lm-studio" | "litellm" => Some("openai-decisions"),
            "llama-cpp" | "vllm" | "unsloth" => Some("system-one"),
            _ => None,
        };
        if let Some(adapter) = adapter {
            operations["decision"]["adapter"] = json!(adapter);
        }
    }
    if operations["embedding"]["status"] == "supported" {
        if let Some(digest) = text(&raw["digest"]) {
            operations["embedding"]["modelRevision"] = json!(digest);
        }
        if kind == "vllm" {
            operations["embedding"]["adapter"] = json!("vllm-embeddings");
        }
    }
    if let Value::Object(fields) = &mut operations {
        for value in fields.values_mut() {
            value["observedAt"] = json!(observed);
        }
    }
    if inputs.is_empty()
        && let Some(vision) = vision
    {
        inputs.insert("text".into());
        if vision {
            inputs.insert("image".into());
        }
    }
    let instances = raw["loaded_instances"].as_array();
    let loaded_context = instances
        .and_then(|values| values.first())
        .and_then(|model| positive(&model["config"]["context_length"]));
    let reasoning = &raw["capabilities"]["reasoning"];
    let efforts = reasoning["allowed_options"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|value| value.as_js_string().is_some_and(|text| !text.is_empty()))
        .map(|value| json!({"effort":value,"description":Value::Null}))
        .collect::<Vec<_>>();
    let normalized = json!({
        "nativeModelId":id,"operationCapabilities":operations,
        "displayName":text(&raw["display_name"]).or_else(|| text(&raw["name"])).unwrap_or(id),
        "description":text(&raw["description"]),
        "contextWindow":loaded_context.or_else(|| [&raw["max_context_length"],
            &raw["context_length"], &raw["max_model_len"], &raw["meta"]["n_ctx_train"]].into_iter().find_map(positive)),
        "maxOutputTokens":positive(&raw["max_output_tokens"]),
        "inputModalities":inputs.into_iter().collect::<Vec<_>>(),
        "outputModalities":outputs.into_iter().collect::<Vec<_>>(),
        "supportsTools":boolean(&raw["capabilities"]["trained_for_tool_use"]).or_else(|| boolean(&raw["supports_tool_calling"])),
        "supportsParallelTools":boolean(&raw["supports_parallel_tool_calls"]),
        "supportsStructuredOutput":boolean(&raw["supports_structured_output"]),
        "supportsVision":vision,
        "supportsReasoning":if reasoning.as_object().is_some_and(|fields| !fields.is_empty()) {Some(true)} else {boolean(&raw["supports_reasoning"])},
        "supportedReasoningEfforts":efforts,"defaultReasoningEffort":text(&reasoning["default"]),
        "reasoningMandatory":Value::Null,
        "family":text(&raw["architecture"]).or_else(|| text(&raw["family"])),
        "parameterSize":text(&raw["params_string"]),
        "quantization":text(&raw["quantization"]["name"]).or_else(|| text(&raw["quantization"])),
        "digest":Value::Null,"metadataSource":"compatible-api",
        "loaded":boolean(&raw["loaded"]).or_else(|| instances.map(|models| !models.is_empty())),
    });
    Some(normalized)
}

pub(super) fn studio_overlay(standard: &Value, rich: &Value) -> Value {
    let mut output = standard.clone();
    if let (Value::Object(output), Some(fields)) = (&mut output, rich.as_object()) {
        for (name, value) in fields {
            if !value.is_null() && !value.as_array().is_some_and(Vec::is_empty) {
                output.insert(name.clone(), value.clone());
            }
        }
    }
    if rich["displayName"] == rich["nativeModelId"] {
        output["displayName"] = standard["displayName"].clone();
    }
    output["operationCapabilities"] = merged(
        &standard["operationCapabilities"],
        &rich["operationCapabilities"],
    );
    if rich["supportsVision"].is_null() {
        let mut inputs = IndexSet::new();
        add_modalities(&mut inputs, &standard["inputModalities"]);
        add_modalities(&mut inputs, &rich["inputModalities"]);
        output["inputModalities"] = json!(inputs.into_iter().collect::<Vec<_>>());
    }
    output
}

pub(super) fn merged(earlier: &Value, later: &Value) -> Value {
    Value::object(
        earlier
            .as_object()
            .into_iter()
            .flatten()
            .chain(later.as_object().into_iter().flatten())
            .map(|(name, value)| (name.clone(), value.clone())),
    )
}
