use super::{MAX_MODELS, MAX_SNAPSHOT_BYTES, fetch_json, litellm, normalize};
use crate::{codex::observation::provider::normalize_base_url, metadata::Signal};
use anyhow::{Context, Result, anyhow, bail};
use cantrip_wire::{JsString, Value, coercion, value::json};
use indexmap::IndexMap;
use reqwest::Client;
use std::collections::HashSet;
use url::Url;

#[derive(Clone, Default)]
struct Models {
    entries: IndexMap<JsString, Value>,
    bytes: usize,
}

impl Models {
    fn save(&mut self, value: Value) -> Result<()> {
        let item = crate::http::checked("endpointModelInventoryItemSchema", &value)?;
        let id = item["nativeModelId"].as_js_string().unwrap().clone();
        let previous = self.entries.get(&id);
        let bytes = self.bytes + item.stringify().len() + 1
            - previous.map_or(0, |old| old.stringify().len() + 1);
        if bytes > MAX_SNAPSHOT_BYTES || previous.is_none() && self.entries.len() >= MAX_MODELS {
            bail!("Model catalog exceeded its snapshot limit.");
        }
        self.bytes = bytes;
        self.entries.insert(id, item);
        Ok(())
    }
}

pub(super) async fn discover(client: &Client, provider: &Value, signal: Signal) -> Result<Value> {
    let kind = provider["kind"]
        .as_str()
        .context("Endpoint provider kind")?;
    let base = normalize_base_url(
        provider["baseUrl"]
            .as_str()
            .context("Endpoint provider URL")?,
    )?;
    let base = base.as_str().trim_end_matches('/');
    let key = &provider["apiKey"];
    let observed = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut next =
        Url::parse(&format!("{base}/models")).context("Invalid model catalog endpoint URL.")?;
    if kind == "unsloth" {
        next.query_pairs_mut()
            .append_pair("output_modalities", "all");
    }
    let origin = next.origin();
    let openai = kind == "openai-compatible" && next.host_str() == Some("api.openai.com");
    let normalize = |value: &Value| normalize::model(value, kind, openai, &observed);

    let mut visited = HashSet::new();
    let mut models = Models::default();
    loop {
        signal.check()?;
        if visited.len() >= 256 || !visited.insert(next.clone()) {
            bail!("Model catalog pagination repeated or exceeded its page limit.");
        }
        let data = fetch_json(client, next.clone(), key, None).await?;
        for raw in data["data"]
            .as_array()
            .context("Model catalog did not contain a model list.")?
        {
            let item = normalize(raw).context("Model catalog contains a model without an ID.")?;
            models.save(item)?;
        }
        let continuation =
            normalize::text(&data["links"]["next"]).or_else(|| normalize::text(&data["next"]));
        let Some(continuation) = continuation else {
            if data["has_more"] == true || coercion::truthy(data.get("next_cursor")) {
                bail!("Model catalog is incomplete without a continuation URL.");
            }
            break;
        };
        let url = next
            .join(&continuation.lossy())
            .map_err(|_| anyhow!("Invalid model catalog continuation URL."))?;
        if url.origin() != origin || !url.username().is_empty() || url.password().is_some() {
            bail!("Model catalog continuation changed its endpoint.");
        }
        next = url;
        next.set_fragment(None);
    }

    let mut incomplete = false;
    if matches!(kind, "lm-studio" | "litellm") {
        let standard = models.clone();
        let enrichment: Result<()> = async {
            if kind == "lm-studio" {
                let native = if base.ends_with("/api/v1") {
                    base.to_owned()
                } else {
                    format!("{}/api/v1", base.strip_suffix("/v1").unwrap_or(base))
                };
                let data =
                    fetch_json(client, Url::parse(&format!("{native}/models"))?, key, None).await?;
                let entries = data["models"]
                    .as_array()
                    .context("Native model catalog did not contain a model list.")?;
                for raw in entries {
                    let item = normalize(raw)
                        .context("Native model catalog contains a model without an ID.")?;
                    let item = match models
                        .entries
                        .get(item["nativeModelId"].as_js_string().unwrap())
                    {
                        Some(existing) => normalize::studio_overlay(existing, &item),
                        None => item,
                    };
                    models.save(item)?;
                }
            } else {
                let data = fetch_json(
                    client,
                    Url::parse(&format!("{base}/model/info"))?,
                    key,
                    None,
                )
                .await?;
                for item in litellm::overlay(&data, &standard.entries, &observed)? {
                    models.save(item)?;
                }
            }
            Ok(())
        }
        .await;
        if enrichment.is_err() {
            signal.check()?;
            models = standard;
            incomplete = true;
        }
    }
    let mut value = json!({"kind":"endpoint","models":models.entries.into_values().collect::<Vec<_>>(),"observedAt":observed});
    if incomplete {
        value["metadataIncomplete"] = json!(true);
    }
    Ok(value)
}
