//! Canonical history's complete native-turn telemetry consumer. All writes use
//! the ingestion transaction; response identity, labels and timing remain fenced.
use super::*;
use crate::wire::{coercion::truthy, value::json};

pub fn reconcile(previous: Option<&Value>, incoming: &Value) -> Result<(Value, Option<Value>)> {
    let mut responses: Vec<Value> = Vec::new();
    let mut conflicts: Vec<Value> = Vec::new();
    for evidence in previous.into_iter().chain(std::iter::once(incoming)) {
        for id in evidence["conflictingResponseIds"]
            .as_array()
            .context("Native usage conflicts")?
        {
            if !conflicts.contains(id) {
                conflicts.push(id.clone());
            }
        }
    }
    for evidence in previous.into_iter().chain(std::iter::once(incoming)) {
        for response in evidence["responses"]
            .as_array()
            .context("Native usage responses")?
        {
            if let Some(retained) = responses
                .iter()
                .find(|r| r["responseId"] == response["responseId"])
            {
                if response["usage"]
                    .as_object()
                    .context("Native usage counts")?
                    .iter()
                    .any(|(key, value)| retained["usage"].get(key.as_str().unwrap()) != Some(value))
                    && !conflicts.contains(&response["responseId"])
                {
                    conflicts.push(response["responseId"].clone());
                }
            } else {
                responses.push(response.clone());
            }
        }
    }
    let collator = crate::projects::placement::collator()?;
    responses.sort_by(|a, b| {
        collator.compare_utf16_icu4c(
            a["responseId"].as_js_string().unwrap().units(),
            b["responseId"].as_js_string().unwrap().units(),
        )
    });
    conflicts.sort_by(|a, b| {
        a.as_js_string()
            .unwrap()
            .units()
            .cmp(b.as_js_string().unwrap().units())
    });
    let complete_set = |e: Option<&Value>| {
        e.is_some_and(|e| {
            truthy(e.get("complete"))
                && responses.iter().all(|r| {
                    e["responses"].as_array().is_some_and(|rows| {
                        rows.iter().any(|row| row["responseId"] == r["responseId"])
                    })
                })
        })
    };
    let retained = previous.and_then(|p| p.get("modelAttribution"));
    let capture = incoming.get("modelAttribution");
    if let Some((a, b)) = retained.zip(capture) {
        let a = crate::settings::parse_response("nativeTurnModelAttributionSchema", Some(a))?;
        let b = crate::settings::parse_response("nativeTurnModelAttributionSchema", Some(b))?;
        anyhow::ensure!(
            a.stringify() == b.stringify(),
            "Native usage model attribution conflicts with retained evidence."
        );
    }
    let complete = conflicts.is_empty() && (complete_set(previous) || complete_set(Some(incoming)));
    let mut evidence = json!({"version":1,"responses":responses,"conflictingResponseIds":conflicts,"complete":complete});
    if let Some(capture) = retained.or(capture) {
        evidence["modelAttribution"] = capture.clone();
    }
    let mut totals = json!({"totalTokens":0,"inputTokens":0,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":0,"reasoningOutputTokens":0});
    for response in evidence["responses"].as_array().unwrap() {
        if evidence["conflictingResponseIds"]
            .as_array()
            .unwrap()
            .contains(&response["responseId"])
        {
            continue;
        }
        for key in [
            "totalTokens",
            "inputTokens",
            "cachedInputTokens",
            "cacheWriteInputTokens",
            "outputTokens",
            "reasoningOutputTokens",
        ] {
            let total = totals[key].as_f64().unwrap()
                + response["usage"][key]
                    .as_f64()
                    .context("Response usage count")?;
            if !total.is_finite() || total.fract() != 0.0 || total.abs() > 9007199254740991.0 {
                evidence["complete"] = json!(false);
                return Ok((evidence, None));
            }
            totals[key] = json!(total);
        }
    }
    Ok((evidence, Some(totals)))
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
