//! Canonical history's complete native-turn telemetry consumer. All writes use
//! the ingestion transaction; response identity, labels and timing remain fenced.
use super::*;
use crate::wire::value::json;

pub fn reconcile(previous: Option<&Value>, incoming: &Value) -> Result<(Value, Option<Value>)> {
    let collator = crate::projects::placement::collator()?;
    cantrip_protocol::history::reconcile_usage(previous, incoming, |a, b| {
        collator.compare_utf16_icu4c(a.units(), b.units())
    })
}

pub(super) async fn record(
    tx: &Transaction<'_>,
    owner: &str,
    binding: &Value,
    turn: &Value,
) -> Result<()> {
    let Some(usage) = turn.get("usage") else {
        return Ok(());
    };
    let mut capture = usage.get("modelAttribution").cloned();
    if let Some(value) = &capture {
        anyhow::ensure!(
            value["threadId"] == turn["threadId"] && value["turnId"] == turn["turnId"],
            "Native history usage attribution belongs to another turn."
        );
    }
    if let Some(value) = capture
        .as_ref()
        .filter(|c| c["selection"]["status"] == "resolved")
    {
        let s = &value["selection"];
        let routes = routes(
            tx,
            owner,
            &[
                text(&s["routeId"])?,
                optional(&binding["modelRouteId"])?.unwrap_or_default(),
            ],
        )
        .await?;
        if s["workerId"] != binding["workerId"]
            || s["providerAccountId"] != binding["providerAccountId"]
            || !routes.iter().any(|r| {
                r["model_route_id"] == s["routeId"]
                    && r["model_id"] == s["modelId"]
                    && r["provider_id"] == s["providerId"]
            })
            || !routes.iter().any(|r| {
                r["model_route_id"] == binding["modelRouteId"]
                    && r["provider_id"] == s["providerId"]
            })
        {
            capture = None;
        }
    }
    let source = format!(
        "native-turn:{}",
        Value::Array(vec![
            binding["chatId"].clone(),
            turn["threadId"].clone(),
            turn["turnId"].clone()
        ])
        .stringify()
    );
    let timing = |key: &str| -> Result<Value> {
        if turn[key].is_null() {
            return Ok(Value::Null);
        }
        let value = turn[key].as_f64().context("Native turn timing")?;
        anyhow::ensure!(
            value.is_finite() && value.abs() <= 8.64e15,
            "Invalid time value"
        );
        Ok(json!(
            crate::wire::date_iso_milliseconds(value.trunc() as i64)
                .context("Invalid time value")?
        ))
    };
    let mut input = json!({"sourceKey":source,"projectId":binding["projectId"],"chatId":binding["chatId"],"modelRouteId":if capture.is_some(){binding["modelRouteId"].as_str().unwrap_or("")}else{""},"nativeTurn":json!({"threadId":turn["threadId"],"turnId":turn["turnId"]}),"nativeUsage":usage,"workerId":binding["workerId"],"providerAccountId":binding["providerAccountId"],"turnId":turn["turnId"],"attemptStatus":if turn["status"]=="inProgress"{json!("running")}else{turn["status"].clone()},"startedAt":timing("startedAtMs")?,"completedAt":timing("completedAtMs")?,"finalizedAt":timing("completedAtMs")?});
    if let Some(capture) = capture {
        input["nativeModelAttribution"] = capture;
    }
    crate::settings::telemetry::record_usage_in_transaction(tx, owner, &input).await
}
async fn routes(tx: &Transaction<'_>, owner: &str, ids: &[String]) -> Result<Vec<Value>> {
    all(tx,"SELECT jsonb_build_object('model_id',m.id,'model_route_id',r.id,'provider_id',p.id)::text FROM model_routes r INNER JOIN model_profiles m ON m.id=r.model_id AND m.owner_id=$1 INNER JOIN model_providers p ON p.id=r.provider_id AND p.owner_id=$1 WHERE r.id=ANY($2::text[])",&[&owner,&ids]).await
}
