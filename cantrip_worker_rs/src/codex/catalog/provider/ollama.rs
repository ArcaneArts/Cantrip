use super::{MAX_MODELS, MAX_SNAPSHOT_BYTES, fetch_json, normalize};
use crate::{http::checked, logging::Logs, metadata::Signal};
use anyhow::{Context, Result, anyhow, bail};
use cantrip_wire::{JsString, Value, date, value::json};
use futures::{StreamExt, stream};
use indexmap::IndexSet;
use reqwest::Client;
use std::time::Instant;
use url::Url;

const SHOW_CONCURRENCY: usize = 4;

pub(super) async fn discover(
    client: &Client,
    provider: &Value,
    signal: Signal,
    logs: &Logs,
) -> Result<Value> {
    let base = provider["baseUrl"]
        .as_str()
        .context("Ollama provider URL")?;
    let api = api_url(base)?;
    let origin = api.origin().ascii_serialization();
    let began = Instant::now();
    let mut context = json!({
        "event":"provider.catalog.refresh-started","subsystem":"provider-catalog",
        "operation":"ollama-catalog","status":"started","providerKind":"ollama",
        "endpointOrigin":origin,
    });
    logs.event(
        "debug",
        "Ollama model catalog refresh began",
        context.clone(),
    );
    let result = inventory(client, &api, &provider["apiKey"], signal).await;
    context["durationMs"] = json!(began.elapsed().as_millis() as u64);
    match &result {
        Ok(inventory) => {
            context["event"] = json!("provider.catalog.refresh-completed");
            context["status"] = json!("completed");
            context["counts"] = json!({"models":inventory["models"].as_array().unwrap().len()});
            logs.event("info", "Ollama model catalog refreshed", context);
        }
        Err(error) => {
            context["event"] = json!("provider.catalog.refresh-failed");
            context["status"] = json!("failed");
            context["reasonCode"] = json!("request-failed");
            context["error"] = crate::logging::error(error);
            logs.repeated(
                format!("ollama-catalog-failed:{origin}"),
                "warn",
                "Ollama model catalog refresh failed",
                context,
            );
        }
    }
    result
}

fn api_url(raw: &str) -> Result<Url> {
    let mut url = Url::parse(raw).map_err(|_| anyhow!("Invalid Ollama provider base URL."))?;
    let path = url.path();
    let without_final_slash = path.strip_suffix('/').unwrap_or(path);
    let path = without_final_slash
        .strip_suffix("/api")
        .or_else(|| without_final_slash.strip_suffix("/v1"))
        .unwrap_or(path)
        .trim_end_matches('/');
    let path = format!("{path}/api/");
    url.set_path(&path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

async fn inventory(client: &Client, api: &Url, key: &Value, signal: Signal) -> Result<Value> {
    let mut payload = fetch_json(client, api.join("tags")?, key, None).await?;
    let tags = match &mut payload {
        Value::Object(fields) => fields.get_mut("models"),
        _ => None,
    };
    let Some(Value::Array(tags)) = tags else {
        bail!("Ollama tags response did not contain a model list.");
    };
    let tags = std::mem::take(tags).into_iter().filter_map(|tag| {
        normalize::text(&tag["model"])
            .or_else(|| normalize::text(&tag["name"]))
            .map(|name| (name, tag))
    });
    let tags = tags.take(MAX_MODELS + 1).collect::<Vec<_>>();
    if tags.len() > MAX_MODELS {
        bail!("Model catalog exceeded the model count limit.");
    }
    let show = api.join("show")?;
    let mut reads = stream::iter(tags.into_iter().enumerate().map(|(index, (name, tag))| {
        let show = show.clone();
        let signal = signal.clone();
        async move {
            signal.check()?;
            let detail = fetch_json(
                client,
                show,
                key,
                Some(json!({"model":name,"verbose":false})),
            )
            .await?;
            Ok::<_, anyhow::Error>((index, model(&name, &tag, &detail)?))
        }
    }))
    .buffer_unordered(SHOW_CONCURRENCY);
    let mut models = Vec::new();
    let mut bytes = 0;
    while let Some(read) = reads.next().await {
        let (index, model) = read?;
        bytes += model.stringify().len() + 1;
        if bytes > MAX_SNAPSHOT_BYTES {
            bail!("Model catalog exceeded its snapshot byte limit.");
        }
        models.push((index, model));
    }
    models.sort_unstable_by_key(|(index, _)| *index);
    Ok(json!({
        "kind":"ollama","models":models.into_iter().map(|(_, model)| model).collect::<Vec<_>>(),
        "observedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    }))
}

fn model(name: &JsString, tag: &Value, show: &Value) -> Result<Value> {
    let detail = if show["details"].as_object().is_some() {
        &show["details"]
    } else {
        &tag["details"]
    };
    let modified = normalize::text(normalize::either(&show["modified_at"], &tag["modified_at"]))
        .and_then(|stamp| date::parse(&stamp))
        .and_then(date::iso_milliseconds);
    let size = tag["size"]
        .as_f64()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(f64::round);
    let capabilities = strings(&show["capabilities"])
        .into_iter()
        .map(|value| value.lowercase())
        .collect::<Vec<_>>();
    let mut item = json!({
        "name":name,"modifiedAt":modified,"sizeBytes":size,"digest":normalize::text(&tag["digest"]),
        "family":normalize::text(&detail["family"]),"families":strings(&detail["families"]),
        "parameterSize":normalize::text(&detail["parameter_size"]),
        "quantization":normalize::text(&detail["quantization_level"]),
        "capabilities":capabilities,"modelInfo":{},
    });
    if show["model_info"].as_object().is_some() {
        item["modelInfo"] = show["model_info"].clone();
    }
    checked("ollamaModelInventoryItemSchema", &item)
}

fn strings(value: &Value) -> Vec<JsString> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(normalize::text)
        .collect::<IndexSet<_>>()
        .into_iter()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{codex::catalog::provider::snapshot::Store, metadata::Abort};
    use std::sync::Arc;

    #[tokio::test]
    async fn legacy_response_retains_normalized_ollama_metadata() -> Result<()> {
        let store = Arc::new(Store::default());
        let (_abort, signal) = Abort::new();
        let item = model(
            &"gemma:12b".into(),
            &json!({"modified_at":"2026-08-14T12:00:00.123456789Z","size":7_000_000_000.5}),
            &json!({
                "capabilities":["Completion","Vision"],
                "model_info":json!({"gemma.context_length":131072}),
                "details":json!({"families":["gemma"," gemma ","multimodal"]}),
            }),
        )?;
        let inventory = store
            .read("ollama".into(), None, signal, |_| async move {
                Ok(json!({"kind":"ollama","observedAt":"2026-01-01T00:00:00.000Z","models":[item]}))
            })
            .await?;
        assert!(inventory.get("kind").is_none());
        assert!(inventory.get("snapshotId").is_none());
        let models = inventory["models"].as_array().unwrap();
        assert_eq!(models.len(), 1);
        let model = &models[0];
        assert_eq!(model["name"], "gemma:12b");
        assert_eq!(model["modifiedAt"], "2026-08-14T12:00:00.123Z");
        assert_eq!(model["sizeBytes"], json!(7_000_000_001_u64));
        assert_eq!(model["families"], json!(["gemma", "multimodal"]));
        assert_eq!(model["capabilities"], json!(["completion", "vision"]));
        assert_eq!(model["modelInfo"]["gemma.context_length"], json!(131072));
        Ok(())
    }
}
