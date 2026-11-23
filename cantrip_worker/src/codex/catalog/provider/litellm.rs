use super::normalize::{
    OPERATIONS, add_modalities, either, keyed_capability, merged, positive, preserve_outputs, text,
};
use anyhow::{Context, Result, bail};
use cantrip_wire::{JsString, Value, coercion, value::json};
use indexmap::{IndexMap, IndexSet};

pub(super) fn capabilities(raw: &Value, observed: &str) -> IndexMap<&'static str, Value> {
    let info = &raw["model_info"];
    let mode = either(&info["mode"], &raw["mode"]);
    let declared = either(&info["supported_endpoints"], &raw["supported_endpoints"]);
    let endpoints = declared
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_js_string)
        .map(JsString::lowercase)
        .collect::<Vec<_>>();
    let advertises = |suffixes: &[&str]| {
        endpoints.iter().any(|endpoint| {
            endpoint.as_str().is_some_and(|endpoint| {
                let endpoint = endpoint.trim_end_matches('/');
                suffixes.iter().any(|suffix| endpoint.ends_with(suffix))
            })
        })
    };
    let language = mode == "chat"
        || mode == "completion"
        || advertises(&[
            "/chat/completions",
            "/completions",
            "/responses",
            "/messages",
        ]);
    let embedding = mode == "embedding" || advertises(&["/embeddings"]);
    let decision =
        mode == "evaluation" || mode == "decisions" || advertises(&["/decisions", "/systemone"]);
    if !language && !embedding && !decision && !mode.is_string() && !declared.is_array() {
        return IndexMap::new();
    }
    let mut operations = IndexMap::new();
    for (operation, supported) in [
        ("language", language),
        ("embedding", embedding),
        ("decision", decision),
    ] {
        let mut capability = keyed_capability("litellm-catalog", supported);
        capability["observedAt"] = json!(observed);
        operations.insert(operation, capability);
    }
    if embedding {
        operations["embedding"]["adapter"] = json!("openai-embeddings");
        operations["embedding"]["maxInputTokens"] = json!(positive(either(
            &info["max_input_tokens"],
            &raw["max_input_tokens"]
        )));
    }
    if decision {
        let mut inputs = vec!["text", "json"];
        if info["supports_audio_input"] == true {
            inputs.push("audio");
        }
        if info["supports_video_input"] == true {
            inputs.push("video");
        }
        operations["decision"]["adapter"] = json!("openai-decisions");
        operations["decision"]["inputModalities"] = json!(inputs);
        operations["decision"]["questionTypes"] = json!(vec!["predicate", "choice", "score"]);
    }
    operations
}

/// Native deployments contribute compatible metadata only through aliases in
/// the authenticated standard list. No deployment payload crosses the wire.
pub(super) fn overlay(
    raw: &Value,
    visible: &IndexMap<JsString, Value>,
    observed: &str,
) -> Result<Vec<Value>> {
    if raw["has_more"] == true
        || coercion::truthy(raw.get("next_cursor"))
        || coercion::truthy(raw.get("next"))
    {
        bail!("Native gateway metadata did not contain a complete model list.");
    }
    let entries = raw["data"]
        .as_array()
        .context("Native gateway metadata did not contain a complete model list.")?;
    let mut groups = IndexMap::<_, Vec<_>>::new();
    for entry in entries {
        let alias = &entry["model_name"];
        if text(alias).is_none() {
            bail!("Native gateway metadata contains a deployment without a public model name.");
        }
        let alias = alias.as_js_string().unwrap();
        if visible.contains_key(alias) {
            groups
                .entry(alias.clone())
                .or_default()
                .push(capabilities(entry, observed));
        }
    }
    Ok(groups
        .into_iter()
        .map(|(alias, entries)| {
            let standard = &visible[&alias];
            let mut model = standard.clone();
            let operations = &mut model["operationCapabilities"];
            for (operation, _) in OPERATIONS {
                let listed = entries
                    .iter()
                    .filter_map(|entry| entry.get(operation))
                    .collect::<Vec<_>>();
                let supported = listed
                    .iter()
                    .copied()
                    .filter(|entry| entry["status"] == "supported")
                    .collect::<Vec<_>>();
                if let Some(first) = supported.first() {
                    let mut capability = merged(&operations[operation], first);
                    if supported.iter().all(|value| {
                        value["inputModalities"]
                            .as_array()
                            .is_some_and(|inputs| !inputs.is_empty())
                    }) {
                        let mut inputs = IndexSet::new();
                        for value in &supported {
                            add_modalities(&mut inputs, &value["inputModalities"]);
                        }
                        capability["inputModalities"] =
                            json!(inputs.into_iter().collect::<Vec<_>>());
                    } else {
                        capability["inputModalities"] =
                            operations[operation]["inputModalities"].clone();
                    }
                    if operation == "embedding" {
                        let known = supported
                            .iter()
                            .map(|value| positive(&value["maxInputTokens"]))
                            .collect::<Option<Vec<_>>>();
                        capability["maxInputTokens"] = known
                            .and_then(|limits| limits.into_iter().min())
                            .map_or_else(
                                || {
                                    standard["operationCapabilities"]["embedding"]["maxInputTokens"]
                                        .clone()
                                },
                                |limit| json!(limit),
                            );
                    }
                    operations[operation] = capability;
                } else if operations.get(operation).is_none()
                    && let Some(first) = listed.first()
                {
                    operations[operation] = (*first).clone();
                }
            }
            let mut inputs = IndexSet::new();
            add_modalities(&mut inputs, &standard["inputModalities"]);
            if let Some(fields) = operations.as_object() {
                for capability in fields
                    .values()
                    .filter(|value| value["status"] == "supported")
                {
                    add_modalities(&mut inputs, &capability["inputModalities"]);
                }
            }
            let mut outputs = IndexSet::new();
            add_modalities(&mut outputs, &standard["outputModalities"]);
            preserve_outputs(&mut outputs, operations);
            model["inputModalities"] = json!(inputs.into_iter().collect::<Vec<_>>());
            model["outputModalities"] = json!(outputs.into_iter().collect::<Vec<_>>());
            model
        })
        .collect())
}
