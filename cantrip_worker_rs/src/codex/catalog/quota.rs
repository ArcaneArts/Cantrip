use super::*;
use cantrip_wire::coercion;
use indexmap::IndexMap;

pub(super) fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn snapshot(
    result: &Value,
    worker_version: &Value,
    codex_version: &Value,
    id: &str,
    observed: &str,
) -> Result<Value> {
    let limits = &result["rateLimitsByLimitId"];
    let canonical = result
        .get("rateLimits")
        .filter(|v| !v.is_null())
        .or_else(|| limits.get("codex").filter(|v| !v.is_null()));
    let canonical_limit = canonical
        .map(|value| label(&value["limitId"]))
        .transpose()?
        .flatten()
        .unwrap_or_else(|| "codex".into());
    let mut buckets = IndexMap::new();
    if let Value::Object(entries) = limits {
        buckets.extend(
            coercion::entries(entries)
                .into_iter()
                .map(|(key, value)| (key.clone(), value)),
        );
    }
    if let Some(canonical) = canonical {
        buckets.entry(canonical_limit.clone()).or_insert(canonical);
    }

    let mut windows = Vec::new();
    for (id, bucket) in buckets {
        if bucket.is_null() {
            bail!("Codex returned an invalid quota bucket.");
        }
        let id = label(&bucket["limitId"])?.unwrap_or(id);
        let canonical_match =
            canonical.is_some_and(|value| std::ptr::eq(value, bucket)) || id == canonical_limit;
        for kind in ["primary", "secondary"] {
            let window = &bucket[kind];
            let Some(used) = window["usedPercent"]
                .as_f64()
                .filter(|value| (0.0..=100.0).contains(value))
            else {
                continue;
            };
            let duration = window["windowDurationMins"].clone();
            let mut row = json!({
                "limitId":id, "limitName":bucket["limitName"], "planType":bucket["planType"],
                "reachedType":bucket["rateLimitReachedType"], "windowKind":kind,
                "usedPercent":used, "windowDurationMinutes":duration, "resetsAt":window["resetsAt"]
            });
            // The two required nullable fields are intentionally absent when
            // the native snapshot omitted them. The authoritative schema
            // rejects such a quota while catalog discovery remains available.
            if let Value::Object(fields) = &mut row {
                if window.get("windowDurationMins").is_none() {
                    fields.shift_remove("windowDurationMinutes");
                }
                if window.get("resetsAt").is_none() {
                    fields.shift_remove("resetsAt");
                }
            }
            row["rawPayload"] = row.clone();
            row["isWeeklyProjection"] =
                json!(canonical_match && duration.as_u64() == Some(7 * 24 * 60));
            windows.push(row);
        }
    }
    let account = canonical.filter(|value| {
        !coercion::truthy(value.get("limitId"))
            || label(&value["limitId"])
                .is_ok_and(|id| id.as_ref().and_then(JsString::as_str) == Some("codex"))
    });
    let credits = account
        .and_then(|v| v.get("credits"))
        .filter(|v| !v.is_null())
        .unwrap_or(&limits["codex"]["credits"]);
    checked(
        "providerQuotaSnapshotSchema",
        &json!({
            "snapshotId":id, "observedAt":observed, "workerVersion":worker_version,
            "codexVersion":codex_version, "windows":windows, "credits":credits,
            "rateLimitResetCredits":result["rateLimitResetCredits"]
        }),
    )
}

fn label(value: &Value) -> Result<Option<JsString>> {
    if value.is_null() {
        return Ok(None);
    }
    let value = value
        .as_js_string()
        .ok_or_else(|| anyhow!("Codex returned an invalid quota limit ID."))?;
    let trimmed = value.trim();
    Ok((!trimmed.is_empty()).then_some(trimmed))
}
