//! General GUI/native token writer. Native response evidence owns its deduped
//! subtotal; delayed GUI counters cannot replace it with one response's usage.
use super::write_support::*;
use crate::{
    database::Transaction,
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Result, ensure};

pub(super) async fn persist(tx: &Transaction<'_>, owner: &str, input: &Value) -> Result<()> {
    let source = text(&input["sourceKey"])?;
    let retained = one(
        tx,
        "SELECT to_jsonb(u)::text FROM token_usage_records u WHERE owner_id=$1 AND source_key=$2",
        &[&owner, &source],
    )
    .await?;
    let native = input
        .get("nativeUsage")
        .filter(|v| truthy(Some(v)))
        .map(|incoming| {
            crate::native_history::reconcile_usage(
                retained
                    .as_ref()
                    .and_then(|v| v.get("native_usage"))
                    .filter(|v| !v.is_null()),
                incoming,
            )
        })
        .transpose()?;
    let capture = input
        .get("nativeModelAttribution")
        .map(|v| crate::settings::parse_response("nativeTurnModelAttributionSchema", Some(v)))
        .transpose()?;
    if let Some(capture) = &capture {
        ensure!(
            capture.get("turnId") == input.get("turnId"),
            "Native usage attribution belongs to another turn."
        );
    }
    if let Some(selection) = capture
        .as_ref()
        .map(|v| &v["selection"])
        .filter(|v| v["status"] == "resolved")
    {
        ensure!(
            selection.get("workerId") == input.get("workerId")
                && selection["providerAccountId"] == nullish(input.get("providerAccountId")),
            "Native usage attribution belongs to another worker/account."
        );
    }
    let anchor = routes(tx, owner, &[text(&input["modelRouteId"])?])
        .await?
        .into_iter()
        .next();
    let route = if let Some(capture) = &capture {
        let selection = &capture["selection"];
        if selection["status"] == "resolved" {
            let selected = routes(tx, owner, &[text(&selection["routeId"])?])
                .await?
                .into_iter()
                .next();
            ensure!(
                selected
                    .as_ref()
                    .zip(anchor.as_ref())
                    .is_some_and(|(r, a)| r["modelId"] == selection["modelId"]
                        && r["providerId"] == selection["providerId"]
                        && a["providerId"] == selection["providerId"]),
                "Native usage attribution does not match an owned route in the session provider."
            );
            selected
        } else {
            None
        }
    } else {
        anchor
    };
    let usage = native
        .as_ref()
        .and_then(|(_, totals)| totals.as_ref())
        .or_else(|| {
            if truthy(retained.as_ref().and_then(|r| r.get("native_usage")))
                || truthy(input.get("nativeUsage"))
            {
                None
            } else {
                input.get("usage").filter(|v| truthy(Some(v)))
            }
        });
    let semantics = native
        .as_ref()
        .map(|(e, _)| {
            if e["complete"] == true {
                "native-responses-complete-v1"
            } else {
                "native-responses-partial-v1"
            }
        })
        .unwrap_or("provider-reported-v2");
    let reported = if native.as_ref().is_some_and(|(e, _)| e["complete"] != true) {
        Value::Null
    } else {
        usage
            .map(|v| count(v.get("totalTokens")))
            .transpose()?
            .unwrap_or(Value::Null)
    };
    let at = json!(crate::auth::iso(crate::auth::now()));
    let status = fallback(input.get("attemptStatus"), &json!("completed"));
    let finish = |key: &str| {
        input.get(key).cloned().unwrap_or_else(|| {
            if status == "running" {
                Value::Null
            } else {
                at.clone()
            }
        })
    };
    let mut data = json!({"id":uuid::Uuid::new_v4().to_string(),"owner_id":owner,"project_id":nullish(input.get("projectId")),"chat_id":nullish(input.get("chatId")),"source_key":source,"native_model_attribution":capture.clone().unwrap_or(Value::Null),"native_usage":native.as_ref().map(|(e,_)|e.clone()).unwrap_or(Value::Null),"model_id":route.as_ref().map(|r|r["modelId"].clone()).unwrap_or(Value::Null),"model_route_id":route.as_ref().map(|r|r["modelRouteId"].clone()).unwrap_or(Value::Null),"provider_id":route.as_ref().map(|r|r["providerId"].clone()).unwrap_or(Value::Null),"provider_account_id":nullish(input.get("providerAccountId")),"worker_id":nullish(input.get("workerId")),"turn_id":nullish(input.get("turnId")),"execution_attempt_id":nullish(input.get("executionAttemptId")),"attempt_kind":fallback(input.get("attemptKind"),&json!("turn")),"attempt_status":status,"reasoning_effort":capture.as_ref().map(|v|v["reasoningEffort"].clone()).unwrap_or_else(||nullish(input.get("reasoningEffort"))),"visible_output_tokens":nullable_count(usage.and_then(|v|v.get("visibleOutputTokens")))?,"reported_total_tokens":reported,"usage_semantics":semantics,"started_at":input.get("startedAt").cloned().unwrap_or_else(||at.clone()),"completed_at":finish("completedAt"),"finalized_at":finish("finalizedAt"),"updated_at":at});
    for (field, column) in [
        ("workerVersion", "worker_version"),
        ("serverVersion", "server_version"),
        ("codexVersion", "codex_version"),
    ] {
        data[column] = nullish(input.get(field));
    }
    for (field, column) in [
        ("inputTokens", "input_tokens"),
        ("outputTokens", "output_tokens"),
        ("cachedInputTokens", "cached_input_tokens"),
        ("reasoningOutputTokens", "reasoning_output_tokens"),
        ("cacheWriteInputTokens", "cache_write_input_tokens"),
    ] {
        data[column] = count(usage.and_then(|v| v.get(field)))?;
    }
    for column in [
        "project_id",
        "chat_id",
        "model_id",
        "model_route_id",
        "provider_id",
        "provider_account_id",
        "worker_id",
        "turn_id",
        "execution_attempt_id",
        "attempt_kind",
        "attempt_status",
        "reasoning_effort",
        "worker_version",
        "server_version",
        "codex_version",
    ] {
        data[column] = column_text(&data[column]);
    }
    let mut updates = vec!["native_model_attribution=COALESCE(retained.native_model_attribution,EXCLUDED.native_model_attribution)".to_owned(),"project_id=EXCLUDED.project_id".into(),"chat_id=EXCLUDED.chat_id".into(),"updated_at=EXCLUDED.updated_at".into(),"attempt_status=CASE WHEN retained.attempt_status<>'running' AND (EXCLUDED.attempt_status='running' OR(retained.native_usage IS NOT NULL AND NOT $2::boolean)) THEN retained.attempt_status ELSE EXCLUDED.attempt_status END".into()];
    if native.is_some() {
        for column in ["native_usage", "usage_semantics", "reported_total_tokens"] {
            updates.push(format!("{column}=EXCLUDED.{column}"));
        }
    }
    if input.get("startedAt").is_some_and(|v| !v.is_null()) {
        updates.push("started_at=CASE WHEN retained.native_usage IS NOT NULL THEN COALESCE(retained.started_at,EXCLUDED.started_at) ELSE EXCLUDED.started_at END".into());
    }
    for column in [
        "model_id",
        "model_route_id",
        "provider_id",
        "provider_account_id",
        "worker_id",
        "reasoning_effort",
    ] {
        updates.push(format!("{column}=CASE WHEN retained.native_model_attribution IS NOT NULL OR(retained.native_usage IS NOT NULL AND NOT $3::boolean) THEN retained.{column} ELSE EXCLUDED.{column} END"));
    }
    if input.get("turnId").is_some_and(|v| !v.is_null()) {
        updates.push("turn_id=CASE WHEN retained.native_model_attribution IS NOT NULL OR(retained.native_usage IS NOT NULL AND NOT $3::boolean) THEN retained.turn_id ELSE EXCLUDED.turn_id END".into());
    }
    for (field, column) in [
        ("executionAttemptId", "execution_attempt_id"),
        ("attemptKind", "attempt_kind"),
        ("workerVersion", "worker_version"),
        ("serverVersion", "server_version"),
        ("codexVersion", "codex_version"),
    ] {
        if input.get(field).is_some() {
            updates.push(format!("{column}=EXCLUDED.{column}"));
        }
    }
    if usage.is_some() {
        for column in [
            "input_tokens",
            "output_tokens",
            "cached_input_tokens",
            "reasoning_output_tokens",
            "cache_write_input_tokens",
            "visible_output_tokens",
            "reported_total_tokens",
            "usage_semantics",
        ] {
            updates.retain(|v| !v.starts_with(&format!("{column}=")));
            updates.push(format!("{column}=EXCLUDED.{column}"));
        }
    }
    for (field, column) in [
        ("completedAt", "completed_at"),
        ("finalizedAt", "finalized_at"),
    ] {
        if input.get(field).is_some() {
            updates.push(if truthy(input.get("nativeUsage")) {
                format!("{column}=COALESCE(retained.{column},EXCLUDED.{column})")
            } else {
                format!("{column}=EXCLUDED.{column}")
            });
        }
    }
    let columns = data
        .as_object()
        .unwrap()
        .keys()
        .map(|v| v.as_str().unwrap())
        .collect::<Vec<_>>();
    let selected = columns
        .iter()
        .map(|v| format!("incoming.{v}"))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "INSERT INTO token_usage_records AS retained({}) SELECT {selected} FROM jsonb_populate_record(NULL::token_usage_records,$1::jsonb) incoming ON CONFLICT(owner_id,source_key) DO UPDATE SET {} WHERE retained.native_model_attribution IS NULL OR((EXCLUDED.native_model_attribution IS NULL OR retained.native_model_attribution=EXCLUDED.native_model_attribution) AND retained.chat_id IS NOT DISTINCT FROM EXCLUDED.chat_id AND($2::boolean OR EXCLUDED.worker_id IS NULL OR retained.worker_id IS NOT DISTINCT FROM EXCLUDED.worker_id) AND(EXCLUDED.turn_id IS NULL OR retained.turn_id IS NOT DISTINCT FROM EXCLUDED.turn_id)) RETURNING id",
        columns.join(","),
        updates.join(",")
    );
    ensure!(
        !tx.query(
            &sql,
            &[
                &postgres_types::Json(data),
                &input.get("nativeUsage").is_some(),
                &capture.is_some()
            ]
        )
        .await?
        .is_empty(),
        "Native turn model attribution conflicts with the retained usage record."
    );
    Ok(())
}
