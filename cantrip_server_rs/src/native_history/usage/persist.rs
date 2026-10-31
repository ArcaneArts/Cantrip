use super::*;
pub(super) async fn write(
    tx: &Transaction<'_>,
    owner: &str,
    binding: &Value,
    turn: &Value,
    source: &str,
    capture: Option<&Value>,
) -> Result<()> {
    let retained = one(
        tx,
        "SELECT to_jsonb(u)::text FROM token_usage_records u WHERE owner_id=$1 AND source_key=$2",
        &[&owner, &source],
    )
    .await?;
    let (evidence, totals) = reconcile(
        retained
            .as_ref()
            .and_then(|r| r.get("native_usage"))
            .filter(|v| !v.is_null()),
        &turn["usage"],
    )?;
    let anchor = if capture.is_some() {
        optional(&binding["modelRouteId"])?.unwrap_or_default()
    } else {
        String::new()
    };
    let routes = routes(tx, owner, std::slice::from_ref(&anchor)).await?;
    let mut route = routes.first().cloned();
    if let Some(capture) = capture {
        anyhow::ensure!(
            capture["turnId"] == turn["turnId"],
            "Native usage attribution belongs to another turn."
        );
        let selection = &capture["selection"];
        route = None;
        if selection["status"] == "resolved" {
            anyhow::ensure!(
                selection["workerId"] == binding["workerId"]
                    && selection["providerAccountId"] == binding["providerAccountId"],
                "Native usage attribution belongs to another worker/account."
            );
            let selected = super::routes(tx, owner, &[text(&selection["routeId"])?]).await?;
            let selected = selected.first();
            let anchor = routes.first();
            anyhow::ensure!(
                anchor
                    .zip(selected)
                    .is_some_and(|(a, s)| s["model_id"] == selection["modelId"]
                        && s["provider_id"] == selection["providerId"]
                        && a["provider_id"] == selection["providerId"]),
                "Native usage attribution does not match an owned route in the session provider."
            );
            route = selected.cloned();
        }
    }
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
    let status = if turn["status"] == "inProgress" {
        json!("running")
    } else {
        turn["status"].clone()
    };
    let semantics = if evidence["complete"] == true {
        "native-responses-complete-v1"
    } else {
        "native-responses-partial-v1"
    };
    let total = if evidence["complete"] == true {
        totals
            .as_ref()
            .map(|t| t["totalTokens"].clone())
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let mut data = json!({"id":uuid::Uuid::new_v4().to_string(),"owner_id":owner,"project_id":binding["projectId"],"chat_id":binding["chatId"],"source_key":source,"native_model_attribution":capture.cloned().unwrap_or(Value::Null),"native_usage":evidence,"model_id":route.as_ref().map(|r|r["model_id"].clone()).unwrap_or(Value::Null),"model_route_id":route.as_ref().map(|r|r["model_route_id"].clone()).unwrap_or(Value::Null),"provider_id":route.as_ref().map(|r|r["provider_id"].clone()).unwrap_or(Value::Null),"provider_account_id":binding["providerAccountId"],"worker_id":binding["workerId"],"turn_id":turn["turnId"],"execution_attempt_id":Value::Null,"attempt_kind":"turn","attempt_status":status,"reasoning_effort":capture.map(|c|c["reasoningEffort"].clone()).unwrap_or(Value::Null),"worker_version":Value::Null,"server_version":Value::Null,"codex_version":Value::Null,"visible_output_tokens":Value::Null,"reported_total_tokens":total,"usage_semantics":semantics,"started_at":timing("startedAtMs")?,"completed_at":timing("completedAtMs")?,"finalized_at":timing("completedAtMs")?,"updated_at":crate::auth::iso(crate::auth::now())});
    for (column, key) in [
        ("input_tokens", "inputTokens"),
        ("output_tokens", "outputTokens"),
        ("cached_input_tokens", "cachedInputTokens"),
        ("reasoning_output_tokens", "reasoningOutputTokens"),
        ("cache_write_input_tokens", "cacheWriteInputTokens"),
    ] {
        data[column] = totals.as_ref().map(|t| t[key].clone()).unwrap_or(json!(0));
    }
    let columns = data
        .as_object()
        .unwrap()
        .keys()
        .map(|k| k.as_str().unwrap())
        .collect::<Vec<_>>();
    let mut updates=vec!["native_model_attribution=COALESCE(retained.native_model_attribution,excluded.native_model_attribution)".to_owned(),"native_usage=excluded.native_usage".into(),"usage_semantics=excluded.usage_semantics".into(),"reported_total_tokens=excluded.reported_total_tokens".into(),"project_id=excluded.project_id".into(),"chat_id=excluded.chat_id".into(),"updated_at=excluded.updated_at".into(),"completed_at=COALESCE(retained.completed_at,excluded.completed_at)".into(),"finalized_at=COALESCE(retained.finalized_at,excluded.finalized_at)".into(),"attempt_status=CASE WHEN retained.attempt_status<>'running' AND excluded.attempt_status='running' THEN retained.attempt_status ELSE excluded.attempt_status END".into()];
    if !data["started_at"].is_null() {
        updates.push("started_at=CASE WHEN retained.native_usage IS NOT NULL THEN COALESCE(retained.started_at,excluded.started_at) ELSE excluded.started_at END".into());
    }
    for key in [
        "model_id",
        "model_route_id",
        "provider_id",
        "provider_account_id",
        "worker_id",
        "turn_id",
        "reasoning_effort",
    ] {
        updates.push(format!("{key}=CASE WHEN retained.native_model_attribution IS NOT NULL OR(retained.native_usage IS NOT NULL AND NOT $2::boolean) THEN retained.{key} ELSE excluded.{key} END"));
    }
    if totals.is_some() {
        for key in [
            "input_tokens",
            "output_tokens",
            "cached_input_tokens",
            "reasoning_output_tokens",
            "cache_write_input_tokens",
            "visible_output_tokens",
        ] {
            updates.push(format!("{key}=excluded.{key}"));
        }
    }
    let sql = format!(
        "INSERT INTO token_usage_records AS retained({}) SELECT {} FROM jsonb_populate_record(NULL::token_usage_records,$1::jsonb) incoming ON CONFLICT(owner_id,source_key) DO UPDATE SET {} WHERE retained.native_model_attribution IS NULL OR((excluded.native_model_attribution IS NULL OR retained.native_model_attribution=excluded.native_model_attribution) AND retained.chat_id IS NOT DISTINCT FROM excluded.chat_id AND retained.turn_id IS NOT DISTINCT FROM excluded.turn_id) RETURNING id",
        columns.join(","),
        columns
            .iter()
            .map(|c| format!("incoming.{c}"))
            .collect::<Vec<_>>()
            .join(","),
        updates.join(",")
    );
    anyhow::ensure!(
        !tx.query(&sql, &[&postgres_types::Json(data), &capture.is_some()])
            .await?
            .is_empty(),
        "Native turn model attribution conflicts with the retained usage record."
    );
    Ok(())
}
