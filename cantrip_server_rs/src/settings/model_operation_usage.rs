use super::{parse_response, repository::SettingsRepository};
use crate::{
    auth::now,
    wire::{Value, value::json},
};
use anyhow::{Context, Result, ensure};
use serde_json::Value as Json;

const IDENTITY: [&str; 7] = [
    "operation",
    "modelId",
    "routeId",
    "providerId",
    "serverId",
    "workerId",
    "operationId",
];
const METRICS: [&str; 6] = [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "reasoningOutputTokens",
];

pub(crate) const OBSERVED_TOTAL_SQL: &str = "CASE WHEN jsonb_typeof(model_operation_usage->'receipt')='object' THEN coalesce((model_operation_usage->'receipt'->>'observedTotalTokens')::bigint,0) ELSE input_tokens+output_tokens END";
pub(crate) const OBSERVED_AT_SQL: &str = "(CASE WHEN model_operation_usage IS NOT NULL THEN coalesce(started_at,finalized_at,updated_at) ELSE started_at END)";

pub(crate) fn observed_total(row: &Value) -> f64 {
    let receipt = &row["modelOperationUsage"]["receipt"];
    if receipt.is_null() {
        row["inputTokens"].as_f64().unwrap_or(0.0) + row["outputTokens"].as_f64().unwrap_or(0.0)
    } else {
        receipt["observedTotalTokens"].as_f64().unwrap_or(0.0)
    }
}

pub(crate) fn receipt_fits(usage: &Value, identity: &Value) -> bool {
    let requests = usage["requests"].as_i64().unwrap_or(-1);
    let has_reported_tokens = ["inputTokens", "outputTokens", "totalTokens"]
        .iter()
        .any(|key| {
            usage["metrics"][*key]["reportedRequests"]
                .as_i64()
                .unwrap_or(0)
                > 0
        });
    ["operation", "modelId", "routeId", "providerId"]
        .iter()
        .all(|key| usage[*key] == identity[*key])
        && requests
            == usage["succeededRequests"].as_i64().unwrap_or(-1)
                + usage["failedRequests"].as_i64().unwrap_or(-1)
                + usage["cancelledRequests"].as_i64().unwrap_or(-1)
        && (requests == 0) == usage["startedAt"].is_null()
        && if usage["observedTotalTokens"].is_null() {
            (usage["observedTotalOverflowed"] == true) == has_reported_tokens
        } else {
            has_reported_tokens && usage["observedTotalOverflowed"] == false
        }
        && METRICS.iter().all(|name| {
            let metric = &usage["metrics"][*name];
            let reported = metric["reportedRequests"].as_i64().unwrap_or(-1);
            reported <= requests
                && if reported == 0 {
                    metric["observed"].is_null() && metric["overflowed"] == false
                } else {
                    metric["observed"].is_null() == (metric["overflowed"] == true)
                }
        })
}

pub(crate) fn coverage(rows: &[Value]) -> Value {
    let direct: Vec<_> = rows
        .iter()
        .filter(|row| matches!(row["attemptKind"].as_str(), Some("embedding" | "decision")))
        .collect();
    let mut reported = 0;
    let mut requests = 0_i64;
    let mut incomplete = 0;
    for row in &direct {
        let receipt = &row["modelOperationUsage"]["receipt"];
        if receipt.is_null() {
            incomplete += 1;
            continue;
        }
        reported += 1;
        let total = receipt["requests"].as_i64().unwrap_or(0);
        requests += total;
        let required: &[&str] = if receipt["operation"] == "embedding" {
            &["inputTokens", "totalTokens"]
        } else {
            &["inputTokens", "outputTokens", "totalTokens"]
        };
        if total > 0
            && required.iter().any(|key| {
                receipt["metrics"][*key]["observed"].is_null()
                    || receipt["metrics"][*key]["reportedRequests"].as_i64() != Some(total)
            })
        {
            incomplete += 1;
        }
    }
    json!({"attemptCount":direct.len(),"reportedAttemptCount":reported,"observedRequestCount":requests,"incompleteUsageCount":incomplete})
}

