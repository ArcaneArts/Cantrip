use super::{endpoint_providers, ollama, parse_response};
use crate::{
    wire::{JsString, Value},
    workers::command_bus::LimitedCommandBus,
};
use anyhow::{Context, Result};
use std::{
    collections::HashSet,
    sync::Arc,
    time::{Duration, Instant},
};

/// Collect a complete immutable snapshot before catalog reconciliation can mark
/// any missing model unavailable. A failed page leaves the saved catalog intact.
pub(super) struct CatalogRead {
    pub models: Vec<Value>,
    pub metadata_incomplete: bool,
}

pub(super) async fn read(
    commands: &Arc<LimitedCommandBus>,
    worker: &str,
    runtime: Value,
    is_ollama: bool,
) -> Result<CatalogRead> {
    let deadline = Instant::now() + Duration::from_secs(120);
    let kind = if is_ollama { "ollama" } else { "endpoint" };
    let transfer_id = uuid::Uuid::new_v4().to_string();
    let mut snapshot: Option<(JsString, JsString, i64, bool)> = None;
    let mut offset = 0_i64;
    let mut bytes = 0_usize;
    let mut models = Vec::new();
    let mut names = HashSet::new();
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .context("Model catalog transfer timed out.")?;
        let mut page_request = Value::object([
            ("offset", Value::Number(offset as f64)),
            ("transferId", Value::String(transfer_id.clone().into())),
        ]);
        if let Some((id, _, _, _)) = &snapshot {
            page_request["snapshotId"] = Value::String(id.clone());
        }
        let result = commands
            .request(
                worker,
                Value::object([
                    (
                        "type",
                        Value::String(
                            if is_ollama {
                                "model.ollama.catalog"
                            } else {
                                "model.endpoint.catalog"
                            }
                            .into(),
                        ),
                    ),
                    ("provider", runtime.clone()),
                    ("catalogPage", page_request),
                ]),
                Some(remaining),
                None,
            )
            .await?;
        if result
            .as_ref()
            .is_none_or(|result| result.get("snapshotId").is_none())
        {
            anyhow::ensure!(snapshot.is_none(), "Model catalog pagination disappeared.");
            let inventory = parse_response(
                if is_ollama {
                    "ollamaModelInventorySchema"
                } else {
                    "endpointModelInventorySchema"
                },
                result.as_ref(),
            )?;
            let models = inventory["models"]
                .as_array()
                .context("validated legacy inventory")?
                .iter()
                .map(|model| {
                    if is_ollama {
                        ollama::normalize_model(model)
                    } else {
                        endpoint_providers::normalize_model(model)
                    }
                })
                .collect();
            return Ok(CatalogRead {
                models,
                metadata_incomplete: !is_ollama && inventory["metadataIncomplete"] == true,
            });
        }
        let page = parse_response("modelCatalogPageSchema", result.as_ref())?;
        let id = page["snapshotId"]
            .as_js_string()
            .context("snapshot ID")?
            .clone();
        let observed = page["observedAt"]
            .as_js_string()
            .context("snapshot observation")?
            .clone();
        let total = page["total"].as_i64().context("snapshot total")?;
        let incomplete = !is_ollama && page["metadataIncomplete"] == true;
        anyhow::ensure!(
            page["kind"] == kind
                && page["transferId"] == transfer_id.as_str()
                && page["offset"].as_i64() == Some(offset)
                && snapshot.as_ref().is_none_or(
                    |previous| previous == &(id.clone(), observed.clone(), total, incomplete)
                ),
            "Model catalog page belongs to another snapshot."
        );
        snapshot = Some((id, observed, total, incomplete));
        let page_bytes = page.stringify().len();
        anyhow::ensure!(
            page_bytes <= 2 * 1024 * 1024,
            "Model catalog page exceeded its byte limit."
        );
        bytes += page_bytes;
        anyhow::ensure!(
            bytes <= 32 * 1024 * 1024 + 64 * 1024,
            "Model catalog transfer exceeded its byte limit."
        );
        let batch = page["models"]
            .as_array()
            .context("validated catalog page")?;
        for model in batch {
            let normalized = if is_ollama {
                ollama::normalize_model(model)
            } else {
                endpoint_providers::normalize_model(model)
            };
            let name = normalized["nativeModelId"]
                .as_js_string()
                .context("normalized model ID")?
                .clone();
            anyhow::ensure!(names.insert(name), "Model catalog repeated a model.");
            models.push(normalized);
        }
        offset += i64::try_from(batch.len())?;
        if page["nextOffset"].is_null() {
            anyhow::ensure!(
                offset == total,
                "Model catalog ended before its complete snapshot."
            );
            return Ok(CatalogRead {
                models,
                metadata_incomplete: incomplete,
            });
        }
        anyhow::ensure!(
            !batch.is_empty() && page["nextOffset"].as_i64() == Some(offset) && offset < total,
            "Model catalog pagination did not advance."
        );
    }
}