impl SettingsRepository {
    /// A final receipt is immutable; late bootstrap, replay rejection and loss of
    /// the client connection cannot clear it or create another charge identity.
    pub async fn record_model_operation_usage(&self, owner: &str, input: &Value) -> Result<()> {
        let identity = parse_response("modelOperationUsageIdentitySchema", input.get("identity"))?;
        let receipt = input
            .get("receipt")
            .filter(|value| !value.is_null())
            .map(|value| parse_response("modelOperationUsageSchema", Some(value)))
            .transpose()?;
        ensure!(
            receipt
                .as_ref()
                .is_none_or(|receipt| receipt_fits(receipt, &identity)),
            "Model operation usage belongs to another dispatch or has invalid counts."
        );
        let evidence = parse_response(
            "modelOperationUsageEvidenceSchema",
            Some(
                &json!({"identity":identity,"receipt":receipt,"transportStatus":input["transportStatus"]}),
            ),
        )?;
        let source = format!(
            "model-operation:{}",
            Value::Array(vec![
                identity["serverId"].clone(),
                identity["workerId"].clone(),
                identity["operationId"].clone()
            ])
            .stringify()
        );
        let field = |key: &str| {
            identity[key]
                .as_str()
                .map(str::to_owned)
                .context("validated usage identity")
        };
        let (model, provider, route, worker, operation, operation_id) = (
            field("modelId")?,
            field("providerId")?,
            field("routeId")?,
            field("workerId")?,
            field("operation")?,
            field("operationId")?,
        );
        let owner = owner.to_owned();
        self.database.transaction(move |tx| Box::pin(async move {
            tx.query("SELECT id FROM users WHERE id=$1 FOR KEY SHARE", &[&owner]).await?;
            let lock = Value::Array(vec!["model-operation-usage".into(),owner.clone().into(),source.clone().into()]).stringify();
            tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", &[&lock]).await?;
            let existing = tx.query("SELECT to_jsonb(t) FROM token_usage_records t WHERE owner_id=$1 AND source_key=$2", &[&owner,&source]).await?;
            if let Some(row) = existing.first() {
                let previous = Value::from_serialize(&row.get::<Json>(0)?);
                let retained = &previous["model_operation_usage"];
                ensure!(previous["chat_id"].is_null() && previous["project_id"].is_null() && !retained.is_null()
                    && IDENTITY.iter().all(|key| retained["identity"][*key] == identity[*key]), "Model operation usage identity conflicts with its retained dispatch.");
                if !retained["receipt"].is_null() || (retained["transportStatus"] != "running" && evidence["transportStatus"] == "running") { return Ok(()); }
            }
            let model_owned = !tx.query("SELECT id FROM model_profiles WHERE id=$1 AND owner_id=$2 FOR KEY SHARE", &[&model,&owner]).await?.is_empty();
            let provider_owned = !tx.query("SELECT id FROM model_providers WHERE id=$1 AND owner_id=$2 FOR KEY SHARE", &[&provider,&owner]).await?.is_empty();
            let route_owned = !tx.query("SELECT id FROM model_routes WHERE id=$1 AND model_id=$2 AND provider_id=$3 FOR KEY SHARE", &[&route,&model,&provider]).await?.is_empty();
            let receipt = evidence.get("receipt").filter(|receipt| !receipt.is_null());
            let metrics = receipt.map(|receipt| &receipt["metrics"]);
            let counter = |key: &str| metrics.and_then(|metrics| metrics[key]["observed"].as_i64()).unwrap_or(0);
            let completed = receipt.and_then(|receipt| receipt["completedAt"].as_str());
            let total = receipt.and_then(|receipt| {
                let metric = &receipt["metrics"]["totalTokens"];
                (metric["reportedRequests"] == receipt["requests"]).then(|| metric["observed"].as_i64()).flatten()
            });
            let running = evidence["transportStatus"] == "running";
            let data = serde_json::json!({
                "id":uuid::Uuid::new_v4().to_string(),"owner_id":owner,"source_key":source,
                "model_operation_usage":serde_json::from_str::<Json>(&evidence.stringify())?,
                "model_id":model_owned.then_some(model),"provider_id":provider_owned.then_some(provider),
                "model_route_id":(model_owned && provider_owned && route_owned).then_some(route),
                "worker_id":worker,"execution_attempt_id":operation_id,"attempt_kind":operation,
                "attempt_status":receipt.and_then(|receipt|receipt["status"].as_str()).unwrap_or(if running {"running"}else{"unknown"}),
                "worker_version":receipt.and_then(|receipt|receipt["workerVersion"].as_str()),
                "input_tokens":counter("inputTokens"),"output_tokens":counter("outputTokens"),
                "cached_input_tokens":counter("cachedInputTokens"),"cache_write_input_tokens":counter("cacheWriteInputTokens"),
                "reasoning_output_tokens":counter("reasoningOutputTokens"),"reported_total_tokens":total,
                "usage_semantics":if receipt.is_some(){"model-operation-observed-v1"}else{"model-operation-unknown-v1"},
                "started_at":receipt.and_then(|receipt|receipt["startedAt"].as_str()),"completed_at":completed,
                "finalized_at":if running {None}else{Some(crate::auth::iso(now()))},"updated_at":crate::auth::iso(now()),
            });
            let columns = data.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
            let selected = columns.iter().map(|key|format!("incoming.{key}")).collect::<Vec<_>>().join(",");
            let updates = columns.iter().filter(|key| !matches!(key.as_str(),"id"|"owner_id"|"source_key")).map(|key|format!("{key}=EXCLUDED.{key}")).collect::<Vec<_>>().join(",");
            tx.query(&format!("INSERT INTO token_usage_records({}) SELECT {selected} FROM jsonb_populate_record(NULL::token_usage_records,$1::jsonb) incoming ON CONFLICT(owner_id,source_key) DO UPDATE SET {updates}",columns.join(",")), &[&data]).await?;
            Ok(())
        })).await
    }
}
